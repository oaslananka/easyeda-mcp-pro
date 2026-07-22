import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const scriptPath = resolve(repoRoot, 'scripts/check-dependency-audit.mjs');
const temporaryDirectories: string[] = [];

interface AdvisoryOptions {
  advisory?: string;
  packageName?: string;
  version?: string;
  severity?: string;
}

const makeAudit = ({
  advisory = 'GHSA-frvp-7c67-39w9',
  packageName = '@hono/node-server',
  version = '1.19.14',
  severity = 'moderate',
}: AdvisoryOptions = {}) => ({
  advisories: {
    '1124006': {
      findings: [
        {
          version,
          paths: ['.>@modelcontextprotocol/sdk>@hono/node-server'],
          dev: false,
          optional: false,
          bundled: false,
        },
      ],
      id: 1124006,
      title: 'Test advisory',
      module_name: packageName,
      vulnerable_versions: '<2.0.5',
      patched_versions: '>=2.0.5',
      severity,
      github_advisory_id: advisory,
      url: `https://github.com/advisories/${advisory}`,
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: severity === 'moderate' ? 1 : 0,
      high: severity === 'high' ? 1 : 0,
      critical: severity === 'critical' ? 1 : 0,
    },
    dependencies: 1,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 1,
  },
});

const makeAllowlist = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  exceptions: [
    {
      advisory: 'GHSA-frvp-7c67-39w9',
      package: '@hono/node-server',
      versions: ['1.19.14'],
      severity: 'moderate',
      owner: '@oaslananka',
      reason: 'The affected serve-static subpath is not imported by this package.',
      reachability:
        'The MCP SDK imports getRequestListener from the package root; serve-static is a separate export.',
      trackingIssue: 334,
      reviewBy: '2026-08-10',
      expiresOn: '2026-08-15',
      ...overrides,
    },
  ],
});

const createPolicyFixture = (audit: unknown, allowlist: unknown) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'dependency-audit-policy-'));
  temporaryDirectories.push(directory);
  const auditPath = resolve(directory, 'audit.json');
  const allowlistPath = resolve(directory, 'allowlist.json');
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  writeFileSync(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`);
  return { directory, auditPath, allowlistPath };
};

const runPolicy = (audit: unknown, allowlist: unknown) => {
  const { auditPath, allowlistPath } = createPolicyFixture(audit, allowlist);

  return spawnSync(
    process.execPath,
    [scriptPath, '--audit-json', auditPath, '--allowlist', allowlistPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPENDENCY_AUDIT_TODAY: '2026-07-22',
      },
    },
  );
};

const runPolicyWithReports = (audit: unknown, allowlist: unknown) => {
  const { directory, auditPath, allowlistPath } = createPolicyFixture(audit, allowlist);
  const reportPath = resolve(directory, 'dependency-audit-report.json');
  const summaryPath = resolve(directory, 'dependency-audit-summary.md');
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--audit-json',
      auditPath,
      '--allowlist',
      allowlistPath,
      '--',
      '--report-json',
      reportPath,
      '--summary-file',
      summaryPath,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPENDENCY_AUDIT_TODAY: '2026-07-22',
        DEPENDENCY_AUDIT_GENERATED_AT: '2026-07-22T18:00:00.000Z',
      },
    },
  );

  return { result, reportPath, summaryPath };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('dependency audit policy', () => {
  it('allows one exact, documented, unexpired moderate advisory', () => {
    const result = runPolicy(makeAudit(), makeAllowlist());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Allowed 1 documented advisory finding');
    expect(result.stdout).toContain('GHSA-frvp-7c67-39w9');
    expect(result.stdout).toContain('#334');
  });

  it('rejects an unexpected advisory', () => {
    const result = runPolicy(makeAudit({ advisory: 'GHSA-aaaa-bbbb-cccc' }), makeAllowlist());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unexpected dependency advisory');
    expect(result.stderr).toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('never allows high or critical advisories', () => {
    const result = runPolicy(makeAudit({ severity: 'high' }), makeAllowlist({ severity: 'high' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('High and critical advisories cannot be allowlisted');
  });

  it('rejects a finding whose resolved version is not explicitly allowed', () => {
    const result = runPolicy(makeAudit({ version: '1.19.15' }), makeAllowlist());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Resolved version 1.19.15 is not allowlisted');
  });

  it('rejects an exception after its review date', () => {
    const result = runPolicy(makeAudit(), makeAllowlist({ reviewBy: '2026-07-21' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Review date passed');
  });

  it('rejects an expired exception', () => {
    const result = runPolicy(
      makeAudit(),
      makeAllowlist({ reviewBy: '2026-07-20', expiresOn: '2026-07-21' }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dependency audit exception expired');
  });

  it('writes machine-readable and human-readable reports for allowed findings', () => {
    const { result, reportPath, summaryPath } = runPolicyWithReports(makeAudit(), makeAllowlist());

    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      schemaVersion: number;
      generatedAt: string;
      status: string;
      findings: Array<Record<string, unknown>>;
      errors: string[];
    };
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-07-22T18:00:00.000Z',
      status: 'passed',
      errors: [],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        advisory: 'GHSA-frvp-7c67-39w9',
        package: '@hono/node-server',
        resolvedVersion: '1.19.14',
        patchedVersions: '>=2.0.5',
        paths: ['.>@modelcontextprotocol/sdk>@hono/node-server'],
        policy: 'allowed',
        trackingIssue: 334,
      }),
    ]);

    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('# Dependency advisory monitor');
    expect(summary).toContain('✅ Policy passed');
    expect(summary).toContain('GHSA-frvp-7c67-39w9');
    expect(summary).toContain('@hono/node-server');
    expect(summary).toContain('>=2.0.5');
    expect(summary).toContain('.>@modelcontextprotocol/sdk>@hono/node-server');
  });

  it('writes failure evidence before rejecting an unexpected advisory', () => {
    const { result, reportPath, summaryPath } = runPolicyWithReports(
      makeAudit({ advisory: 'GHSA-aaaa-bbbb-cccc' }),
      makeAllowlist(),
    );

    expect(result.status).toBe(1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      status: string;
      findings: Array<Record<string, unknown>>;
      errors: string[];
    };
    expect(report.status).toBe('failed');
    expect(report.findings).toEqual([expect.objectContaining({ policy: 'blocked' })]);
    expect(report.errors.join('\n')).toContain('Unexpected dependency advisory');
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('❌ Policy failed');
    expect(summary).toContain('Unexpected dependency advisory');
  });

  it('rejects stale exceptions after the advisory disappears', () => {
    const result = runPolicy(
      {
        advisories: {},
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          dependencies: 1,
          devDependencies: 0,
          optionalDependencies: 0,
          totalDependencies: 1,
        },
      },
      makeAllowlist(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stale dependency audit exception');
  });
});
