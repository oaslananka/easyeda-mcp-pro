import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_CONFIG = 'config/extension-size-budget.json';

const parseArgs = (argv) => {
  const options = { root: process.cwd(), config: DEFAULT_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--root' && argument !== '--config') {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }

  return options;
};

const loadBudgets = (configPath) => {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('budget configuration must be a JSON object');
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error('budget configuration must contain at least one artifact');
  }

  for (const [artifact, budget] of entries) {
    if (!artifact || !Number.isInteger(budget) || budget <= 0) {
      throw new Error(`invalid budget for ${artifact || '<empty path>'}: ${String(budget)}`);
    }
  }

  return entries;
};

try {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  const configPath = isAbsolute(options.config) ? options.config : resolve(root, options.config);
  const budgets = loadBudgets(configPath);
  const errors = [];

  for (const [artifact, budget] of budgets) {
    const artifactPath = resolve(root, artifact);
    let size;
    try {
      size = statSync(artifactPath).size;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        errors.push(`missing artifact: ${artifact}`);
        continue;
      }
      throw error;
    }

    if (size > budget) {
      errors.push(`${artifact} exceeds budget: ${size} > ${budget} bytes`);
      continue;
    }

    console.log(`OK: ${artifact} (${size} / ${budget} bytes)`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
