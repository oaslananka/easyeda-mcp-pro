import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { runPrivateGroundCheck } from '../../../src/cli/private-ground.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value });
}

function start(args: string[] = []) {
  setPlatform('linux');
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  spawn.mockReturnValueOnce(child);
  const beforeInt = process.listeners('SIGINT');
  const beforeTerm = process.listeners('SIGTERM');
  const result = runPrivateGroundCheck(args);
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    const previous = signal === 'SIGINT' ? beforeInt : beforeTerm;
    const listener = process.listeners(signal).find((fn) => !previous.includes(fn));
    if (!listener) throw new Error('Expected a child signal forwarding listener');
    return listener;
  };
  return { child, result, beforeInt, beforeTerm, onSignal };
}

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  spawn.mockReset();
});

describe('private Ground CLI process boundary', () => {
  it('refuses non-Linux hosts without spawning a process', async () => {
    setPlatform('win32');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runPrivateGroundCheck([])).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith('private-ground-check requires Linux.\n');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes exact arguments without a shell or inherited credentials and cleans up handlers', async () => {
    const args = ['--project', 'file with spaces.eprj2', '--output', 'new; file.eprj2'];
    const { child, result, beforeInt, beforeTerm, onSignal } = start(args);
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/python3',
      [
        expect.stringMatching(/private-ground[/\\]launcher\.py$/),
        ...args,
        '--node',
        process.execPath,
      ],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: false,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    onSignal('SIGINT')('SIGINT');
    onSignal('SIGTERM')('SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGTERM');
    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.each([1, 130, null])('propagates a failed or interrupted child exit (%s)', async (code) => {
    const { child, result, beforeInt, beforeTerm } = start();
    child.emit('close', code);
    await expect(result).resolves.toBe(code ?? 1);
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('reports spawn failure and removes both signal handlers', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { child, result, beforeInt, beforeTerm } = start();
    child.emit('error', new Error('ENOENT'));
    await expect(result).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith('Private Ground launcher unavailable: ENOENT\n');
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });
});
