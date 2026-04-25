import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { MultiplexerSessionManager } from './session-manager';

// Define the mock multiplexer
const mockMultiplexer = {
  type: 'tmux' as const,
  isAvailable: mock(async () => true),
  isInsideSession: mock(() => true),
  spawnPane: mock(async () => ({
    success: true,
    paneId: '%mock-pane',
  })),
  closePane: mock(async () => true),
  applyLayout: mock(async () => {}),
};

// Mock the multiplexer module
mock.module('../multiplexer', () => ({
  getMultiplexer: () => mockMultiplexer,
  isServerRunning: mock(async () => true),
  startAvailabilityCheck: () => {},
}));

// Mock the plugin context
function createMockContext(overrides?: {
  sessionStatusResult?: { data?: Record<string, { type: string }> };
  directory?: string;
}) {
  const defaultPort = process.env.OPENCODE_PORT ?? '4096';
  return {
    client: {
      session: {
        status: mock(
          async () => overrides?.sessionStatusResult ?? { data: {} },
        ),
      },
    },
    directory: overrides?.directory ?? '/test/directory',
    serverUrl: new URL(`http://localhost:${defaultPort}`),
  } as any;
}

const defaultMultiplexerConfig = {
  type: 'tmux' as const,
  layout: 'main-vertical' as const,
  main_pane_size: 60,
  // [CUSTOM] Global panel cap baseline for queue tests.
  max_panel_panes: 8,
  // [CUSTOM] Default 2x3 panel capacity baseline for tests.
  panel_rows_per_column: 3,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MultiplexerSessionManager', () => {
  beforeEach(() => {
    mockMultiplexer.spawnPane.mockReset();
    mockMultiplexer.spawnPane.mockResolvedValue({
      success: true,
      paneId: '%mock-pane',
    });
    mockMultiplexer.closePane.mockReset();
    mockMultiplexer.closePane.mockResolvedValue(true);
    mockMultiplexer.isInsideSession.mockReset();
    mockMultiplexer.isInsideSession.mockReturnValue(true);
  });

  describe('constructor', () => {
    test('initializes with config', () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      expect(manager).toBeDefined();
    });
  });

  describe('onSessionCreated', () => {
    test('spawns pane for child sessions', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-123',
            parentID: 'parent-456',
            title: 'Test Worker',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalled();
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-123',
        'Test Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('ignores sessions without parentID', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'root-session',
            title: 'Main Chat',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('prefers child session directory when present', async () => {
      const ctx = createMockContext({ directory: '/parent/directory' });
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-456',
            parentID: 'parent-456',
            title: 'Nested Worker',
            directory: '/child/directory',
          },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-456',
        'Nested Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/child/directory',
      );
    });

    test('ignores if disabled in config', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(ctx, {
        ...defaultMultiplexerConfig,
        type: 'none',
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'child', parentID: 'parent' },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('does not spawn twice for duplicate create events while spawning', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const event = {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-race',
            parentID: 'parent-race',
            title: 'Race Worker',
          },
        },
      };

      const firstCreate = manager.onSessionCreated(event);
      const secondCreate = manager.onSessionCreated(event);

      await Promise.resolve();
      await Promise.resolve();

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      deferred.resolve({ success: true, paneId: 'p-race' });

      await Promise.all([firstCreate, secondCreate]);

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });

    test('queues sessions on capacity and promotes when a slot frees up', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p-1' })
        .mockResolvedValueOnce({ success: false, reason: 'capacity' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-2' });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'queue-1', parentID: 'parent-q', title: 'Worker One' },
        },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'queue-2', parentID: 'parent-q', title: 'Worker Two' },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'queue-1',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(3);
      expect(mockMultiplexer.spawnPane).toHaveBeenLastCalledWith(
        'queue-2',
        'Worker Two',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('drops queued sessions that finish before being displayed', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p-main' })
        .mockResolvedValueOnce({ success: false, reason: 'capacity' });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: { id: 'queue-done-1', parentID: 'parent-d', title: 'Main' },
        },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'queue-done-2',
            parentID: 'parent-d',
            title: 'Queued But Done',
          },
        },
      });

      // Queued session completes before it ever gets a pane.
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'queue-done-2',
          status: { type: 'idle' },
        },
      });

      // Free one slot; finished queued session should not be respawned.
      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'queue-done-1',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-main');
    });
  });

  describe('polling and closure', () => {
    test('closes pane when session becomes idle', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane.mockResolvedValue({
        success: true,
        paneId: 'p-1',
      });

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      // Register session
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      });

      // Mock status
      ctx.client.session.status.mockResolvedValue({
        data: { c1: { type: 'idle' } },
      });

      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
    });

    test('does not close on transient status absence', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 'c1', parentID: 'p1' } },
      });

      ctx.client.session.status.mockResolvedValue({ data: {} });
      await (manager as any).pollSessions();

      expect(mockMultiplexer.closePane).not.toHaveBeenCalled();
    });

    test('respawns pane on busy for known prior session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-1',
        })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-2',
        });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-789',
            parentID: 'parent-789',
            title: 'Worker',
            directory: '/task/dir',
          },
        },
      });

      ctx.client.session.status.mockResolvedValue({
        data: { 'child-789': { type: 'idle' } },
      });
      await (manager as any).pollSessions();

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-789',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledWith(
        'child-789',
        'Worker',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/task/dir',
      );
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
    });

    test('rebalances right-binary panes after one session completes', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(ctx, {
        ...defaultMultiplexerConfig,
        layout: 'right-binary-8',
      });

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p-1' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-2' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-3' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-2r' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-3r' });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-1',
            parentID: 'parent-rb',
            title: 'Worker One',
          },
        },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-2',
            parentID: 'parent-rb',
            title: 'Worker Two',
          },
        },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-3',
            parentID: 'parent-rb',
            title: 'Worker Three',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'rb-1',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-2');
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-3');

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(5);
      expect(mockMultiplexer.spawnPane).toHaveBeenNthCalledWith(
        4,
        'rb-2',
        'Worker Two',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
      expect(mockMultiplexer.spawnPane).toHaveBeenNthCalledWith(
        5,
        'rb-3',
        'Worker Three',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'rb-2',
          status: { type: 'idle' },
        },
      });

      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-2r');
    });

    test('deduplicates concurrent close requests for same session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(ctx, {
        ...defaultMultiplexerConfig,
        layout: 'right-binary-8',
      });
      const closeGate = createDeferred<boolean>();

      mockMultiplexer.spawnPane.mockResolvedValueOnce({
        success: true,
        paneId: 'p-dup',
      });

      mockMultiplexer.closePane.mockImplementation(async () => {
        await closeGate.promise;
        return true;
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'dup-close',
            parentID: 'parent-dup-close',
            title: 'Dup Worker',
          },
        },
      });

      const closeFromIdle = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'dup-close',
          status: { type: 'idle' },
        },
      });

      const closeFromDeleted = manager.onSessionDeleted({
        type: 'session.deleted',
        properties: {
          sessionID: 'dup-close',
        },
      });

      await Promise.resolve();

      // [CUSTOM] 两条关闭路径并发时，只允许一次 closePane 进入执行。
      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);

      closeGate.resolve(true);
      await Promise.all([closeFromIdle, closeFromDeleted]);

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(1);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p-dup');
    });

    test('waits for right-binary rebalance before spawning new session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(ctx, {
        ...defaultMultiplexerConfig,
        layout: 'right-binary-8',
      });
      const rebalanceCloseGate = createDeferred<boolean>();
      const rebalanceCloseStarted = createDeferred<void>();

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p-1' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-2' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-3' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-2r' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-3r' })
        .mockResolvedValueOnce({ success: true, paneId: 'p-4' });

      mockMultiplexer.closePane.mockImplementation(async (paneId: string) => {
        if (paneId === 'p-2') {
          rebalanceCloseStarted.resolve();
          await rebalanceCloseGate.promise;
        }
        return true;
      });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-1',
            parentID: 'parent-rb',
            title: 'Worker One',
          },
        },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-2',
            parentID: 'parent-rb',
            title: 'Worker Two',
          },
        },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-3',
            parentID: 'parent-rb',
            title: 'Worker Three',
          },
        },
      });

      const closeIdlePromise = manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'rb-1',
          status: { type: 'idle' },
        },
      });

      // [CUSTOM] Pause midway through rebalance, after closing the first survivor.
      await rebalanceCloseStarted.promise;

      const createDuringRebalancePromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'rb-4',
            parentID: 'parent-rb',
            title: 'Worker Four',
          },
        },
      });

      // [CUSTOM] New session should wait, not spawn while rebalance is in flight.
      await Promise.resolve();
      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(3);

      rebalanceCloseGate.resolve(true);

      await Promise.all([closeIdlePromise, createDuringRebalancePromise]);

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(6);
      expect(mockMultiplexer.spawnPane).toHaveBeenNthCalledWith(
        4,
        'rb-2',
        'Worker Two',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
      expect(mockMultiplexer.spawnPane).toHaveBeenNthCalledWith(
        5,
        'rb-3',
        'Worker Three',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
      expect(mockMultiplexer.spawnPane).toHaveBeenNthCalledWith(
        6,
        'rb-4',
        'Worker Four',
        `http://localhost:${process.env.OPENCODE_PORT ?? '4096'}/`,
        '/test/directory',
      );
    });

    test('does nothing on busy for unknown session', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'unknown-session',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).not.toHaveBeenCalled();
    });

    test('re-checks tracked sessions after async respawn guard', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p-1' })
        .mockResolvedValueOnce({
          success: true,
          paneId: 'p-should-not-happen',
        });

      await manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-999',
            parentID: 'parent-999',
            title: 'Worker',
            directory: '/task/dir',
          },
        },
      });

      ctx.client.session.status.mockResolvedValue({
        data: { 'child-999': { type: 'idle' } },
      });
      await (manager as any).pollSessions();

      const respawnPromise = (manager as any).respawnIfKnown('child-999');

      (manager as any).sessions.set('child-999', {
        sessionId: 'child-999',
        paneId: 'p-existing',
        parentId: 'parent-999',
        title: 'Worker',
        directory: '/task/dir',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      });

      await respawnPromise;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
      expect((manager as any).sessions.get('child-999')?.paneId).toBe(
        'p-existing',
      );
    });

    test('does not respawn while initial pane spawn is still in progress', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );
      const deferred = createDeferred<{ success: true; paneId: string }>();

      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);

      const createPromise = manager.onSessionCreated({
        type: 'session.created',
        properties: {
          info: {
            id: 'child-busy-race',
            parentID: 'parent-busy-race',
            title: 'Busy Worker',
            directory: '/task/dir',
          },
        },
      });

      await manager.onSessionStatus({
        type: 'session.status',
        properties: {
          sessionID: 'child-busy-race',
          status: { type: 'busy' },
        },
      });

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);

      deferred.resolve({ success: true, paneId: 'p-busy-race' });

      await createPromise;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup', () => {
    test('closes all tracked panes concurrently', async () => {
      const ctx = createMockContext();
      mockMultiplexer.spawnPane
        .mockResolvedValueOnce({ success: true, paneId: 'p1' })
        .mockResolvedValueOnce({ success: true, paneId: 'p2' });

      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 's1', parentID: 'p1' } },
      });
      await manager.onSessionCreated({
        type: 'session.created',
        properties: { info: { id: 's2', parentID: 'p2' } },
      });

      await manager.cleanup();

      expect(mockMultiplexer.closePane).toHaveBeenCalledTimes(2);
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p1');
      expect(mockMultiplexer.closePane).toHaveBeenCalledWith('p2');
    });

    test('clears spawning sessions during cleanup', async () => {
      const ctx = createMockContext();
      const manager = new MultiplexerSessionManager(
        ctx,
        defaultMultiplexerConfig,
      );

      const deferred = createDeferred<{ success: true; paneId: string }>();
      mockMultiplexer.spawnPane.mockImplementationOnce(() => deferred.promise);
      const event = {
        type: 'session.created',
        properties: {
          info: {
            id: 'cleanup-spawn',
            parentID: 'parent-cleanup',
            title: 'Cleanup Worker',
          },
        },
      };

      const createPromise = manager.onSessionCreated(event);

      await Promise.resolve();

      await manager.cleanup();

      await manager.onSessionCreated(event);

      deferred.resolve({ success: true, paneId: 'p-cleanup' });
      await createPromise;

      expect(mockMultiplexer.spawnPane).toHaveBeenCalledTimes(2);
    });
  });
});

// Backward compatibility test
describe('TmuxSessionManager (backward compatibility)', () => {
  test('TmuxSessionManager is alias for MultiplexerSessionManager', async () => {
    const { TmuxSessionManager } = await import('./session-manager');
    expect(TmuxSessionManager).toBe(MultiplexerSessionManager);
  });
});
