/**
 * Metadata consistency check for CI.
 *
 * Verifies that version numbers, package names, and commands are aligned
 * across all metadata files. Exits with code 1 on any mismatch.
 *
 * Usage: node scripts/check-metadata.mjs
 * CI:    pnpm run check:metadata
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

let errors = [];
let warnings = [];

function error(msg) {
  errors.push(msg);
  console.error(`  ERROR: ${msg}`);
}

function warn(msg) {
  warnings.push(msg);
  console.warn(`  WARN:  ${msg}`);
}

// ── 1. Load all metadata files ──────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const serverJson = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
const versionTs = fs.readFileSync(path.join(root, 'src', 'config', 'version.ts'), 'utf8');
const cliSourcePath = path.join(root, 'src', 'index.ts');
const cliSource = fs.readFileSync(cliSourcePath, 'utf8');
const cliDistPath = path.join(root, 'dist', 'index.js');
const cliDist = fs.existsSync(cliDistPath) ? fs.readFileSync(cliDistPath, 'utf8') : null;
const extJsonPath = path.join(root, 'easyeda-bridge-extension', 'extension.json');
const extJson = fs.existsSync(extJsonPath)
  ? JSON.parse(fs.readFileSync(extJsonPath, 'utf8'))
  : null;
const claudePluginJsonPath = path.join(root, '.claude-plugin', 'plugin.json');
const claudePluginJson = fs.existsSync(claudePluginJsonPath)
  ? JSON.parse(fs.readFileSync(claudePluginJsonPath, 'utf8'))
  : null;
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// ── 2. Version consistency ──────────────────────────────────────────────────

const expectedVersion = pkg.version;

console.log(`\n[check:metadata] package.json version: ${expectedVersion}`);

// server.json top-level version
if (serverJson.version !== expectedVersion) {
  error(`server.json version "${serverJson.version}" !== package.json "${expectedVersion}"`);
}

// server.json packages[0] version
const pkgEntry = serverJson.packages?.[0];
if (pkgEntry && pkgEntry.version !== expectedVersion) {
  error(
    `server.json packages[0].version "${pkgEntry.version}" !== package.json "${expectedVersion}"`,
  );
}

// src/config/version.ts
const tsMatch = versionTs.match(/SERVER_VERSION\s*=\s*'([^']+)'/);
if (!tsMatch) {
  error('Could not parse SERVER_VERSION from src/config/version.ts');
} else if (tsMatch[1] !== expectedVersion) {
  error(
    `src/config/version.ts SERVER_VERSION "${tsMatch[1]}" !== package.json "${expectedVersion}"`,
  );
}

// extension.json version (if present)
if (extJson) {
  if (extJson.version !== expectedVersion) {
    error(
      `easyeda-bridge-extension/extension.json version "${extJson.version}" !== package.json "${expectedVersion}"`,
    );
  }
}

// .claude-plugin/plugin.json version (if present)
if (claudePluginJson) {
  if (claudePluginJson.version !== expectedVersion) {
    error(
      `.claude-plugin/plugin.json version "${claudePluginJson.version}" !== package.json "${expectedVersion}"`,
    );
  }
}

// ── 3. Package name consistency ─────────────────────────────────────────────

// mcpName in package.json should match server.json name
const mcpName = pkg.mcpName;
if (mcpName && serverJson.name !== mcpName) {
  error(`server.json name "${serverJson.name}" !== package.json mcpName "${mcpName}"`);
}

// ── 4. Binary / command consistency ─────────────────────────────────────────

const binEntries = Object.entries(pkg.bin || {});
const binName = binEntries[0]?.[0] || '';
const binTarget = binEntries[0]?.[1] || '';
if (binName) {
  // Check README uses correct npx command
  const npxPattern = `npx ${binName}`;
  const readmeNpxCount = (readme.match(new RegExp(npxPattern, 'g')) || []).length;
  if (readmeNpxCount === 0) {
    warn(`README.md does not reference "npx ${binName}" — install command may be outdated`);
  }

  if (binTarget !== 'dist/index.js') {
    error(`package.json bin target "${binTarget}" should be "dist/index.js"`);
  }

  if (!cliSource.startsWith('#!/usr/bin/env node')) {
    error('src/index.ts must start with #!/usr/bin/env node so npx works on Windows');
  }

  if (cliDist !== null && !cliDist.startsWith('#!/usr/bin/env node')) {
    error('dist/index.js must start with #!/usr/bin/env node before publishing');
  }
}

// ── 5. Server.json package identifier matches npm package name ──────────────

if (pkgEntry && pkgEntry.identifier !== pkg.name) {
  error(
    `server.json packages[0].identifier "${pkgEntry.identifier}" !== package.json name "${pkg.name}"`,
  );
}

// ── 6. Description alignment (optional — warn only) ─────────────────────────

const pkgDesc = pkg.description || '';
const serverDesc = serverJson.description || '';
if (pkgDesc && serverDesc && pkgDesc !== serverDesc) {
  warn(
    `package.json and server.json descriptions differ:\n` +
      `  package.json: "${pkgDesc}"\n` +
      `  server.json:  "${serverDesc}"`,
  );
}

// ── 7. Summary ──────────────────────────────────────────────────────────────

console.log('');

if (errors.length > 0) {
  console.error(
    `[check:metadata] FAILED — ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  for (const e of errors) {
    console.error(`  • ${e}`);
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(`[check:metadata] PASSED with ${warnings.length} warning(s)`);
  for (const w of warnings) {
    console.warn(`  • ${w}`);
  }
} else {
  console.log('[check:metadata] PASSED — all metadata aligned');
}

console.log('');
