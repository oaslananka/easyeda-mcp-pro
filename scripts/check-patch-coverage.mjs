import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MINIMUM_PERCENT = 78; // Codecov target 80%, two percentage-point tolerance.
const EXCLUDED = new Set(['src/index.ts', 'src/live/ngspice-smoke.ts']);

function normalizedSource(source, prefix = '') {
  let value = source.replaceAll('\\', '/').replace(/^\.\//, '');
  if (prefix && value.startsWith(prefix + '/')) return value;
  if (value.startsWith('src/')) return prefix ? prefix + '/' + value : value;
  const marker = value.lastIndexOf('/src/');
  if (marker >= 0) {
    value = value.slice(marker + 1);
    return prefix ? prefix + '/' + value : value;
  }
  // The server LCOV also contains coverage for repository maintenance scripts.
  // Only executable source under src/ is relevant to the patch gate.
  return null;
}

export function parseLcov(content, prefix = '') {
  const coverage = new Map();
  let file = null;
  let inRecord = false;
  let count = 0;
  for (const raw of content.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      inRecord = true;
      file = normalizedSource(raw.slice(3), prefix);
      if (file && !coverage.has(file)) coverage.set(file, new Map());
    } else if (raw.startsWith('DA:')) {
      if (!inRecord) throw new Error('Coverage data without a source record');
      if (!file) continue;
      const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(raw);
      if (!match) throw new Error('Malformed LCOV line: ' + raw);
      const line = Number(match[1]);
      const hits = Number(match[2]);
      if (line < 1 || !Number.isSafeInteger(hits)) throw new Error('Invalid LCOV line data');
      const lines = coverage.get(file);
      lines.set(line, Math.max(lines.get(line) ?? 0, hits));
      count += 1;
    } else if (raw === 'end_of_record') {
      file = null;
      inRecord = false;
    }
  }
  if (count === 0) throw new Error('Coverage contains no executable line records');
  return coverage;
}

function trackedSource(path) {
  if (!path || path.includes('\\') || path.startsWith('/') || path.includes('../')) {
    throw new Error('Unexpected source path in diff: ' + path);
  }
  return (
    (path.startsWith('src/') || path.startsWith('easyeda-bridge-extension/src/')) &&
    path.endsWith('.ts') &&
    !path.endsWith('.d.ts') &&
    !EXCLUDED.has(path)
  );
}

function parseChangedFileHeader(header, added) {
  if (header === '+++ /dev/null') return null;
  if (!header.startsWith('+++ b/')) {
    throw new Error('Cannot parse changed source filename: ' + header);
  }
  const path = header.slice('+++ b/'.length);
  if (!trackedSource(path)) return null;
  if (!added.has(path)) added.set(path, new Set());
  return path;
}

function parseHunkLineNumber(header) {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) throw new Error('Cannot parse diff hunk: ' + header);
  return Number(match[1]);
}

export function parseAddedLines(diff) {
  const added = new Map();
  let file = null;
  let lineNumber = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null;
      lineNumber = null;
      continue;
    }
    // A real added source line can start with ++ and look like a +++ diff header.
    // Only interpret file headers before the first hunk.
    if (lineNumber !== null && line.startsWith('+')) {
      if (file) added.get(file).add(lineNumber);
      lineNumber += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      file = parseChangedFileHeader(line, added);
      continue;
    }
    if (line.startsWith('@@ ')) {
      lineNumber = parseHunkLineNumber(line);
      continue;
    }
    if (lineNumber === null) continue;
    if (line.startsWith(' ')) lineNumber += 1;
  }
  return added;
}

export function evaluatePatch(diff, serverLcov, extensionLcov) {
  const source = parseAddedLines(diff);
  if (source.size === 0) return { covered: 0, total: 0, percent: 100, files: 0 };
  const server = parseLcov(serverLcov);
  const extension = parseLcov(extensionLcov, 'easyeda-bridge-extension');
  let covered = 0;
  let total = 0;
  for (const [file, changed] of source) {
    const fromExtension = file.startsWith('easyeda-bridge-extension/');
    const lines = (fromExtension ? extension : server).get(file);
    if (!lines) throw new Error('Changed source is missing from the coverage report: ' + file);
    for (const number of changed) {
      if (!lines.has(number)) continue; // Non-executable lines such as types and comments.
      total += 1;
      if (lines.get(number) > 0) covered += 1;
    }
  }
  const percent = total === 0 ? 100 : (covered * 100) / total;
  if (total > 0 && covered * 100 < MINIMUM_PERCENT * total) {
    throw new Error(
      'Changed-line coverage ' +
        covered +
        '/' +
        total +
        ' (' +
        percent.toFixed(2) +
        '%) is below ' +
        MINIMUM_PERCENT +
        '%',
    );
  }
  return { covered, total, percent, files: source.size };
}

function run(argv) {
  const option = argv[0];
  const base = argv[1];
  if (option !== '--base' || !/^[0-9a-f]{40}$/.test(base ?? '') || argv.length !== 2) {
    throw new Error('Usage: node scripts/check-patch-coverage.mjs --base <40-char PR base SHA>');
  }
  execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD']);
  const diff = execFileSync(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-renames',
      '--no-ext-diff',
      '--no-color',
      '--unified=0',
      base,
      'HEAD',
      '--',
      'src/',
      'easyeda-bridge-extension/src/',
    ],
    { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 },
  );
  const result = evaluatePatch(
    diff,
    readFileSync('coverage/lcov.info', 'utf8'),
    readFileSync('easyeda-bridge-extension/coverage/lcov.info', 'utf8'),
  );
  console.log(
    'Local changed-line coverage: ' +
      result.covered +
      '/' +
      result.total +
      ' (' +
      result.percent.toFixed(2) +
      '%) over ' +
      result.files +
      ' source files (minimum ' +
      MINIMUM_PERCENT +
      '%).',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(
      'Local changed-line coverage failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}
