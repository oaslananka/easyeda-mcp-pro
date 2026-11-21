import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, 'dist/private-ground');
await mkdir(out, { recursive: true });
await build({
  entryPoints: [resolve(root, 'easyeda-bridge-extension/src/schematic-transaction-operations.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'NativeTxn',
  target: 'es2020',
  outfile: resolve(out, 'native-transaction.js'),
});
await build({
  entryPoints: [resolve(root, 'scripts/private-ground/worker.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: resolve(out, 'worker.cjs'),
  logLevel: 'error',
});
for (const name of [
  'native-rpc.txt',
  'archive-evidence.py',
  'launcher.py',
  'worker.py',
  'proxy.py',
]) {
  await copyFile(resolve(root, 'scripts/private-ground', name), resolve(out, name));
}
