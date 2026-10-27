import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = resolve(root, 'apps/project-review.ts');
const html = await readFile(resolve(root, 'apps/project-review.html'), 'utf8');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'warning',
});
const code = result.outputFiles?.[0]?.text;
if (!code || code.toLowerCase().includes('</script'))
  throw new Error('App bundle is unsafe for inline injection');
if (!html.includes('<!-- BUNDLED_APP -->')) throw new Error('App template marker missing');
const bundle = html.replace('<!-- BUNDLED_APP -->', '<script>' + code + '</script>');
const out = resolve(root, 'dist/apps/project-review.html');
await mkdir(resolve(root, 'dist/apps'), { recursive: true });
await writeFile(out, bundle, 'utf8');
console.log('[mcp-apps] built offline read-only App HTML, ' + Buffer.byteLength(bundle) + ' bytes');
