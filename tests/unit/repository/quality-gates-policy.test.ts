import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n') : '';
};

interface QualityGatePolicy {
  schemaVersion: number;
  lastVerifiedAt: string;
  requiredPullRequestChecks: Array<{
    context: string;
    appId: number;
    provider: string;
  }>;
  codecov: {
    patchTargetPercent: number;
    thresholdPercent: number;
    trustedSecret: string;
    forkUploadMode: string;
    components: Record<string, { flag: string; path: string }>;
    actionVersion: string;
    actionCommit: string;
    cliVersion: string;
    preparationPlugins: string;
  };
  sonarQubeCloud: {
    projectKey: string;
    analysisMethod: string;
    checkContext: string;
    repositorySecretRequired: boolean;
    qualityGateName: string;
    newCodePeriodMode: string;
    coverageAuthority: string;
    automaticAnalysisCoverageSupported: boolean;
    requiredCheck: boolean;
    mergeRole: string;
  };
  semgrep: {
    version: string;
    imageDigest: string;
    rulesFile: string;
    requiredCheck: string;
    cloudAppAdvisory: boolean;
    ruleTestsCommand: string;
  };
  codacy: {
    integration: string;
    configFile: string;
    requiredCheck: boolean;
    generatedArtifactsExcluded: boolean;
    sourceAndTestsAnalyzed: boolean;
  };
}

const readPolicy = (): QualityGatePolicy =>
  JSON.parse(readText('config/quality-gates.json')) as QualityGatePolicy;

describe('changed-code quality gate policy', () => {
  it('records current Codecov, SonarQube, Semgrep, and Codacy policy', () => {
    const policy = readPolicy();

    expect(policy.schemaVersion).toBe(1);
    expect(policy.requiredPullRequestChecks).toEqual([
      { context: 'codecov/patch', appId: 254, provider: 'Codecov' },
    ]);
    expect(policy.codecov).toMatchObject({
      patchTargetPercent: 80,
      thresholdPercent: 2,
      trustedSecret: 'CODECOV_TOKEN',
      forkUploadMode: 'tokenless-public-repository',
      actionVersion: '7.1.1',
      actionCommit: '303a32d7a59b442fa8d48b6a1cc6825c09c847a5',
      cliVersion: '11.3.1',
      preparationPlugins: 'noop',
      components: {
        server: { flag: 'server', path: 'src/' },
        extension: { flag: 'extension', path: 'easyeda-bridge-extension/src/' },
      },
    });
    expect(policy.sonarQubeCloud).toEqual({
      projectKey: 'oaslananka_easyeda-mcp-pro',
      analysisMethod: 'github-app-automatic-analysis',
      checkContext: 'SonarCloud Code Analysis',
      repositorySecretRequired: false,
      qualityGateName: 'Sonar way',
      newCodePeriodMode: 'previous_version',
      coverageAuthority: 'codecov',
      automaticAnalysisCoverageSupported: false,
      requiredCheck: false,
      mergeRole: 'advisory',
    });
    expect(policy.semgrep).toEqual({
      version: '1.178.0',
      imageDigest: 'sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b',
      rulesFile: '.semgrep.yml',
      requiredCheck: 'semgrep',
      cloudAppAdvisory: true,
      ruleTestsCommand: 'semgrep test --config <rules> <fixture>',
    });
    expect(policy.codacy).toEqual({
      integration: 'github-app',
      configFile: '.codacy.yml',
      requiredCheck: false,
      generatedArtifactsExcluded: true,
      sourceAndTestsAnalyzed: true,
    });
    expect(policy.lastVerifiedAt).toBe('2026-09-28');
  });

  it('enforces an explicit blocking patch target while retaining separate components', () => {
    const config = readText('codecov.yml');
    const patchSection = config.slice(config.indexOf('    patch:'), config.indexOf('\ncomment:'));

    expect(patchSection).toContain('target: 80%');
    expect(patchSection).toContain('threshold: 2%');
    expect(patchSection).toContain('informational: false');
    expect(patchSection).toContain('only_pulls: true');
    expect(patchSection).toContain('if_ci_failed: error');
    expect(patchSection).toContain('if_not_found: failure');
    expect(patchSection).not.toContain('flags:');

    expect(config).toContain('component_management:');
    expect(config).toContain('component_id: server');
    expect(config).toContain('component_id: bridge-extension');
    expect(config).toContain('name: MCP Server');
    expect(config).toContain('name: EasyEDA Bridge Extension');
    expect(config).toContain('type: patch');
  });

  it('uses tokened uploads only for trusted events and tokenless coverage for fork PRs', () => {
    const workflow = readText('.github/workflows/ci.yml');

    expect(workflow).toContain('Upload server coverage to Codecov (trusted)');
    expect(workflow).toContain('Upload extension coverage to Codecov (trusted)');
    expect(workflow).toContain('Upload server coverage to Codecov (tokenless fork)');
    expect(workflow).toContain('Upload extension coverage to Codecov (tokenless fork)');
    expect(workflow).toContain(
      'github.event.pull_request.head.repo.full_name != github.repository',
    );
    expect(workflow).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(workflow).not.toContain("github.actor == 'dependabot[bot]'");
    expect(workflow.match(/token: \$\{\{ secrets\.CODECOV_TOKEN \}\}/g)).toHaveLength(4);

    const tokenlessServer = workflow.slice(
      workflow.indexOf('- name: Upload server coverage to Codecov (tokenless fork)'),
      workflow.indexOf('- name: Upload extension coverage to Codecov (trusted)'),
    );
    const tokenlessExtension = workflow.slice(
      workflow.indexOf('- name: Upload extension coverage to Codecov (tokenless fork)'),
      workflow.indexOf('- name: Upload server test results to Codecov'),
    );
    expect(tokenlessServer).not.toContain('secrets.CODECOV_TOKEN');
    expect(tokenlessExtension).not.toContain('secrets.CODECOV_TOKEN');
  });

  it('does not retain unsupported routing scaffolding in the production source tree', () => {
    expect(existsSync(resolve(repoRoot, 'src/router'))).toBe(false);
    expect(readText('src/tools/L2_autorouting.ts')).not.toContain("from '../router/");
  });

  it('installs and doctors the packed npm artifact on every supported OS', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const matrix = workflow.slice(
      workflow.indexOf('  test-matrix:'),
      workflow.indexOf('\n  codeql:'),
    );

    expect(matrix).toContain('os: ubuntu-24.04');
    expect(matrix).toContain('os: windows-2025');
    expect(matrix).toContain('os: macos-26');
    expect(matrix).toContain('node scripts/e2e/packed-install-doctor.mjs');
    expect(matrix).not.toContain('node dist/index.js --doctor');

    const smoke = readText('scripts/e2e/packed-install-doctor.mjs');
    expect(smoke).toContain('function nodeGlobalModulePath(packageName, ...segments)');
    expect(smoke).toContain("nodeGlobalModulePath('npm', 'bin', 'npm-cli.js')");
    expect(smoke).toContain('run(process.execPath, [npmCli, ...args]');
    expect(smoke).toContain("'node_modules', 'easyeda-mcp-pro', 'dist', 'index.js'");
    expect(smoke).not.toContain("run('npm'");
    expect(smoke).not.toContain("spawnSync('cmd.exe'");
    expect(smoke).not.toContain('process.env.ComSpec');
    expect(smoke).toContain("['pack', '--pack-destination'");
    expect(smoke).toContain("'install', '--global', '--prefix'");
    expect(smoke).toContain("[installedEntry, '--doctor']");
  });

  it('keeps normative governance docs aligned with the advisory SonarQube role', () => {
    const policy = readPolicy();
    const releasePolicy = readText('docs/RELEASE_POLICY.md');
    const releaseProcess = readText('docs/RELEASE_PROCESS.md');
    const continuity = readText('docs/MAINTAINER_CONTINUITY.md');
    const openssf = readText('docs/OPENSSF_BEST_PRACTICES.md');
    const securityArchitecture = readText('docs/security-architecture.md');
    const securityTooling = readText('docs/development/security-tooling.md');

    expect(policy.sonarQubeCloud).toMatchObject({
      requiredCheck: false,
      mergeRole: 'advisory',
      coverageAuthority: 'codecov',
    });

    expect(releasePolicy).toContain('SonarQube Cloud advisory findings');
    expect(releasePolicy).not.toContain('Sonar quality gate');
    expect(releaseProcess).toContain('SonarQube Cloud advisory findings');

    expect(continuity).toContain('SonarQube Cloud remains advisory');
    expect(continuity).toContain('2026-09-28-main-ruleset.json');
    expect(continuity).not.toContain('and SonarQube checks');

    expect(openssf).toContain('SonarQube Cloud automatic analysis is advisory');
    expect(securityArchitecture).toContain(
      'SonarQube Cloud remains advisory pull-request analysis',
    );
    expect(securityTooling).toContain('SonarQube Cloud (advisory automatic analysis)');
    expect(securityTooling).not.toContain('pull-request Quality Gate');
  });

  it('keeps SonarQube Cloud on provider-owned automatic analysis without repo credentials', () => {
    const workflowsDir = resolve(repoRoot, '.github/workflows');
    const workflows = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => readText('.github/workflows/' + name))
      .join('\n');
    const runbook = readText('docs/QUALITY_GATES.md');

    expect(workflows).not.toContain('SONAR_TOKEN');
    expect(workflows).not.toContain('sonarqube-scan-action');
    expect(runbook).toContain('GitHub App automatic analysis');
    expect(runbook).toContain('SonarCloud Code Analysis');
    expect(runbook).toContain('advisory');
    expect(runbook).toContain('Codecov is the coverage authority');
    expect(runbook).toContain('Failure triage');
    expect(runbook).toContain('negative probe');
  });
});
