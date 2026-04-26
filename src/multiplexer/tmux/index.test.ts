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

      if (cmd === '/usr/bin/tmux' && arg === 'resize-pane') {
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

    await delay(150);

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

      if (cmd === '/usr/bin/tmux' && arg === 'resize-pane') {
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

      if (cmd === '/usr/bin/tmux' && arg === 'resize-pane') {
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
    expect(orientations).toEqual(['h', 'v', 'h', 'h', 'v', 'v', 'v', 'v']);

    // [CUSTOM] 5~8 阶段优先右列目标顺序扩展。
    const splitTargets = splitCalls.map((call) => {
      const targetIndex = call.indexOf('-t');
      return targetIndex >= 0 ? call[targetIndex + 1] : null;
    });
    expect(splitTargets.slice(4, 8)).toEqual(['%3', '%1', '%4', '%2']);
  });

  test('supports right-even-8 with stable half-width main and even stack', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;

    // [CUSTOM] Simulate tmux stream for right-even behavior assertions.
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
    const multiplexer = new TmuxMultiplexer('right-even-8', 60, 3, 12);

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        multiplexer.spawnPane(
          `re-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    // [CUSTOM] right-even 固定硬上限 8。
    expect(successCount).toBe(8);
    expect(failedCount).toBe(1);

    await delay(250);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(8);

    const horizontalSplits = splitCalls.filter((call) => call.includes('-h'));
    const verticalSplits = splitCalls.filter((call) => call.includes('-v'));

    // [CUSTOM] 首个 pane 仅一次水平分割；其余全部纵向追加。
    expect(horizontalSplits).toHaveLength(1);
    expect(verticalSplits).toHaveLength(7);
    expect(horizontalSplits[0]).toContain('50');

    const selectLayoutCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'select-layout',
    );
    expect(selectLayoutCalls.length).toBeGreaterThan(0);
    for (const call of selectLayoutCalls) {
      // [CUSTOM] right-even reflow 应映射到 tmux main-vertical。
      expect(call).toContain('main-vertical');
    }

    const setOptionCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'set-window-option',
    );
    expect(
      setOptionCalls.some(
        (call) => call.includes('main-pane-width') && call.includes('50%'),
      ),
    ).toBe(true);
  });

  test('supports right-even-2col-4 threshold strategy: 4->5 重构一次, 5-8 继续堆叠', async () => {
    const commandLog: string[][] = [];
    let paneCounter = 0;
    const spawnedPaneIds: string[] = [];

    // [CUSTOM] Simulate tmux stream for right-even-2col behavior assertions.
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
        const paneId = `%${paneCounter}`;
        spawnedPaneIds.push(paneId);
        return createProcess(0, `${paneId}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'list-panes') {
        const rows = spawnedPaneIds.map(
          (paneId, index) => `${paneId}\t102\t${index * 10}\t50\t10`,
        );
        return createProcess(0, `${rows.join('\n')}\n`);
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'resize-pane') {
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
    const multiplexer = new TmuxMultiplexer('right-even-2col-4', 60, 3, 12);

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        multiplexer.spawnPane(
          `re2-${index + 1}`,
          `Worker ${index + 1}`,
          'http://localhost:4096',
          '/tmp/workspace',
        ),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    // [CUSTOM] right-even-2col 固定硬上限 8。
    expect(successCount).toBe(8);
    expect(failedCount).toBe(1);

    const splitCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCalls).toHaveLength(8);

    const orientations = splitCalls.map((call) =>
      call.includes('-h') ? 'h' : 'v',
    );
    expect(orientations).toEqual(['h', 'v', 'h', 'h', 'v', 'v', 'v', 'v']);

    // [CUSTOM] 首次分裂固定 1/2；第 4 个 pane 直接补齐田字。
    expect(splitCalls[0]).toContain('50');
    expect(splitCalls[3]).toContain('50');

    // [CUSTOM] 前 4 个 pane 保持田字构建顺序。
    const splitTargets = splitCalls.map((call) => {
      const targetIndex = call.indexOf('-t');
      return targetIndex >= 0 ? call[targetIndex + 1] : null;
    });
    expect(splitTargets.slice(1, 4)).toEqual(['%1', '%1', '%2']);

    // [CUSTOM] 阈值策略：仅在 4->5 时触发一次重构（select-layout 两次）。
    await delay(150);

    const selectLayoutCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'select-layout',
    );
    expect(selectLayoutCalls).toHaveLength(2);
    for (const call of selectLayoutCalls) {
      expect(call).toContain('main-vertical');
    }

    const setWindowOptionCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'set-window-option',
    );
    expect(setWindowOptionCalls).toHaveLength(1);
    expect(setWindowOptionCalls[0]).toContain('main-pane-width');
    expect(setWindowOptionCalls[0]).toContain('50%');

    const listPaneCalls = commandLog.filter(
      ([cmd, sub]) => cmd === '/usr/bin/tmux' && sub === 'list-panes',
    );
    // [CUSTOM] 构建与阈值收敛都会查询几何信息。
    expect(listPaneCalls.length).toBeGreaterThan(0);
  });

  test('uses live geometry for 3rd right-even-2col split when order is stale', async () => {
    const commandLog: string[][] = [];

    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'list-panes') {
        return createProcess(
          0,
          `${['%a\t0\t0\t50\t10', '%b\t0\t11\t50\t30', '%c\t51\t0\t50\t40'].join('\n')}\n`,
        );
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        return createProcess(0, '%new-pane\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      if (cmd === '/usr/bin/tmux' && arg === 'resize-pane') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer(
      'right-even-2col-4',
      60,
      3,
      8,
    ) as any;

    // [CUSTOM] Inject stale order: left column IDs are reversed.
    multiplexer.rightEvenTwoColPaneIds = [['%b', '%a'], []];
    multiplexer.rightEvenTwoColColumnById = new Map([
      ['%b', 0],
      ['%a', 0],
    ]);
    multiplexer.openPanelPaneCount = 2;
    multiplexer.statusHiddenByPlugin = true;

    const result = await multiplexer.spawnPane(
      're2-3',
      'Worker 3',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(result.success).toBe(true);

    const splitCall = commandLog.find(
      ([bin, sub]) => bin === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCall).toBeDefined();
    expect(splitCall).toContain('-h');
    expect(splitCall).toContain('-t');
    // [CUSTOM] Should target top-left pane (%a), not stale array head (%b).
    expect(splitCall).toContain('%a');
  });

  test('reflows right-even-2col 5+ panes by total-count average', async () => {
    const commandLog: string[][] = [];
    let listPanesCallCount = 0;

    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'list-panes') {
        listPanesCallCount += 1;

        if (listPanesCallCount === 1) {
          return createProcess(
            0,
            `${[
              '%l1\t102\t0\t50\t26',
              '%l2\t102\t27\t50\t12',
              '%l3\t102\t40\t50\t13',
              '%r1\t153\t0\t51\t26',
              '%r2\t153\t27\t51\t12',
              '%r3\t153\t40\t51\t13',
            ].join('\n')}\n`,
          );
        }

        return createProcess(
          0,
          `${[
            '%r2\t102\t0\t50\t9',
            '%l3\t102\t10\t50\t9',
            '%r1\t102\t20\t50\t9',
            '%l1\t102\t30\t50\t9',
            '%r3\t102\t40\t50\t9',
            '%l2\t102\t50\t50\t10',
          ].join('\n')}\n`,
        );
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
    const multiplexer = new TmuxMultiplexer(
      'right-even-2col-4',
      60,
      3,
      8,
    ) as any;

    multiplexer.rightEvenTwoColPaneIds = [
      ['%l1', '%l2', '%l3'],
      ['%r1', '%r2', '%r3'],
    ];
    multiplexer.rightEvenTwoColColumnById = new Map([
      ['%l1', 0],
      ['%l2', 0],
      ['%l3', 0],
      ['%r1', 1],
      ['%r2', 1],
      ['%r3', 1],
    ]);
    multiplexer.openPanelPaneCount = 6;
    multiplexer.statusHiddenByPlugin = true;

    await multiplexer.applyLayout('right-even-2col-4', 60);

    const selectLayoutCalls = commandLog.filter(
      ([bin, sub]) => bin === '/usr/bin/tmux' && sub === 'select-layout',
    );
    // [CUSTOM] 5+ 阶段重构时应切换到单列均分（main-vertical）。
    expect(selectLayoutCalls).toHaveLength(2);
    for (const call of selectLayoutCalls) {
      expect(call).toContain('main-vertical');
    }

    const setWindowOptionCalls = commandLog.filter(
      ([bin, sub]) => bin === '/usr/bin/tmux' && sub === 'set-window-option',
    );
    expect(setWindowOptionCalls).toHaveLength(1);
    expect(setWindowOptionCalls[0]).toContain('main-pane-width');
    expect(setWindowOptionCalls[0]).toContain('50%');

    const resizeCalls = commandLog.filter(
      ([bin, sub]) => bin === '/usr/bin/tmux' && sub === 'resize-pane',
    );
    expect(resizeCalls).toHaveLength(0);

    // [CUSTOM] Other tests may leave pending debounced reflow timers that also call list-panes.
    expect(listPanesCallCount).toBeGreaterThanOrEqual(2);
    expect(multiplexer.rightEvenTwoColPaneIds[0]).toEqual([
      '%r2',
      '%l3',
      '%r1',
      '%l1',
      '%r3',
      '%l2',
    ]);
    expect(multiplexer.rightEvenTwoColPaneIds[1]).toEqual([]);

    for (const paneId of multiplexer.rightEvenTwoColPaneIds[0]) {
      expect(multiplexer.rightEvenTwoColColumnById.get(paneId)).toBe(0);
    }
  });

  test('uses bottom-most left pane for 4th right-even-2col split', async () => {
    const commandLog: string[][] = [];

    crossSpawnMock.mockImplementation((command: string[]) => {
      commandLog.push(command);
      const [cmd, arg] = command;

      if (cmd === 'which' && arg === 'tmux') {
        return createProcess(0, '/usr/bin/tmux\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === '-V') {
        return createProcess(0, 'tmux 3.4\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'list-panes') {
        return createProcess(
          0,
          `${[
            '%top\t0\t0\t50\t20',
            '%bottom\t0\t21\t50\t20',
            '%right\t51\t0\t50\t20',
          ].join('\n')}\n`,
        );
      }

      if (cmd === '/usr/bin/tmux' && arg === 'split-window') {
        return createProcess(0, '%new-pane\n');
      }

      if (cmd === '/usr/bin/tmux' && arg === 'select-pane') {
        return createProcess();
      }

      throw new Error(`Unexpected command: ${command.join(' ')}`);
    });

    const { TmuxMultiplexer } = await importFreshTmux();
    const multiplexer = new TmuxMultiplexer(
      'right-even-2col-4',
      60,
      3,
      8,
    ) as any;

    // [CUSTOM] Inject stale order where index-based target would pick %top incorrectly.
    multiplexer.rightEvenTwoColPaneIds = [['%bottom', '%top'], ['%right']];
    multiplexer.rightEvenTwoColColumnById = new Map([
      ['%bottom', 0],
      ['%top', 0],
      ['%right', 1],
    ]);
    multiplexer.openPanelPaneCount = 3;
    multiplexer.statusHiddenByPlugin = true;

    const result = await multiplexer.spawnPane(
      're2-4',
      'Worker 4',
      'http://localhost:4096',
      '/tmp/workspace',
    );

    expect(result.success).toBe(true);

    const splitCall = commandLog.find(
      ([bin, sub]) => bin === '/usr/bin/tmux' && sub === 'split-window',
    );
    expect(splitCall).toBeDefined();
    expect(splitCall).toContain('-h');
    expect(splitCall).toContain('-t');
    // [CUSTOM] Should target live bottom-left pane (%bottom), not stale index order.
    expect(splitCall).toContain('%bottom');
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
          `${[
            '%tl\t0\t0\t50\t20',
            '%bl\t0\t21\t50\t20',
            '%tr\t51\t0\t50\t20',
            '%br\t51\t21\t50\t20',
          ].join('\n')}\n`,
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
          targetIndex >= 0 ? (command[targetIndex + 1] ?? '') : '';

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
