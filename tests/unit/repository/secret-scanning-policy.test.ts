import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanText } from '../../../scripts/check-secret-hygiene.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n') : '';
};

interface SecretScanningPolicy {
  schemaVersion: number;
  liveStateVerifiedAt: string;
  evaluatedCommit: string;
  repository: {
    ownerType: string;
    visibility: string;
  };
  github: {
    secretScanning: { status: string };
    pushProtection: { status: string };
    validityChecks: { status: string; availability: string; enableAttempt: string };
    nonProviderPatterns: { status: string; availability: string; enableAttempt: string };
    customPatterns: { available: boolean; apiResult: string };
    alerts: { open: number; resolved: number };
  };
  localEvaluation: {
    scanner: string;
    version: string;
    historyCommitsScanned: number;
    historyFindingCount: number;
    treeFindingCount: number;
    syntheticFixtures: string;
  };
  suppressionPolicy: {
    activeSuppressions: number;
    requiredEvidence: string[];
  };
}

const readPolicy = (): SecretScanningPolicy =>
  JSON.parse(readText('config/secret-scanning-policy.json')) as SecretScanningPolicy;

describe('secret scanning and credential response policy', () => {
  it('records the verified GitHub feature state and personal-repository limitations', () => {
    const policy = readPolicy();

    expect(policy).toMatchObject({
      schemaVersion: 1,
      liveStateVerifiedAt: '2026-07-24',
      evaluatedCommit: 'e99f02efcc63a722a6a46a7621826b504aeabfc7',
      repository: { ownerType: 'User', visibility: 'public' },
      github: {
        secretScanning: { status: 'enabled' },
        pushProtection: { status: 'enabled' },
        validityChecks: {
          status: 'disabled',
          availability: 'unavailable-user-owned-public-repository',
          enableAttempt: 'api-accepted-but-remained-disabled',
        },
        nonProviderPatterns: {
          status: 'disabled',
          availability: 'unavailable-user-owned-public-repository',
          enableAttempt: 'api-accepted-but-remained-disabled',
        },
        customPatterns: { available: false, apiResult: 'feature-not-available' },
        alerts: { open: 0, resolved: 0 },
      },
    });

    expect(policy.localEvaluation).toEqual({
      scanner: 'Gitleaks',
      version: '8.30.1',
      historyCommitsScanned: 294,
      historyFindingCount: 0,
      treeFindingCount: 0,
      syntheticFixtures: 'runtime-constructed-non-secret',
    });
    expect(policy.suppressionPolicy.activeSuppressions).toBe(0);
    expect(policy.suppressionPolicy.requiredEvidence).toEqual([
      'exact-fingerprint',
      'technical-rationale',
      'owner',
      'review-date',
      'expiry-date',
    ]);
  });

  it('keeps synthetic redaction fixtures scanner-safe and has no active Gitleaks suppression', () => {
    const redactionTest = readText('tests/unit/utils/redaction.test.ts');
    const preCommit = readText('.pre-commit-config.yaml');
    const ignoreEntries = readText('.gitleaksignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(redactionTest).toContain("['-----BEGIN', 'PRIVATE KEY-----'].join(' ')");
    expect(redactionTest).toContain("['-----END', 'PRIVATE KEY-----'].join(' ')");
    const privateKeyBoundary = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    expect(redactionTest).not.toContain(privateKeyBoundary);
    expect(preCommit).not.toContain('exclude: ^tests/unit/utils/redaction');
    expect(ignoreEntries).toEqual([]);
  });

  it('detects private-key boundaries and credential-bearing connection strings', () => {
    const privateKeyBoundary = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const credentialUri = ['postgresql://user', 'password@database.invalid/app'].join(':');

    expect(scanText(`${privateKeyBoundary}\nnot-a-real-key`, 'fixture.pem')).toEqual([
      expect.objectContaining({ ruleId: 'pem-private-key', source: 'fixture.pem' }),
    ]);
    expect(scanText(credentialUri, 'fixture.txt')).toEqual([
      expect.objectContaining({ ruleId: 'credential-bearing-uri', source: 'fixture.txt' }),
    ]);
    expect(scanText('postgresql://database.invalid/app', 'safe.txt')).toEqual([]);
  });

  it('uses a fixed Git executable allowlist and deterministic file ordering', () => {
    const scanner = readText('scripts/check-secret-hygiene.mjs');

    expect(scanner).not.toContain("execFileSync('git'");
    expect(scanner).toContain("'/usr/bin/git'");
    expect(scanner).toContain('String.raw`C:\\Program Files\\Git\\cmd\\git.exe`');
    expect(scanner).toContain('git.exe');
    expect(scanner).not.toContain("platform === 'darwin' ?");
    expect(scanner).toContain('.sort((left, right) => left.localeCompare(right))');
    expect(scanner).toContain('text.codePointAt(index)');
    expect(scanner).not.toContain('text.charCodeAt(index)');
  });

  it('runs the deterministic hygiene scanner after generated builds', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };
    const workflow = readText('.github/workflows/ci.yml');

    expect(packageJson.scripts?.['security:secrets']).toBe('node scripts/check-secret-hygiene.mjs');
    expect(packageJson.scripts?.verify).toContain(
      'pnpm build:extension && pnpm security:secrets && pnpm check:metadata',
    );
    expect(workflow).toContain(
      '- name: Scan source and generated outputs for secret-like material',
    );
    expect(workflow).toContain('run: pnpm security:secrets');
    expect(workflow.indexOf('run: pnpm security:secrets')).toBeGreaterThan(
      workflow.indexOf('run: pnpm build:extension'),
    );
  });

  it('documents suppression, revocation, rotation, history cleanup, disclosure, and ownership', () => {
    const runbook = readText('docs/SECRET_RESPONSE.md');
    const security = readText('SECURITY.md');
    const tooling = readText('docs/development/security-tooling.md');

    expect(runbook).toContain('## Live GitHub settings and eligibility');
    expect(runbook).toContain('## False positives and suppressions');
    expect(runbook).toContain('## Confirmed credential incident');
    expect(runbook).toContain('Revoke first');
    expect(runbook).toContain('Rotate every dependent credential');
    expect(runbook).toContain('Repository history cleanup');
    expect(runbook).toContain('Coordinated disclosure');
    expect(runbook).toContain('GitHub Security Advisory');
    expect(runbook).toContain('Security contact');
    expect(runbook).toContain('fork');
    expect(security).toContain(
      '[Secret Scanning and Credential Response](docs/SECRET_RESPONSE.md)',
    );
    expect(tooling).toContain('[Secret Scanning and Credential Response](../SECRET_RESPONSE.md)');
  });

  it('keeps privileged credentials out of untrusted pull-request execution', () => {
    const workflowsDir = resolve(repoRoot, '.github/workflows');
    const workflows = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => readText(`.github/workflows/${name}`))
      .join('\n');
    const ci = readText('.github/workflows/ci.yml');
    const release = readText('.github/workflows/release-please.yml');

    expect(workflows).not.toContain('pull_request_target');
    expect(ci).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(ci).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(ci).toContain('Upload server coverage to Codecov (tokenless fork)');
    expect(ci).toContain('Upload extension coverage to Codecov (tokenless fork)');
    expect(release).toContain("if: github.event_name == 'push'");
    expect(release).not.toContain('pull_request:');
  });
});
