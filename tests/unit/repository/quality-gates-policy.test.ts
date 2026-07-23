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
  };
  sonarQubeCloud: {
    projectKey: string;
    analysisMethod: string;
    checkContext: string;
    repositorySecretRequired: boolean;
  };
}

const readPolicy = (): QualityGatePolicy =>
  JSON.parse(readText('config/quality-gates.json')) as QualityGatePolicy;

describe('changed-code quality gate policy', () => {
  it('records blocking Codecov and SonarQube Cloud check identities', () => {
    const policy = readPolicy();

    expect(policy.schemaVersion).toBe(1);
    expect(policy.requiredPullRequestChecks).toEqual([
      { context: 'codecov/patch', appId: 254, provider: 'Codecov' },
      {
        context: 'SonarCloud Code Analysis',
        appId: 12526,
        provider: 'SonarQube Cloud',
      },
    ]);
    expect(policy.codecov).toMatchObject({
      patchTargetPercent: 80,
      thresholdPercent: 2,
      trustedSecret: 'CODECOV_TOKEN',
      forkUploadMode: 'tokenless-public-repository',
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
    });
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

  it('keeps SonarQube Cloud on the GitHub App path without repository workflow credentials', () => {
    const workflowsDir = resolve(repoRoot, '.github/workflows');
    const workflows = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => readText(`.github/workflows/${name}`))
      .join('\n');
    const runbook = readText('docs/QUALITY_GATES.md');

    expect(workflows).not.toContain('SONAR_TOKEN');
    expect(workflows).not.toContain('sonarqube-scan-action');
    expect(runbook).toContain('GitHub App automatic analysis');
    expect(runbook).toContain('SonarCloud Code Analysis');
    expect(runbook).toContain('CODECOV_TOKEN');
    expect(runbook).toContain('tokenless');
    expect(runbook).toContain('Failure triage');
    expect(runbook).toContain('negative probe');
  });
});
