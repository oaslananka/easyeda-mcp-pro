import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const tool = resolve('scripts/private-ground/launcher.py');
const available =
  process.platform === 'linux' && spawnSync('/usr/bin/python3', ['--version']).status === 0;
function run(args: string[]) {
  return spawnSync('/usr/bin/python3', [tool, ...args], { encoding: 'utf8', timeout: 10000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!available)('private Ground CLI', () => {
  it('explains explicit consent without opening an editor', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--confirm-write');
    expect(result.stdout).toContain('--allow-library-network');
    expect(result.stdout).toContain('isolated');
  });

  it('requires both mutation and vendor-network consent before checking input paths', () => {
    const args = [
      '--project',
      'missing.eprj2',
      '--output',
      'new.eprj2',
      '--editor',
      'missing',
      '--activation',
      'missing',
      '--node',
      process.execPath,
    ];
    for (const flag of ['--confirm-write', '--allow-library-network']) {
      const result = run([...args, flag]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Both --confirm-write and --allow-library-network are required',
      );
      expect(result.stdout).toBe('');
    }
  });

  it('publishes atomically without replacing an existing output', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-ground-test-'));
    roots.push(root);
    const source = join(root, 'source.eprj2'),
      target = join(root, 'target.eprj2');
    writeFileSync(source, 'verified content');
    const code =
      'import importlib.util,sys,pathlib; s=importlib.util.spec_from_file_location("launcher",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.publish(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))';
    const publish = () =>
      spawnSync('/usr/bin/python3', ['-B', '-c', code, tool, source, target], { encoding: 'utf8' });
    expect(publish().status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('verified content');
    writeFileSync(source, 'different content');
    expect(publish().status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('verified content');
  });
});
