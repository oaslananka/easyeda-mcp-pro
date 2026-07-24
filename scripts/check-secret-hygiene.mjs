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

function listTrackedFiles(repoRoot) {
  const output = execFileSync(resolveGitExecutable(), ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => resolve(repoRoot, path));
}

function walkFiles(path, files) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    files.add(path);
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    walkFiles(resolve(path, entry.name), files);
  }
}

function collectFiles(repoRoot) {
  const files = new Set(listTrackedFiles(repoRoot));
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

  return [...files].sort((left, right) => left.localeCompare(right));
}

export function scanRepository(repoRoot = defaultRepoRoot) {
  const findings = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;

  for (const absolutePath of collectFiles(repoRoot)) {
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

  return { findings, scannedFiles, skippedLargeFiles };
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
    `Secret hygiene check passed: ${result.scannedFiles} files scanned; ${result.skippedLargeFiles} oversized files skipped.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
