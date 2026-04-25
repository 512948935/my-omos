import { beforeEach, describe, expect, mock, test } from 'bun:test';

const logMock = mock(() => {});

function createProcess(exitCode = 0, stdout = '', stderr = '') {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(stdout),
    stderr: () => Promise.resolve(stderr),
    kill: mock(() => true),
    exitCode,
    proc: {} as never,
  };
}

function createFindBinaryMock(command: string[]) {
  const [cmd, arg] = command;

  if (cmd === 'which' && arg === 'tmux') {
    return createProcess(0, '/opt/shims/tmux\n');
  }

  if (cmd === '/opt/shims/tmux' && arg === '-V') {
    return createProcess(1, '', 'shim passthrough unavailable');
  }

  if (cmd === 'tmux' && arg === '-V') {
    return createProcess(0, 'tmux 3.4\n');
  }

  throw new Error(`Unexpected command: ${command.join(' ')}`);
}

const crossSpawnMock = mock(createFindBinaryMock);

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
  isBun: false,
}));

async function importFreshTmux() {
  return import(`./index?test=${Date.now()}-${Math.random()}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TmuxMultiplexer.findBinary', () => {
  beforeEach(() => {
    crossSpawnMock.mockClear();
    logMock.mockClear();
    crossSpawnMock.mockImplementation(createFindBinaryMock);
  });

  test('falls back to PATH resolution when a shim path cannot verify directly', async () => {
    const { TmuxMultiplexer } = await importFreshTmux();

    const multiplexer = new TmuxMultiplexer();
    const available = await multiplexer.isAvailable();

    expect(available).toBe(true);
    expect(crossSpawnMock.mock.calls.map(([args]) => args)).toEqual([
      ['which', 'tmux'],
      ['/opt/shims/tmux', '-V'],
      ['tmux', '-V'],
    ]);
  });

  test('coalesces reflow after bursty pane spawns', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate tmux command stream for layout coordination tests.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60);

    const [first, second] = await Promise.all([
      multiplexer.spawnPane(
        's-1',
        'Worker One',
        'http://localhost:4096',
        '/tmp/workspace',
      ),
      multiplexer.spawnPane(
        's-2',
        'Worker Two',
        'http://localhost:4096',
        '/tmp/workspace',
      ),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    // [CUSTOM] Debounced reflow happens asynchronously after spawn resolves.
    await delay(250);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(2);

    const selectLayoutCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'select-layout',
    );
    const setOptionCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'set-window-option',
    );

    // [CUSTOM] Single coalesced reflow for two spawn events.
    expect(selectLayoutCalls).toHaveLength(2);
    expect(setOptionCalls).toHaveLength(1);
  });

  test('uses latest layout when reflow requests overlap', async () => {
    const commandLog: string[][] = [];

    // [CUSTOM] Simulate tmux command stream for layout coordination tests.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60);

    await Promise.all([
      multiplexer.applyLayout('tiled', 60),
      multiplexer.applyLayout('main-horizontal', 50),
    ]);

    const selectLayoutCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'select-layout',
    );
    const setOptionCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'set-window-option',
    );

    // [CUSTOM] Only the latest requested layout should be applied.
    expect(selectLayoutCalls).toHaveLength(2);
    for (const call of selectLayoutCalls) {
      expect(call).toContain('main-horizontal');
    }

    expect(setOptionCalls).toHaveLength(1);
    expect(setOptionCalls[0]).toContain('main-pane-height');
    expect(setOptionCalls[0]).toContain('50%');
  });

  test('enforces per-column floor (rows<2 clamps to 2, total=4)', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate status toggle + pane lifecycle command stream.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60, 1);

    const first = await multiplexer.spawnPane(
      's-1',
      'Worker One',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const second = await multiplexer.spawnPane(
      's-2',
      'Worker Two',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const third = await multiplexer.spawnPane(
      's-3',
      'Worker Three',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const fourth = await multiplexer.spawnPane(
      's-4',
      'Worker Four',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const fifth = await multiplexer.spawnPane(
      's-5',
      'Worker Five',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(third.success).toBe(true);
    expect(fourth.success).toBe(true);
    expect(fifth.success).toBe(false);

    await delay(250);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(4);

    // [CUSTOM] Column-1 first pane uses 33%; column-2 first pane uses 50%
    // from the ~67% main pane, yielding ~1/3 each when both columns exist.
    const horizontalSplits = splitCalls.filter((call) => call.includes('-h'));
    expect(horizontalSplits).toHaveLength(2);
    expect(horizontalSplits[0]).toContain('33');
    expect(horizontalSplits[1]).toContain('50');
  });

  test('caps panel count at default max_panel_panes=8', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate status toggle + pane lifecycle command stream.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60, 6);

    const results = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        multiplexer.spawnPane(
          `s-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    expect(successCount).toBe(8);
    expect(failedCount).toBe(3);

    await delay(250);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(8);
  });

  test('respects explicit max_panel_panes override', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate command stream for explicit max cap behavior.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60, 5, 3);

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        multiplexer.spawnPane(
          `mx-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    expect(successCount).toBe(3);
    expect(failedCount).toBe(1);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(3);
  });

  test('supports right-binary-8 layout with 1→2→4→8 split progression', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate tmux command stream for right-binary layout.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'send-keys') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'kill-pane') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('right-binary-8', 60, 3);

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        multiplexer.spawnPane(
          `s-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    expect(successCount).toBe(8);
    expect(failedCount).toBe(1);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(8);

    // [CUSTOM] Sequence should be h, v, h, h, then v x4.
    const orientations = splitCalls.map((call) =>
      call.includes('-h') ? 'h' : 'v',
    );
    expect(orientations).toEqual(['h', 'v', 'h', 'h', 'v', 'v', 'v', 'v']);

    // [CUSTOM] Post-田字 vertical expansion prioritizes right column first.
    const splitTargets = splitCalls.map((call) => {
      const targetIndex = call.indexOf('-t');
      return targetIndex >= 0 ? call[targetIndex + 1] : null;
    });
    expect(splitTargets.slice(4, 8)).toEqual(['%3', '%1', '%4', '%2']);

    // First split is strict 1/2 left-right.
    expect(splitCalls[0]).toContain('-p');
    expect(splitCalls[0]).toContain('50');
  });

  test('caps right-binary-8 at 8 even when max_panel_panes is larger', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate tmux command stream for hard 8-pane cap behavior.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('right-binary-8', 60, 3, 12);

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        multiplexer.spawnPane(
          `rb-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    expect(successCount).toBe(8);
    expect(failedCount).toBe(1);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(8);

    const orientations = splitCalls.map((call) =>
      call.includes('-h') ? 'h' : 'v',
    );
    expect(orientations).toEqual([
      'h',
      'v',
      'h',
      'h',
      'v',
      'v',
      'v',
      'v',
    ]);

    // [CUSTOM] 5~8 阶段优先右列目标顺序扩展。
    const splitTargets = splitCalls.map((call) => {
      const targetIndex = call.indexOf('-t');
      return targetIndex >= 0 ? call[targetIndex + 1] : null;
    });
    expect(splitTargets.slice(4, 8)).toEqual([
      '%3',
      '%1',
      '%4',
      '%2',
    ]);
  });

  test('uses live geometry when right-binary tracked order is stale', async () => {
    const commandLog: string[][] = [];

    // [CUSTOM] Simulate geometry lookup + split for stale-order recovery.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        return createProcess(0, '%new-pane\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'list-panes') {
        return createProcess(
          0,
          [
            '%tl\t0\t0\t50\t20',
            '%bl\t0\t21\t50\t20',
            '%tr\t51\t0\t50\t20',
            '%br\t51\t21\t50\t20',
          ].join('\n') + '\n',
        );
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('right-binary-8', 60, 3, 8) as any;

    // [CUSTOM] Inject stale order: [TR, BR, TL, BL].
    multiplexer.binaryPaneIds = ['%tr', '%br', '%tl', '%bl'];
    multiplexer.openPanelPaneCount = 4;
    multiplexer.statusHiddenByPlugin = true;

    const result = await multiplexer.spawnPane(
      'rb-5',
      'Worker 5',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(result.success).toBe(true);

    const splitCall = commandLog.find(
      ([bin, sub]) => bin === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCall).toBeDefined();
    expect(splitCall).toContain('-v');
    expect(splitCall).toContain('-t');
    // [CUSTOM] count=4 时应优先切分 TR，而不是受 stale 顺序影响。
    expect(splitCall).toContain('%tr');
  });

  test('does not over-decrement right-binary after duplicate close', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;
    const killedPaneIds = new Set<string>();

    // [CUSTOM] Simulate duplicate close where second kill-pane fails.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'send-keys') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'kill-pane') {
        const targetIndex = command.indexOf('-t');
        const targetPane =
          targetIndex >= 0 ? command[targetIndex + 1] ?? '' : '';

        if (!killedPaneIds.has(targetPane)) {
          killedPaneIds.add(targetPane);
          return createProcess();
        }

        return createProcess(1, '', 'pane not found');
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('right-binary-8', 60, 3, 8);

    const initialSpawns = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        multiplexer.spawnPane(
          `rb-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const firstPaneId = initialSpawns[0]?.paneId;
    expect(firstPaneId).toBe('%1');

    const firstClose = await multiplexer.closePane(firstPaneId as string);
    const secondClose = await multiplexer.closePane(firstPaneId as string);

    expect(firstClose).toBe(true);
    expect(secondClose).toBe(false);

    const fifth = await multiplexer.spawnPane(
      'rb-5',
      'Worker 5',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const sixth = await multiplexer.spawnPane(
      'rb-6',
      'Worker 6',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(fifth.success).toBe(true);
    expect(sixth.success).toBe(true);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    const orientations = splitCalls.map((call) =>
      call.includes('-h') ? 'h' : 'v',
    );

    // [CUSTOM] duplicate close 不应让计数少减；后续应为先补 2x2 再进入纵向扩展。
    expect(orientations.slice(4, 6)).toEqual(['h', 'v']);
  });

  test('hides status bar on first panel and restores after last close', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate status toggle + pane lifecycle command stream.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'send-keys') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'kill-pane') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60, 2);

    const first = await multiplexer.spawnPane(
      's-1',
      'Worker One',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const second = await multiplexer.spawnPane(
      's-2',
      'Worker Two',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    await multiplexer.closePane(first.paneId as string);
    await multiplexer.closePane(second.paneId as string);

    const showOptionCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'show-options',
    );
    const setOptionCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'set-option',
    );

    expect(showOptionCalls).toHaveLength(1);
    expect(setOptionCalls.some((call) => call.includes('off'))).toBe(true);
    expect(setOptionCalls.some((call) => call.includes('on'))).toBe(true);
  });

  test('retries status hide on later spawn if initial hide failed', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;
    let hideAttempts = 0;

    // [CUSTOM] Simulate a transient first hide failure then recovery.
    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'show-options') {
        return createProcess(0, 'on\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-option') {
        if (command.includes('off')) {
          hideAttempts += 1;
          if (hideAttempts === 1) {
            return createProcess(1, '', 'transient set-option failure');
          }
        }
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        paneCounter += 1;
        return createProcess(0, `%${paneCounter}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-layout') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'set-window-option') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer('main-vertical', 60, 3);

    const first = await multiplexer.spawnPane(
      's-1',
      'Worker One',
      'http://localhost:4096',
      '/tmp/workspace',
    );
    const second = await multiplexer.spawnPane(
      's-2',
      'Worker Two',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const hideSetCalls = commandLog.filter(
      ([cmd, sub, ...rest]) =>
        cmd === '/usr/bin/tmux' && sub === 'set-option' && rest.includes('off'),
    );

    // [CUSTOM] The second spawn should retry hide after initial failure.
    expect(hideSetCalls).toHaveLength(2);
  });
});
