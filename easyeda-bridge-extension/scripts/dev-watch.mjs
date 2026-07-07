// Dev watch loop: rebuild both bundles AND repackage the .eext on every source
// change, so dist/dispatcher.js is always current for hot-swap pushes and the
// .eext stays importable for the (rare) loader change. Debounced because a
// save can touch multiple files.
import { watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcDir = join(root, 'src');

let running = false;
let pending = false;
let timer = null;

function runBuild() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  const startedAt = Date.now();
  const env = { ...process.env, MCP_DEV_HOTSWAP: process.env.MCP_DEV_HOTSWAP ?? 'true' };
  // process.execPath: absolute path to the running node binary — never resolved
  // through PATH.
  execFile(
    process.execPath,
    [join(__dirname, 'build.mjs')],
    { cwd: root, env },
    (buildErr, stdout, stderr) => {
      if (buildErr) {
        console.error(`[dev-watch] build failed:\n${stderr || stdout || buildErr.message}`);
        finish();
        return;
      }
      process.stdout.write(stdout);
      execFile(
        process.execPath,
        [join(__dirname, 'package.mjs')],
        { cwd: root },
        (pkgErr, pkgOut, pkgStderr) => {
          if (pkgErr) {
            console.error(`[dev-watch] package failed:\n${pkgStderr || pkgOut || pkgErr.message}`);
          } else {
            console.log(`[dev-watch] rebuilt + repackaged in ${Date.now() - startedAt}ms`);
          }
          finish();
        },
      );
    },
  );
}

function finish() {
  running = false;
  if (pending) {
    pending = false;
    runBuild();
  }
}

function scheduleBuild(reason) {
  console.log(`[dev-watch] change detected: ${reason}`);
  if (timer) clearTimeout(timer);
  timer = setTimeout(runBuild, 200);
}

watch(srcDir, { recursive: true }, (_event, filename) => {
  scheduleBuild(filename ?? 'unknown');
});

console.log(`[dev-watch] watching ${srcDir}`);
runBuild();
