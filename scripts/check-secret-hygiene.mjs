import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const rules = [
  {
    ruleId: 'pem-private-key',
    description: 'PEM private-key boundary',
    regex: /-----BEGIN(?: RSA| EC| OPENSSH| DSA)? PRIVATE KEY-----/g,
  },
  {
    ruleId: 'credential-bearing-uri',
    description: 'Connection URI containing embedded credentials',
    regex:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
  },
];

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.codePointAt(index) === 10) line += 1;
  }
  return line;
}

export function scanText(text, source = '<memory>') {
  const findings = [];

  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      findings.push({
        ruleId: rule.ruleId,
        description: rule.description,
        source,
        line: lineForOffset(text, match.index ?? 0),
      });
    }
  }

  return findings;
}

export function resolveGitExecutable(platform = process.platform) {
  let candidates;
  if (platform === 'win32') {
    candidates = [
      String.raw`C:\Program Files\Git\cmd\git.exe`,
      String.raw`C:\Program Files\Git\bin\git.exe`,
    ];
  } else if (platform === 'darwin') {
    candidates = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  } else {
    candidates = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
  }
  const executable = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (!executable) {
    throw new Error(`Git executable was not found in the fixed allowlist for ${platform}.`);
  }
  return executable;
}

const SNAPSHOT_EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.pnpm-store',
  '.vite',
  '.vite-temp',
  'coverage',
  'node_modules',
  'reports',
]);
const SNAPSHOT_EXCLUDED_PATHS = new Set([
  '.easyeda-mcp-pro',
  'docs/.vitepress/cache',
  'docs/.vitepress/dist',
]);

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

function comparePaths(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function listTrackedFiles(repoRoot) {
  const gitMarker = resolve(repoRoot, '.git');
  if (!existsSync(gitMarker)) return undefined;

  let output;
  try {
    output = execFileSync(resolveGitExecutable(), ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error('Unable to enumerate tracked files from the Git checkout.', { cause: error });
  }

  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => resolve(repoRoot, path));
}

function shouldSkipSnapshotDirectory(repoRoot, absolutePath) {
  const relativePath = normalizePath(relative(repoRoot, absolutePath));
  const name = absolutePath.split(/[\\/]/).at(-1);
  return SNAPSHOT_EXCLUDED_DIRECTORY_NAMES.has(name) || SNAPSHOT_EXCLUDED_PATHS.has(relativePath);
}

function walkFiles(path, files, options = {}) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    files.add(path);
    return;
  }
  if (!stat.isDirectory()) return;
  if (options.repoRoot && shouldSkipSnapshotDirectory(options.repoRoot, path)) return;

  const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    comparePaths(left.name, right.name),
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    walkFiles(resolve(path, entry.name), files, options);
  }
}

function collectFiles(repoRoot) {
  const trackedFiles = listTrackedFiles(repoRoot);
  const files = new Set();
  const fileSource = trackedFiles ? 'git-checkout' : 'filesystem-snapshot';

  if (trackedFiles) {
    for (const path of trackedFiles) files.add(path);
  } else {
    walkFiles(repoRoot, files, { repoRoot });
  }

  const generatedCandidates = [
    'dist',
    'easyeda-bridge-extension/dist',
    'easyeda-bridge-extension.eext',
    'easyeda-bridge-extension/easyeda-bridge-extension.eext',
    'artifacts',
  ];

  for (const candidate of generatedCandidates) {
    walkFiles(resolve(repoRoot, candidate), files);
  }

  return {
    files: [...files].sort(comparePaths),
    fileSource,
  };
}

export function scanRepository(repoRoot = defaultRepoRoot) {
  const findings = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;

  const collection = collectFiles(repoRoot);
  for (const absolutePath of collection.files) {
    if (!existsSync(absolutePath)) continue;
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      skippedLargeFiles += 1;
      continue;
    }

    const source = relative(repoRoot, absolutePath).replaceAll('\\', '/');
    const text = readFileSync(absolutePath).toString('utf8');
    scannedFiles += 1;
    findings.push(...scanText(text, source));
  }

  return { findings, scannedFiles, skippedLargeFiles, fileSource: collection.fileSource };
}

function runCli() {
  const result = scanRepository(defaultRepoRoot);

  if (result.findings.length > 0) {
    console.error(`Secret hygiene check failed with ${result.findings.length} finding(s):`);
    for (const finding of result.findings) {
      console.error(
        `- ${finding.source}:${finding.line} [${finding.ruleId}] ${finding.description}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Secret hygiene check passed: ${result.scannedFiles} files scanned from ${result.fileSource}; ${result.skippedLargeFiles} oversized files skipped.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
