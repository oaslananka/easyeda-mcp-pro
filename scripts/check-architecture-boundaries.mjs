#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const DEFAULT_POLICY = '.github/architecture-boundaries.json';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const normalizePath = (path) => path.split(sep).join('/');

const parseArguments = (argv) => {
  const options = { root: process.cwd(), policy: DEFAULT_POLICY };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--root' && argument !== '--policy') {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
    if (argument === '--root') options.root = resolve(value);
    else options.policy = value;
    index += 1;
  }
  return options;
};

const isNonEmptyStringArray = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string');

const validateRule = (rule) => {
  if (typeof rule?.name !== 'string') {
    throw new Error('each architecture boundary rule requires a name');
  }
  if (!isNonEmptyStringArray(rule.from) || !isNonEmptyStringArray(rule.disallow)) {
    throw new Error('each architecture boundary rule requires non-empty from and disallow arrays');
  }
};

const readPolicy = (root, policyPath) => {
  const absolutePath = resolve(root, policyPath);
  const policy = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (policy?.schemaVersion !== 1 || typeof policy?.sourceRoot !== 'string') {
    throw new Error('architecture boundary policy must use schemaVersion 1 and define sourceRoot');
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error('architecture boundary policy must define at least one rule');
  }
  for (const rule of policy.rules) validateRule(rule);
  return policy;
};

const sourceFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(path);
  }
  return files;
};

const findViolations = (root, policy) => {
  const sourceRoot = resolve(root, policy.sourceRoot);
  const violations = [];
  let checkedFiles = 0;
  for (const file of sourceFiles(sourceRoot)) {
    const sourceRelative = relative(sourceRoot, file);
    const sourceArea = sourceRelative.split(sep)[0];
    const rules = policy.rules.filter((rule) => rule.from.includes(sourceArea));
    if (rules.length === 0) continue;
    checkedFiles += 1;
    const text = readFileSync(file, 'utf8');
    IMPORT_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier?.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      const targetRelative = relative(sourceRoot, target);
      if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) continue;
      const targetArea = targetRelative.split(sep)[0];
      for (const rule of rules) {
        if (!rule.disallow.includes(targetArea)) continue;
        violations.push({
          file: normalizePath(relative(root, file)),
          sourceArea,
          targetArea,
          rule: rule.name,
        });
      }
    }
  }
  return { checkedFiles, violations };
};

try {
  const options = parseArguments(process.argv.slice(2));
  const policy = readPolicy(options.root, options.policy);
  const { checkedFiles, violations } = findViolations(options.root, policy);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `Architecture boundary violation: ${violation.file}: ${violation.sourceArea} may not depend on ${violation.targetArea} (${violation.rule})`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Architecture boundaries passed (${checkedFiles} protected source files checked; ${policy.rules.length} rule group${policy.rules.length === 1 ? '' : 's'}).`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
