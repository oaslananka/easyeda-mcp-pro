#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--audit-json') {
      options.auditJsonPath = argv[index + 1];
      index += 1;
    } else if (argument === '--allowlist') {
      options.allowlistPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (argv.includes('--audit-json') && !options.auditJsonPath) {
    throw new Error('--audit-json requires a file path');
  }
  if (argv.includes('--allowlist') && !options.allowlistPath) {
    throw new Error('--allowlist requires a file path');
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
  if (!allowlist || allowlist.schemaVersion !== 1 || !Array.isArray(allowlist.exceptions)) {
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
        package: packageName,
        severity,
        version: finding.version,
        paths: Array.isArray(finding.paths) ? finding.paths : [],
      });
    }
  }
  return findings;
};

const evaluate = (audit, exceptions, today) => {
  const findings = flattenFindings(audit);
  const usedExceptions = new Set();
  const allowed = [];
  const errors = [];

  for (const finding of findings) {
    const exception = exceptions.find(
      (candidate) =>
        candidate.advisory === finding.advisory && candidate.package === finding.package,
    );

    if (!exception) {
      errors.push(
        `Unexpected dependency advisory ${finding.advisory}: ${finding.package}@${finding.version} (${finding.severity})`,
      );
      continue;
    }

    usedExceptions.add(exception);

    if (finding.severity === 'high' || finding.severity === 'critical') {
      errors.push(
        `High and critical advisories cannot be allowlisted: ${finding.advisory} (${finding.severity})`,
      );
      continue;
    }
    if (exception.severity !== finding.severity) {
      errors.push(
        `Severity ${finding.severity} is not allowlisted for ${finding.advisory}; expected ${exception.severity}`,
      );
      continue;
    }
    if (!exception.versions.includes(finding.version)) {
      errors.push(
        `Resolved version ${finding.version} is not allowlisted for ${finding.advisory} (${finding.package})`,
      );
      continue;
    }
    if (today > exception.expiresOn) {
      errors.push(
        `Dependency audit exception expired for ${finding.advisory}: ${exception.expiresOn}`,
      );
      continue;
    }
    if (today > exception.reviewBy) {
      errors.push(
        `Review date passed for ${finding.advisory}: ${exception.reviewBy} (owner ${exception.owner})`,
      );
      continue;
    }

    allowed.push({ finding, exception });
  }

  for (const exception of exceptions) {
    if (!usedExceptions.has(exception)) {
      errors.push(
        `Stale dependency audit exception ${exception.advisory} for ${exception.package}; remove it because the advisory is no longer reported`,
      );
    }
  }

  return { allowed, errors };
};

try {
  const options = parseArguments(process.argv.slice(2));
  const allowlist = parseJsonFile(options.allowlistPath, 'dependency audit allowlist');
  const exceptions = validateAllowlist(allowlist);
  const audit = options.auditJsonPath
    ? parseJsonFile(options.auditJsonPath, 'pnpm audit JSON')
    : runPnpmAudit();
  const { allowed, errors } = evaluate(audit, exceptions, getToday());

  if (errors.length > 0) {
    for (const error of errors) fail(error);
  } else if (allowed.length > 0) {
    console.log(
      `Allowed ${allowed.length} documented advisory finding${allowed.length === 1 ? '' : 's'}:`,
    );
    for (const { finding, exception } of allowed) {
      console.log(
        `- ${finding.advisory}: ${finding.package}@${finding.version} (${finding.severity}, #${exception.trackingIssue}, review by ${exception.reviewBy}, expires ${exception.expiresOn})`,
      );
    }
  } else {
    console.log('Dependency audit passed with no advisories.');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
