import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Explicit CLI-only acceptance workflow, never an opt-in from MCP request data. */
export function runPrivateGroundCheck(args: string[]): Promise<number> {
  if (process.platform !== 'linux') {
    process.stderr.write('private-ground-check requires Linux.\n');
    return Promise.resolve(1);
  }
  const launcher = fileURLToPath(new URL('../private-ground/launcher.py', import.meta.url));
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/python3', [launcher, ...args, '--node', process.execPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    const forward = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.once('error', (error) => {
      cleanup();
      process.stderr.write('Private Ground launcher unavailable: ' + error.message + '\n');
      resolve(1);
    });
    child.once('close', (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}
