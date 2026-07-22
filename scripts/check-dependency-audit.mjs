#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_ALLOWLIST = '.github/dependency-audit-allowlist.json';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const parseArguments = (argv) => {
  const options = {
    auditJsonPath: undefined,
    allowlistPath: DEFAULT_ALLOWLIST,
    reportJsonPath: undefined,
    summaryFilePath: undefined,
  };
  const optionNames = new Map([
    ['--audit-json', 'auditJsonPath'],
    ['--allowlist', 'allowlistPath'],
    ['--report-json', 'reportJsonPath'],
    ['--summary-file', 'summaryFilePath'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    const optionName = optionNames.get(argument);
    if (!optionName) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a file path`);
    }
    options[optionName] = value;
    index += 1;
  }

  return options;
};

const parseJsonFile = (path, description) => {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${description} at ${path}: ${error.message}`);
  }
};

const runPnpmAudit = () => {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Unable to run pnpm audit: ${result.error.message}`);
  }
  if (!result.stdout.trim()) {
    throw new Error(
      `pnpm audit produced no JSON output (exit ${result.status ?? 'unknown'}): ${result.stderr.trim()}`,
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `pnpm audit failed before producing a usable result (exit ${result.status}): ${result.stderr.trim()}`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pnpm audit returned invalid JSON: ${error.message}`);
  }
};

const requireNonEmptyString = (value, field, advisory) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Dependency audit exception ${advisory} requires a non-empty ${field}`);
  }
};

const validateDate = (value, field, advisory) => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error(`Dependency audit exception ${advisory} requires ${field} as YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Dependency audit exception ${advisory} has invalid ${field}: ${value}`);
  }
};

const validateAllowlist = (allowlist) => {
  if (allowlist?.schemaVersion !== 1 || !Array.isArray(allowlist?.exceptions)) {
    throw new Error('Dependency audit allowlist must use schemaVersion 1 and an exceptions array');
  }

  const seen = new Set();
  for (const exception of allowlist.exceptions) {
    const advisory = exception?.advisory ?? '<unknown>';
    if (typeof advisory !== 'string' || !GHSA_PATTERN.test(advisory)) {
      throw new Error(`Invalid dependency audit advisory identifier: ${advisory}`);
    }
    requireNonEmptyString(exception.package, 'package', advisory);
    if (!Array.isArray(exception.versions) || exception.versions.length === 0) {
      throw new Error(`Dependency audit exception ${advisory} requires explicit versions`);
    }
    for (const version of exception.versions) {
      requireNonEmptyString(version, 'version', advisory);
    }
    requireNonEmptyString(exception.severity, 'severity', advisory);
    requireNonEmptyString(exception.owner, 'owner', advisory);
    requireNonEmptyString(exception.reason, 'reason', advisory);
    requireNonEmptyString(exception.reachability, 'reachability', advisory);
    if (!Number.isInteger(exception.trackingIssue) || exception.trackingIssue <= 0) {
      throw new Error(`Dependency audit exception ${advisory} requires a positive trackingIssue`);
    }
    validateDate(exception.reviewBy, 'reviewBy', advisory);
    validateDate(exception.expiresOn, 'expiresOn', advisory);
    if (exception.reviewBy > exception.expiresOn) {
      throw new Error(`Dependency audit exception ${advisory} reviewBy must not follow expiresOn`);
    }

    const key = `${advisory}\0${exception.package}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate dependency audit exception: ${advisory} for ${exception.package}`);
    }
    seen.add(key);
  }

  return allowlist.exceptions;
};

const getToday = () => {
  const value = process.env.DEPENDENCY_AUDIT_TODAY ?? new Date().toISOString().slice(0, 10);
  if (!DATE_PATTERN.test(value)) {
    throw new Error('DEPENDENCY_AUDIT_TODAY must use YYYY-MM-DD');
  }
  return value;
};

const getGeneratedAt = () => {
  const value = process.env.DEPENDENCY_AUDIT_GENERATED_AT ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(value))) {
    throw new Error('DEPENDENCY_AUDIT_GENERATED_AT must be a valid ISO-8601 timestamp');
  }
  return value;
};

const flattenFindings = (audit) => {
  if (
    !audit ||
    typeof audit !== 'object' ||
    !audit.advisories ||
    typeof audit.advisories !== 'object'
  ) {
    throw new Error('pnpm audit JSON is missing the advisories object');
  }

  const findings = [];
  for (const advisory of Object.values(audit.advisories)) {
    const advisoryId = advisory?.github_advisory_id;
    const packageName = advisory?.module_name;
    const severity = advisory?.severity;
    if (!advisoryId || !packageName || !severity || !Array.isArray(advisory.findings)) {
      throw new Error('pnpm audit JSON contains an incomplete advisory record');
    }
    for (const finding of advisory.findings) {
      if (typeof finding?.version !== 'string' || finding.version === '') {
        throw new Error(`pnpm audit finding ${advisoryId} is missing a resolved version`);
      }
      findings.push({
        advisory: advisoryId,
        title: typeof advisory.title === 'string' ? advisory.title : '',
        url: typeof advisory.url === 'string' ? advisory.url : '',
        package: packageName,
        severity,
        resolvedVersion: finding.version,
        vulnerableVersions:
          typeof advisory.vulnerable_versions === 'string' ? advisory.vulnerable_versions : '',
        patchedVersions:
          typeof advisory.patched_versions === 'string' ? advisory.patched_versions : '',
        paths: Array.isArray(finding.paths) ? finding.paths : [],
      });
    }
  }
  return findings;
};

const getFindingPolicyError = (finding, exception, today) => {
  if (finding.severity === 'high' || finding.severity === 'critical') {
    return `High and critical advisories cannot be allowlisted: ${finding.advisory} (${finding.severity})`;
  }
  if (exception.severity !== finding.severity) {
    return `Severity ${finding.severity} is not allowlisted for ${finding.advisory}; expected ${exception.severity}`;
  }
  if (!exception.versions.includes(finding.resolvedVersion)) {
    return `Resolved version ${finding.resolvedVersion} is not allowlisted for ${finding.advisory} (${finding.package})`;
  }
  if (today > exception.expiresOn) {
    return `Dependency audit exception expired for ${finding.advisory}: ${exception.expiresOn}`;
  }
  if (today > exception.reviewBy) {
    return `Review date passed for ${finding.advisory}: ${exception.reviewBy} (owner ${exception.owner})`;
  }
  return undefined;
};

const exceptionKey = ({ advisory, package: packageName }) => `${advisory}\0${packageName}`;

const evaluate = (audit, exceptions, today) => {
  const findings = flattenFindings(audit);
  const exceptionsByKey = new Map(
    exceptions.map((exception) => [exceptionKey(exception), exception]),
  );
  const usedExceptions = new Set();
  const evaluatedFindings = [];
  const errors = [];

  for (const finding of findings) {
    const exception = exceptionsByKey.get(exceptionKey(finding));
    if (!exception) {
      const policyError = `Unexpected dependency advisory ${finding.advisory}: ${finding.package}@${finding.resolvedVersion} (${finding.severity})`;
      errors.push(policyError);
      evaluatedFindings.push({ finding, exception: undefined, policyError });
      continue;
    }

    usedExceptions.add(exception);
    const policyError = getFindingPolicyError(finding, exception, today);
    if (policyError) errors.push(policyError);
    evaluatedFindings.push({ finding, exception, policyError });
  }

  for (const exception of exceptions) {
    if (!usedExceptions.has(exception)) {
      errors.push(
        `Stale dependency audit exception ${exception.advisory} for ${exception.package}; remove it because the advisory is no longer reported`,
      );
    }
  }

  return { evaluatedFindings, errors };
};

const createReport = (audit, evaluation, generatedAt) => ({
  schemaVersion: 1,
  generatedAt,
  status: evaluation.errors.length === 0 ? 'passed' : 'failed',
  vulnerabilityCounts: audit.metadata?.vulnerabilities ?? {},
  findings: evaluation.evaluatedFindings.map(({ finding, exception, policyError }) => ({
    ...finding,
    policy: policyError ? 'blocked' : 'allowed',
    ...(policyError ? { policyError } : {}),
    ...(exception
      ? {
          trackingIssue: exception.trackingIssue,
          owner: exception.owner,
          reviewBy: exception.reviewBy,
          expiresOn: exception.expiresOn,
        }
      : {}),
  })),
  errors: evaluation.errors,
});

const escapeTableCell = (value) =>
  String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>');

const createMarkdownSummary = (report) => {
  const lines = [
    '# Dependency advisory monitor',
    '',
    report.status === 'passed' ? '✅ Policy passed' : '❌ Policy failed',
    '',
    `Generated: ${report.generatedAt}`,
    '',
  ];

  if (report.findings.length === 0) {
    lines.push('No dependency advisories were reported.', '');
  } else {
    lines.push(
      '| Advisory | Package | Severity | Resolved | Patched | Policy | Dependency paths |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const finding of report.findings) {
      const policy =
        finding.policy === 'allowed'
          ? `allowed via #${finding.trackingIssue} until ${finding.expiresOn}`
          : 'blocked';
      const paths = finding.paths.length > 0 ? finding.paths.join('<br>') : '—';
      lines.push(
        `| ${escapeTableCell(finding.advisory)} | ${escapeTableCell(finding.package)} | ${escapeTableCell(finding.severity)} | ${escapeTableCell(finding.resolvedVersion)} | ${escapeTableCell(finding.patchedVersions || 'unknown')} | ${escapeTableCell(policy)} | ${escapeTableCell(paths)} |`,
      );
    }
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('## Policy errors', '');
    for (const error of report.errors) lines.push(`- ${error}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
};

const writeReports = (options, report) => {
  if (options.reportJsonPath) {
    const path = resolve(options.reportJsonPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.summaryFilePath) {
    const path = resolve(options.summaryFilePath);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, createMarkdownSummary(report));
  }
};

const printEvaluation = (evaluation) => {
  if (evaluation.errors.length > 0) {
    for (const error of evaluation.errors) fail(error);
    return;
  }

  const allowed = evaluation.evaluatedFindings.filter(({ policyError }) => !policyError);
  if (allowed.length === 0) {
    console.log('Dependency audit passed with no advisories.');
    return;
  }

  console.log(
    `Allowed ${allowed.length} documented advisory finding${allowed.length === 1 ? '' : 's'}:`,
  );
  for (const { finding, exception } of allowed) {
    console.log(
      `- ${finding.advisory}: ${finding.package}@${finding.resolvedVersion} (${finding.severity}, patched ${finding.patchedVersions || 'unknown'}, #${exception.trackingIssue}, review by ${exception.reviewBy}, expires ${exception.expiresOn})`,
    );
    for (const path of finding.paths) console.log(`  path: ${path}`);
  }
};

try {
  const options = parseArguments(process.argv.slice(2));
  const allowlist = parseJsonFile(options.allowlistPath, 'dependency audit allowlist');
  const exceptions = validateAllowlist(allowlist);
  const audit = options.auditJsonPath
    ? parseJsonFile(options.auditJsonPath, 'pnpm audit JSON')
    : runPnpmAudit();
  const evaluation = evaluate(audit, exceptions, getToday());
  const report = createReport(audit, evaluation, getGeneratedAt());
  writeReports(options, report);
  printEvaluation(evaluation);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
