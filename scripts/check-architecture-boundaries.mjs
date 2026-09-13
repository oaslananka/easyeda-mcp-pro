#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const DEFAULT_POLICY = '.github/architecture-boundaries.json';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

const normalizePath = (path) => path.split(sep).join('/');

const parseArguments = (argv) => {
  const options = { root: process.cwd(), policy: DEFAULT_POLICY };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--root' && argument !== '--policy') {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`${argument} requires a path`);
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
    throw new TypeError('each architecture boundary rule requires a name');
  }
  if (!isNonEmptyStringArray(rule.from) || !isNonEmptyStringArray(rule.disallow)) {
    throw new TypeError(
      'each architecture boundary rule requires non-empty from and disallow arrays',
    );
  }
};

const readPolicy = (root, policyPath) => {
  const absolutePath = resolve(root, policyPath);
  const policy = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (policy?.schemaVersion !== 1 || typeof policy?.sourceRoot !== 'string') {
    throw new TypeError(
      'architecture boundary policy must use schemaVersion 1 and define sourceRoot',
    );
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new TypeError('architecture boundary policy must define at least one rule');
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

const moduleSpecifiers = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const specifiers = [];
  const visit = (node) => {
    const declaration = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
    if (declaration && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
};

const targetAreaForSpecifier = (sourceRoot, file, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const targetRelative = relative(sourceRoot, resolve(dirname(file), specifier));
  if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) return null;
  return targetRelative.split(sep)[0];
};

const inspectFile = (root, sourceRoot, file, rules) => {
  const sourceRelative = relative(sourceRoot, file);
  const sourceArea = sourceRelative.split(sep)[0];
  const applicableRules = rules.filter((rule) => rule.from.includes(sourceArea));
  if (applicableRules.length === 0) return { checked: false, violations: [] };

  const targets = moduleSpecifiers(file, readFileSync(file, 'utf8'))
    .map((specifier) => targetAreaForSpecifier(sourceRoot, file, specifier))
    .filter(Boolean);
  const violations = [];
  for (const targetArea of targets) {
    for (const rule of applicableRules) {
      if (rule.disallow.includes(targetArea)) {
        violations.push({
          file: normalizePath(relative(root, file)),
          sourceArea,
          targetArea,
          rule: rule.name,
        });
      }
    }
  }
  return { checked: true, violations };
};

const findViolations = (root, policy) => {
  const sourceRoot = resolve(root, policy.sourceRoot);
  const results = sourceFiles(sourceRoot).map((file) =>
    inspectFile(root, sourceRoot, file, policy.rules),
  );
  return {
    checkedFiles: results.filter((result) => result.checked).length,
    violations: results.flatMap((result) => result.violations),
  };
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
