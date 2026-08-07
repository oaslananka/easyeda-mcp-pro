#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/validate-ci-reports.mjs --coverage <lcov> --junit <xml>`,
  );
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--coverage' && option !== '--junit') {
      usageError(`Unknown argument: ${option ?? ''}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) usageError(`Missing value for ${option}`);
    values[option.slice(2)] = value;
    index += 1;
  }
  if (!values.coverage) usageError('Missing --coverage path');
  if (!values.junit) usageError('Missing --junit path');
  return values;
}

function readRequiredReport(path, label) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) throw new Error('empty');
    const content = readFileSync(path, 'utf8');
    if (content.trim().length === 0) throw new Error('empty');
    return content;
  } catch {
    throw new Error(`${label} report is missing or empty: ${path}`);
  }
}

function validateCoverage(path) {
  const coverage = readRequiredReport(path, 'coverage');
  const hasSource = /^SF:.+/m.test(coverage);
  const hasData = /^DA:\d+,\d+(?:,.*)?$/m.test(coverage);
  const hasRecordEnd = /^end_of_record$/m.test(coverage);
  if (!hasSource || !hasData || !hasRecordEnd) {
    throw new Error(`coverage report is malformed: ${path}`);
  }
}

function validateJunit(path) {
  const junit = readRequiredReport(path, 'JUnit');
  const hasSuite = /<testsuites?\b/i.test(junit);
  const hasTestcase = /<testcase\b/i.test(junit);
  if (!hasSuite || !hasTestcase) {
    throw new Error(`JUnit report is malformed: ${path}`);
  }
}

try {
  const { coverage, junit } = parseArgs(process.argv.slice(2));
  validateCoverage(coverage);
  validateJunit(junit);
  console.log(`CI reports validated: coverage=${coverage}; junit=${junit}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
