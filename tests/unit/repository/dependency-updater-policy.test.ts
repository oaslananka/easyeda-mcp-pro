import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const renovateConfigPath = resolve(repoRoot, '.github/renovate.json');
const dependabotConfigPath = resolve(repoRoot, '.github/dependabot.yml');
const releaseCiRunbookPath = resolve(repoRoot, 'docs/release-ci-runbook.md');
const readmePath = resolve(repoRoot, 'README.md');
const securityArchitecturePath = resolve(repoRoot, 'docs/security-architecture.md');

interface RenovatePackageRule {
  matchManagers?: string[];
  matchDepTypes?: string[];
  matchUpdateTypes?: string[];
  postUpdateOptions?: string[];
  automerge?: boolean;
}

interface RenovateConfig {
  dependencyDashboard?: boolean;
  osvVulnerabilityAlerts?: boolean;
  packageRules?: RenovatePackageRule[];
  'pip-compile'?: {
    managerFilePatterns: string[];
    lockFileMaintenance?: { enabled?: boolean; automerge?: boolean };
  };
}

describe('dependency updater ownership', () => {
  it('uses Renovate as the only dependency update bot', () => {
    expect(existsSync(renovateConfigPath)).toBe(true);
    expect(existsSync(dependabotConfigPath)).toBe(false);
  });

  it('keeps the dependency dashboard and vulnerability alerts enabled without a release-age delay', () => {
    const raw = readFileSync(renovateConfigPath, 'utf8');
    const config = JSON.parse(raw) as RenovateConfig;

    expect(raw).not.toContain('minimumReleaseAge');
    expect(config.dependencyDashboard).toBe(true);
    expect(config.osvVulnerabilityAlerts).toBe(true);
  });

  it('automerge is limited to low-risk dev updates and lockfile maintenance', () => {
    const config = JSON.parse(readFileSync(renovateConfigPath, 'utf8')) as RenovateConfig & {
      lockFileMaintenance?: { automerge?: boolean };
    };
    const devRule = config.packageRules?.find((rule) =>
      rule.matchDepTypes?.includes('devDependencies'),
    );
    const runtimeRule = config.packageRules?.find((rule) =>
      rule.matchDepTypes?.includes('dependencies'),
    );
    const actionsRule = config.packageRules?.find((rule) =>
      rule.matchManagers?.includes('github-actions'),
    );

    expect(devRule).toMatchObject({ matchUpdateTypes: ['minor', 'patch'], automerge: true });
    expect(runtimeRule?.automerge).toBe(false);
    expect(actionsRule?.automerge).toBe(false);
    expect(config.lockFileMaintenance?.automerge).toBe(true);
    expect(
      config.packageRules?.some(
        (rule) =>
          rule.matchUpdateTypes?.length === 1 &&
          rule.matchUpdateTypes[0] === 'patch' &&
          rule.automerge === true &&
          !rule.matchDepTypes,
      ),
    ).toBe(false);
  });

  it('automerge is limited to pnpm workspace override patch updates with deduped lockfile peers', () => {
    const config = JSON.parse(readFileSync(renovateConfigPath, 'utf8')) as RenovateConfig & {
      automergeStrategy?: string;
      automergeType?: string;
    };
    expect(config.automergeType).toBe('pr');
    expect(config.automergeStrategy).toBe('squash');
    const rule = config.packageRules?.find(
      (entry) =>
        entry.matchManagers?.includes('npm') &&
        entry.matchDepTypes?.includes('pnpm-workspace.overrides') &&
        entry.matchUpdateTypes?.includes('patch'),
    );
    expect(rule).toMatchObject({
      matchManagers: ['npm'],
      matchDepTypes: ['pnpm-workspace.overrides'],
      matchUpdateTypes: ['patch'],
      postUpdateOptions: ['pnpmDedupe'],
      automerge: true,
    });
    expect(
      config.packageRules?.some(
        (entry) =>
          entry.matchDepTypes?.includes('pnpm-workspace.overrides') &&
          entry.automerge === true &&
          entry.matchUpdateTypes?.some((type) => type === 'minor' || type === 'major'),
      ),
    ).toBe(false);
    const denyRule = config.packageRules?.find(
      (entry) =>
        entry.matchManagers?.includes('npm') &&
        entry.matchDepTypes?.includes('overrides') &&
        entry.matchDepTypes?.includes('pnpm-workspace.overrides'),
    );
    expect(denyRule).toMatchObject({ automerge: false });
    expect(denyRule?.matchUpdateTypes).toBeUndefined();
    expect(
      config.packageRules?.some(
        (entry) => entry.matchDepTypes?.includes('overrides') && entry.automerge === true,
      ),
    ).toBe(false);
    expect(
      config.packageRules?.some(
        (entry) =>
          entry.matchDepTypes?.includes('pnpm-workspace.overrides') &&
          entry.automerge === true &&
          (entry.matchUpdateTypes?.length !== 1 || entry.matchUpdateTypes[0] !== 'patch'),
      ),
    ).toBe(false);
  });

  it('documents hosted Renovate activation without hard-coding a dashboard issue number', () => {
    const runbook = readFileSync(releaseCiRunbookPath, 'utf8');

    expect(runbook).not.toContain('easyeda-mcp-pro/issues/1');
    expect(runbook).toContain('Mend Renovate App');
    expect(runbook).toContain('Interactive mode');
    expect(runbook).toContain('Dependency Dashboard');
  });

  it('does not treat checked-in Renovate configuration as proof of hosted activation', () => {
    const readme = readFileSync(readmePath, 'utf8');
    const securityArchitecture = readFileSync(securityArchitecturePath, 'utf8');

    expect(readme).not.toContain('Renovate automatically updates dependencies');
    expect(readme).toContain('Hosted Renovate is an account-level prerequisite');
    expect(securityArchitecture).toContain(
      'hosted-provider activation must be verified independently',
    );
  });

  it('keeps the security assurance evidence aligned with Renovate-only ownership', () => {
    const assuranceCase = readFileSync(
      resolve(repoRoot, 'docs/SECURITY_ASSURANCE_CASE.md'),
      'utf8',
    );

    expect(assuranceCase).toContain('.github/renovate.json');
    expect(assuranceCase).not.toContain('.github/dependabot.yml');
  });

  it('tracks hash-locked pre-commit Python dependencies via pip-compile without automerge', () => {
    const config = JSON.parse(readFileSync(renovateConfigPath, 'utf8')) as RenovateConfig & {
      lockFileMaintenance?: { automerge?: boolean };
    };
    const manager = config['pip-compile'];
    expect(manager?.managerFilePatterns).toEqual([
      '/^\\.github\\/requirements\\/pre-commit\\.txt$/',
    ]);
    expect(manager?.lockFileMaintenance).toEqual({ enabled: true, automerge: false });
    expect(
      config.packageRules?.find((rule) => rule.matchManagers?.includes('pip-compile')),
    ).toMatchObject({ matchManagers: ['pip-compile'], automerge: false });

    const lockfile = readFileSync(resolve(repoRoot, '.github/requirements/pre-commit.txt'), 'utf8');
    const input = readFileSync(resolve(repoRoot, '.github/requirements/pre-commit.in'), 'utf8');
    expect(lockfile).toContain('pip-compile --generate-hashes');
    expect(lockfile).toContain('--output-file=.github/requirements/pre-commit.txt');
    expect(lockfile).toContain('.github/requirements/pre-commit.in');
    expect(input).toContain('pre-commit==');
    expect(lockfile).toContain('--hash=sha256:');
    expect(config.lockFileMaintenance?.automerge).toBe(true);
  });

  it('keeps GitHub Actions and pre-commit hooks under Renovate management', () => {
    const config = JSON.parse(readFileSync(renovateConfigPath, 'utf8')) as RenovateConfig;
    const managesGitHubActions = config.packageRules?.some((rule) =>
      rule.matchManagers?.includes('github-actions'),
    );
    const managesPreCommit = config.packageRules?.some((rule) =>
      rule.matchManagers?.includes('pre-commit'),
    );

    expect(managesGitHubActions).toBe(true);
    expect(managesPreCommit).toBe(true);
  });
});
