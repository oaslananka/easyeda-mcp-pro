import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.pnpm-store',
  '.vitepress',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'reports',
]);
const RUNNERS = new Set([
  'bash',
  'node',
  'node.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'python',
  'python3',
  'sh',
  'tsx',
  'tsx.cmd',
]);
const NODE_INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--loader', '--import']);
const TSX_VALUE_FLAGS = new Set(['--tsconfig']);
const PYTHON_INLINE_FLAGS = new Set(['-c', '-m']);

function normalizePath(path) {
  return path.split(sep).join('/');
}

function comparePaths(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

export function tokenizePackageScript(command) {
  const tokens = [];
  let current = '';
  let quote;
  let escaped = false;

  const flush = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"') {
        escaped = true;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (/\s/.test(character) || ['&', '|', ';'].includes(character)) {
      flush();
      continue;
    }
    current += character;
  }

  if (quote) throw new TypeError('package script contains an unterminated quote');
  if (escaped) current += '\\';
  flush();
  return tokens;
}

function isSourceControlledLocalTarget(target) {
  const normalized = target.replaceAll('\\', '/');
  return (
    normalized.startsWith('scripts/') ||
    normalized.startsWith('./scripts/') ||
    normalized.startsWith('src/') ||
    normalized.startsWith('./src/') ||
    normalized.startsWith('../')
  );
}

function findPowerShellTarget(tokens, runnerIndex) {
  for (let index = runnerIndex + 1; index < tokens.length - 1; index += 1) {
    if (tokens[index]?.toLowerCase() === '-file') return tokens[index + 1];
  }
  return undefined;
}

function findRunnerTarget(tokens, runnerIndex) {
  const runner = tokens[runnerIndex].toLowerCase();
  if (runner.startsWith('power') || runner.startsWith('pwsh')) {
    return findPowerShellTarget(tokens, runnerIndex);
  }

  let index = runnerIndex + 1;
  if (runner === 'node' || runner === 'node.exe') {
    if (NODE_INLINE_FLAGS.has(tokens[index])) return undefined;
    while (index < tokens.length) {
      const token = tokens[index];
      if (NODE_VALUE_FLAGS.has(token)) {
        index += 2;
        continue;
      }
      if (token?.startsWith('-')) {
        index += 1;
        continue;
      }
      return token;
    }
    return undefined;
  }

  if (runner === 'python' || runner === 'python3') {
    if (PYTHON_INLINE_FLAGS.has(tokens[index])) return undefined;
    while (tokens[index]?.startsWith('-')) index += 1;
    return tokens[index];
  }

  if (runner === 'tsx' || runner === 'tsx.cmd') {
    while (index < tokens.length) {
      const token = tokens[index];
      if (TSX_VALUE_FLAGS.has(token)) {
        index += 2;
        continue;
      }
      if (token === 'watch' || token?.startsWith('-')) {
        index += 1;
        continue;
      }
      return token;
    }
    return undefined;
  }

  while (tokens[index]?.startsWith('-')) index += 1;
  return tokens[index];
}

export function collectLocalScriptTargets(scripts, { packageName }) {
  const targets = [];
  for (const [scriptName, command] of Object.entries(scripts ?? {})) {
    if (typeof command !== 'string') continue;
    const tokens = tokenizePackageScript(command);
    for (let index = 0; index < tokens.length; index += 1) {
      const runner = tokens[index]?.toLowerCase();
      if (!RUNNERS.has(runner)) continue;
      const target = findRunnerTarget(tokens, index);
      if (!target || !isSourceControlledLocalTarget(target)) continue;
      targets.push({ packageName, scriptName, target });
    }
  }
  return targets;
}

async function walkForPackageManifests(directory, results) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkForPackageManifests(absolute, results);
    } else if (entry.isFile() && entry.name === 'package.json') {
      results.push(absolute);
    }
  }
}

export async function discoverPackageManifests({ root = repoRoot } = {}) {
  const resolvedRoot = resolve(root);
  const results = [];
  await walkForPackageManifests(resolvedRoot, results);
  return results.sort(comparePaths);
}

function isOutsideRepository(root, targetPath) {
  const repositoryRelative = relative(root, targetPath);
  return (
    repositoryRelative === '..' ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  );
}

export async function verifyRepositoryPackageScriptTargets({ root = repoRoot } = {}) {
  const resolvedRoot = resolve(root);
  const manifests = await discoverPackageManifests({ root: resolvedRoot });
  const errors = [];
  let checkedTargets = 0;

  for (const manifestPath of manifests) {
    const packageJson = JSON.parse(await readFile(manifestPath, 'utf8'));
    const packageRoot = dirname(manifestPath);
    const packageName =
      typeof packageJson.name === 'string' && packageJson.name.length > 0
        ? packageJson.name
        : normalizePath(relative(resolvedRoot, packageRoot)) || '<root>';
    const targets = collectLocalScriptTargets(packageJson.scripts, { packageName });
    checkedTargets += targets.length;

    for (const target of targets) {
      const absoluteTarget = resolve(packageRoot, target.target);
      if (isOutsideRepository(resolvedRoot, absoluteTarget)) {
        errors.push(
          `${target.packageName} script "${target.scriptName}" references a local target outside the repository: ${target.target}`,
        );
        continue;
      }

      const displayPath = normalizePath(relative(resolvedRoot, absoluteTarget));
      if (!existsSync(absoluteTarget)) {
        errors.push(
          `${target.packageName} script "${target.scriptName}" references missing local target: ${displayPath}`,
        );
        continue;
      }
      const information = await stat(absoluteTarget);
      if (!information.isFile()) {
        errors.push(
          `${target.packageName} script "${target.scriptName}" references a non-file local target: ${displayPath}`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedPackages: manifests.length,
    checkedTargets,
    errors,
  };
}
