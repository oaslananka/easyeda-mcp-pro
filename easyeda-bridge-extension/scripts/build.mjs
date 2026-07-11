// Builds both extension artifacts:
//   dist/index.js       — loader + baked dispatcher (the .eext entry, as before)
//   dist/dispatcher.js  — dispatcher-only IIFE for dev hot-swap pushes
// The dispatcher build id is content-addressed: the bundle is built with a
// placeholder, hashed, and the placeholder is replaced with the hash so the
// same source always yields the same id (in both artifacts).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
// Overridable so tests can build into a scratch directory instead of the
// real dist/ (which the dev-watch loop and a running EasyEDA session may
// depend on concurrently).
const distDir = process.env.MCP_BUILD_OUT_DIR
  ? join(process.env.MCP_BUILD_OUT_DIR)
  : join(root, 'dist');

const BUILD_ID_PLACEHOLDER = '__MCP_DISPATCHER_BUILD_ID_PLACEHOLDER__';

// Hot-swap support is compiled in only for dev builds (MCP_DEV_HOTSWAP=true).
// Marketplace builds keep the eval-swap path as dead code.
const devHotSwap = process.env.MCP_DEV_HOTSWAP === 'true';

const commonOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  define: {
    __MCP_DISPATCHER_BUILD_ID__: JSON.stringify(BUILD_ID_PLACEHOLDER),
    __MCP_DEV_HOTSWAP__: JSON.stringify(devHotSwap),
  },
};

mkdirSync(distDir, { recursive: true });

await build({
  ...commonOptions,
  entryPoints: [join(root, 'src', 'dispatcher-entry.ts')],
  outfile: join(distDir, 'dispatcher.js'),
});

// Content-addressed build id: hash the placeholder-built bundle, then stamp it.
const dispatcherPath = join(distDir, 'dispatcher.js');
const placeholderBundle = readFileSync(dispatcherPath, 'utf8');
// Interleave letters so the id can never look like a phone number to the
// marketplace content check in verify-dist.mjs (which flags 7+ digit runs).
const hash = createHash('sha256').update(placeholderBundle).digest('hex').slice(0, 12);
const buildId = `d${hash.slice(0, 4)}x${hash.slice(4, 8)}x${hash.slice(8, 12)}`;
const stampedBundle = placeholderBundle.replaceAll(BUILD_ID_PLACEHOLDER, buildId);
writeFileSync(dispatcherPath, stampedBundle);

await build({
  ...commonOptions,
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(distDir, 'index.js'),
  // EasyEDA's extension loader resolves exported lifecycle/menu functions
  // from this exact IIFE global (the official pro-api-sdk uses the same name).
  globalName: 'edaEsbuildExportName',
  // Merge onto commonOptions.define rather than replacing it — an object
  // literal here would silently drop __MCP_DEV_HOTSWAP__ and always compile
  // hot-swap support out, regardless of MCP_DEV_HOTSWAP.
  define: {
    ...commonOptions.define,
    __MCP_DISPATCHER_BUILD_ID__: JSON.stringify(buildId),
  },
});

const meta = {
  buildId,
  sha256: createHash('sha256').update(stampedBundle).digest('hex'),
  byteLength: Buffer.byteLength(stampedBundle, 'utf8'),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(distDir, 'dispatcher.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

console.log(`dispatcher build ${buildId} (${meta.byteLength} bytes)`);
console.log(`built dist/index.js and dist/dispatcher.js (hot-swap: ${devHotSwap ? 'on' : 'off'})`);
