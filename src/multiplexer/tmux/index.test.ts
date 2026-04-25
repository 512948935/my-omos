import { describe, expect, mock, test } from 'bun:test';

const logMock = mock(() => {});

const crossSpawnMock = mock((command: string[]) => {
  const [cmd, arg] = command;

  if (cmd === 'which' && arg === 'tmux') {
    return {
      exited: Promise.resolve(0),
      stdout: () => Promise.resolve('/opt/shims/tmux\n'),
      stderr: () => Promise.resolve(''),
      kill: mock(() => true),
      exitCode: 0,
      proc: {} as never,
    };
  }

  if (cmd === '/opt/shims/tmux' && arg === '-V') {
    return {
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve('shim passthrough unavailable'),
      kill: mock(() => true),
      exitCode: 1,
      proc: {} as never,
    };
  }

  if (cmd === 'tmux' && arg === '-V') {
    return {
      exited: Promise.resolve(0),
      stdout: () => Promise.resolve('tmux 3.4\n'),
      stderr: () => Promise.resolve(''),
      kill: mock(() => true),
      exitCode: 0,
      proc: {} as never,
    };
  }

  throw new Error(`Unexpected command: ${command.join(' ')}`);
});

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

describe('TmuxMultiplexer.findBinary', () => {
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
});
