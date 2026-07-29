import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

export const COMPLEXITY_BASELINE_SCHEMA_VERSION = 1;
export const COMPLEXITY_METRIC = 'eslint-complexity-classic';
export const DEFAULT_COMPLEXITY_THRESHOLD = 15;
export const DEFAULT_COMPLEXITY_BASELINE = 'config/complexity-baseline.json';
export const DEFAULT_COMPLEXITY_TARGETS = [
  'src/**/*.ts',
  'easyeda-bridge-extension/src/**/*.ts',
  'scripts/**/*.js',
  'scripts/**/*.mjs',
  'scripts/**/*.cjs',
  'scripts/**/*.ts',
  'scripts/**/*.mts',
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

function assertDescendingComplexities(file, values) {
  let previous = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`complexity baseline for ${file} must contain positive integers`);
    }
    if (value > previous) {
      throw new Error(`complexity baseline for ${file} must be sorted in descending order`);
    }
    previous = value;
  }
}

export function validateComplexityBaseline(value) {
  if (!isRecord(value)) throw new Error('complexity baseline must be a JSON object');
  if (value.schemaVersion !== COMPLEXITY_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported complexity baseline schemaVersion: ${String(value.schemaVersion)}`,
    );
  }
  if (value.metric !== COMPLEXITY_METRIC) {
    throw new Error(`unsupported complexity metric: ${String(value.metric)}`);
  }
  if (!Number.isInteger(value.threshold) || value.threshold < 1) {
    throw new Error('complexity baseline threshold must be a positive integer');
  }
  if (
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    value.targets.some((target) => typeof target !== 'string' || target.length === 0)
  ) {
    throw new Error('complexity baseline targets must be a non-empty string array');
  }
  if (!isRecord(value.files)) {
    throw new Error('complexity baseline files must be a JSON object');
  }

  for (const [file, complexities] of Object.entries(value.files)) {
    if (!file || !Array.isArray(complexities) || complexities.length === 0) {
      throw new Error(`complexity baseline entry for ${file || '<empty path>'} must be non-empty`);
    }
    assertDescendingComplexities(file, complexities);
    if (complexities.some((complexity) => complexity <= value.threshold)) {
      throw new Error(
        `complexity baseline for ${file} must contain only values above threshold ${value.threshold}`,
      );
    }
  }

  return value;
}

export function buildComplexitySnapshot(measurements, { threshold, targets }) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error('complexity threshold must be a positive integer');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('complexity targets must be a non-empty array');
  }

  const grouped = new Map();
  for (const measurement of measurements) {
    if (
      !isRecord(measurement) ||
      typeof measurement.file !== 'string' ||
      !Number.isInteger(measurement.complexity) ||
      measurement.complexity < 1
    ) {
      throw new Error('invalid complexity measurement');
    }
    if (measurement.complexity <= threshold) continue;
    const values = grouped.get(measurement.file) ?? [];
    values.push(measurement.complexity);
    grouped.set(measurement.file, values);
  }

  const files = {};
  for (const file of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    files[file] = grouped.get(file).toSorted((left, right) => right - left);
  }

  return {
    schemaVersion: COMPLEXITY_BASELINE_SCHEMA_VERSION,
    metric: COMPLEXITY_METRIC,
    threshold,
    targets: [...targets],
    files,
  };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRegression(baseline, current) {
  if (current.length > baseline.length) return true;
  return current.some((value, index) => value > (baseline[index] ?? Number.NEGATIVE_INFINITY));
}

export function compareComplexitySnapshots(baselineValue, currentValue) {
  const baseline = validateComplexityBaseline(baselineValue);
  const current = validateComplexityBaseline(currentValue);

  if (baseline.threshold !== current.threshold) {
    throw new Error(
      `complexity threshold mismatch: baseline ${baseline.threshold}, current ${current.threshold}`,
    );
  }
  if (!arraysEqual(baseline.targets, current.targets)) {
    throw new Error('complexity target list differs from the committed baseline');
  }

  const regressions = [];
  const improvements = [];
  const files = [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])].sort(
    (left, right) => left.localeCompare(right),
  );

  for (const file of files) {
    const baselineComplexities = baseline.files[file] ?? [];
    const currentComplexities = current.files[file] ?? [];
    if (arraysEqual(baselineComplexities, currentComplexities)) continue;

    const difference = {
      file,
      baseline: baselineComplexities,
      current: currentComplexities,
    };
    if (isRegression(baselineComplexities, currentComplexities)) regressions.push(difference);
    else improvements.push(difference);
  }

  return { regressions, improvements };
}

function parseComplexityMessage(message) {
  const match = message.match(/complexity of (\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export async function measureRepositoryComplexity({ root, targets }) {
  const eslint = new ESLint({
    cwd: root,
    errorOnUnmatchedPattern: false,
    overrideConfig: {
      rules: {
        complexity: ['error', { max: 0, variant: 'classic' }],
      },
    },
  });
  const results = await eslint.lintFiles(targets);
  const measurements = [];

  for (const result of results) {
    const file = normalizePath(root, result.filePath);
    for (const message of result.messages) {
      if (message.ruleId !== 'complexity') continue;
      const complexity = parseComplexityMessage(message.message);
      if (!complexity) {
        throw new Error(`unable to parse ESLint complexity result for ${file}:${message.line}`);
      }
      measurements.push({ file, complexity });
    }
  }

  return measurements;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    baseline: DEFAULT_COMPLEXITY_BASELINE,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') {
      options.write = true;
      continue;
    }
    if (argument !== '--root' && argument !== '--baseline') {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }

  return options;
}

function formatVector(values) {
  return values.length === 0 ? '<none>' : values.join(', ');
}

function printDifferences(title, differences) {
  console.error(title);
  for (const difference of differences) {
    console.error(
      `  - ${difference.file}: baseline [${formatVector(difference.baseline)}], ` +
        `current [${formatVector(difference.current)}]`,
    );
  }
}

function snapshotSummary(snapshot) {
  const complexities = Object.values(snapshot.files).flat();
  return {
    files: Object.keys(snapshot.files).length,
    hotspots: complexities.length,
    maximum: complexities.length === 0 ? snapshot.threshold : Math.max(...complexities),
  };
}

export async function runComplexityRatchet(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const root = resolve(options.root);
    const baselinePath = isAbsolute(options.baseline)
      ? options.baseline
      : resolve(root, options.baseline);
    const measurements = await measureRepositoryComplexity({
      root,
      targets: DEFAULT_COMPLEXITY_TARGETS,
    });
    const current = buildComplexitySnapshot(measurements, {
      threshold: DEFAULT_COMPLEXITY_THRESHOLD,
      targets: DEFAULT_COMPLEXITY_TARGETS,
    });

    if (options.write) {
      await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      const summary = snapshotSummary(current);
      console.log(
        `[complexity] baseline updated: ${summary.hotspots} hotspot(s) across ` +
          `${summary.files} file(s), maximum ${summary.maximum}`,
      );
      return 0;
    }

    const baseline = validateComplexityBaseline(JSON.parse(await readFile(baselinePath, 'utf8')));
    const comparison = compareComplexitySnapshots(baseline, current);

    if (comparison.regressions.length > 0) {
      printDifferences('[complexity] regression(s) detected:', comparison.regressions);
      console.error(
        `[complexity] refactor the regression or deliberately review and run ` +
          '`pnpm complexity:update` only when the new measured state is acceptable.',
      );
      return 1;
    }
    if (comparison.improvements.length > 0) {
      printDifferences('[complexity] baseline can be tightened:', comparison.improvements);
      console.error('[complexity] run `pnpm complexity:update` and commit the reduced baseline.');
      return 1;
    }

    const summary = snapshotSummary(current);
    console.log(
      `[complexity] PASSED — ${summary.hotspots} hotspot(s) above ${current.threshold} ` +
        `across ${summary.files} file(s), maximum ${summary.maximum}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runComplexityRatchet();
}
