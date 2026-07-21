import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

const packageJson = JSON.parse(readText('package.json')) as {
  scripts?: Record<string, string>;
};

const SEMGREP_VERSION = '1.170.0';
const SNYK_VERSION = '1.1306.1';
const ACTIONLINT_VERSION = '1.7.12';
const ZIZMOR_VERSION = '1.22.0';
const TRIVY_ACTION_SHA = 'ed142fd0673e97e23eac54620cfb913e5ce36c25';

describe('repository security tooling policy', () => {
  it('keeps local hooks fast, deterministic, and focused on changed files', () => {
    const config = readText('.pre-commit-config.yaml');

    expect(config).toContain('default_install_hook_types:');
    expect(config).toContain('- pre-commit');
    expect(config).not.toContain('- pre-push');
    expect(config).toContain('id: trailing-whitespace');
    expect(config).toContain('id: end-of-file-fixer');
    expect(config).toContain('id: check-merge-conflict');
    expect(config).toContain('id: check-added-large-files');
    expect(config).toContain('id: detect-private-key');
    expect(config).toContain('id: mixed-line-ending');
    expect(config).not.toContain('repo: https://github.com/semgrep/pre-commit');
    expect(config).not.toContain('id: snyk-oss');
  });

  it('checks GitHub Actions syntax and security in pre-commit', () => {
    const config = readText('.pre-commit-config.yaml');

    expect(config).toContain('repo: https://github.com/rhysd/actionlint');
    expect(config).toContain(`rev: v${ACTIONLINT_VERSION}`);
    expect(config).toContain('id: actionlint');
    expect(config).toContain('repo: https://github.com/zizmorcore/zizmor-pre-commit');
    expect(config).toContain(`rev: v${ZIZMOR_VERSION}`);
    expect(config).toContain('id: zizmor');
    expect(config).toContain('--min-severity=medium');
  });

  it('keeps high-signal repository Semgrep rules and generated-file exclusions under version control', () => {
    const rules = readText('.semgrep.yml');
    const ignore = readText('.semgrepignore');

    expect(rules).toContain('easyeda.security.no-dynamic-code-execution');
    expect(rules).toContain('easyeda.security.no-shell-child-process');
    expect(rules).toContain('easyeda.security.no-disabled-tls-verification');
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('tests/semgrep/');
    expect(ignore).toContain('easyeda-bridge-extension/dist/');
  });

  it('exposes version-pinned manual security commands without putting network scanners in Git hooks', () => {
    expect(packageJson.scripts?.['security:semgrep']).toBe(
      'semgrep scan --config .semgrep.yml --error --metrics=off .',
    );
    expect(packageJson.scripts?.['security:semgrep:test']).toBe(
      'node scripts/test-semgrep-rules.mjs',
    );
    expect(packageJson.scripts?.['security:snyk:oss']).toBe(
      `corepack pnpm dlx snyk@${SNYK_VERSION} test --all-projects --severity-threshold=high`,
    );
    expect(packageJson.scripts?.['security:snyk:code']).toBe(
      `corepack pnpm dlx snyk@${SNYK_VERSION} code test --severity-threshold=high`,
    );
    expect(packageJson.scripts?.['security:snyk']).toBe(
      'pnpm security:snyk:oss && pnpm security:snyk:code',
    );
    const workspace = readText('pnpm-workspace.yaml');
    expect(workspace).toContain('minimumReleaseAge: 4320');
    expect(workspace).toContain('minimumReleaseAgeStrict: true');
    expect(workspace).toContain('minimumReleaseAgeIgnoreMissingTime: false');
    expect(workspace).toContain('trustLockfile: false');
    expect(workspace).toContain('blockExoticSubdeps: true');
    expect(workspace).toContain('body-parser: 2.3.0');
  });

  it('runs Semgrep, workflow hardening, and Trivy as separate CI concerns', () => {
    const workflow = readText('.github/workflows/static-security-analysis.yml');

    expect(workflow).toContain(`semgrep==${SEMGREP_VERSION}`);
    expect(workflow).toContain('semgrep --validate --config .semgrep.yml');
    expect(workflow).toContain('node scripts/test-semgrep-rules.mjs');
    expect(workflow).toContain('semgrep scan --config .semgrep.yml');
    expect(workflow).toContain('workflow-security:');
    expect(workflow).toContain(`pre-commit run actionlint --all-files`);
    expect(workflow).toContain(`pre-commit run zizmor --all-files`);
    expect(workflow).toContain('container-security:');
    expect(workflow).toContain(`aquasecurity/trivy-action@${TRIVY_ACTION_SHA}`);
    expect(workflow).toContain("scan-type: 'config'");
    expect(workflow).toContain("version: 'v0.72.0'");
    expect(workflow).toContain('docker build -t easyeda-mcp-pro:security .');
    expect(workflow).toContain("image-ref: 'easyeda-mcp-pro:security'");
    expect(workflow.match(/exit-code: '1'/g)).toHaveLength(2);
    expect(workflow).toContain("scanners: 'vuln'");
    expect(workflow).toContain('Enforce Trivy results');
    expect(workflow).toContain('github/codeql-action/upload-sarif@');
    expect(workflow).not.toContain('SEMGREP_APP_TOKEN');
    expect(workflow).not.toContain('pull_request_target');

    const allWorkflows =
      readText('.github/workflows/ci.yml') +
      readText('.github/workflows/agent-runtime-config.yml') +
      readText('.github/workflows/dependency-review.yml') +
      readText('.github/workflows/deploy-docs.yml') +
      readText('.github/workflows/golden-benchmark.yml') +
      readText('.github/workflows/release-please.yml') +
      readText('.github/workflows/scorecard.yml') +
      workflow;
    expect(allWorkflows.match(/uses: actions\/checkout@/g)).toHaveLength(
      allWorkflows.match(/persist-credentials: false/g)?.length ?? 0,
    );
    expect(readText('.github/workflows/ci.yml')).not.toContain('cache: pnpm');
    expect(readText('.github/workflows/release-please.yml')).not.toContain('cache: pnpm');
    expect(readText('.github/workflows/release-please.yml')).toContain(
      'MANUAL_TAG: ${{ github.event.inputs.tag_name }}',
    );
    expect(readText('.github/workflows/release-please.yml')).toContain(
      'if [[ "$RELEASE_CREATED" == "true" || -n "$MANUAL_TAG" ]]',
    );
  });

  it('hardens release and benchmark dependency installation', () => {
    const releaseWorkflow = readText('.github/workflows/release-please.yml');
    const benchmarkWorkflow = readText('.github/workflows/golden-benchmark.yml');

    expect(releaseWorkflow).toContain(
      'uses: anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610',
    );
    expect(releaseWorkflow).toContain('format: cyclonedx-json');
    expect(releaseWorkflow).toContain('output-file: sbom.json');
    expect(releaseWorkflow).toContain('upload-artifact: false');
    expect(releaseWorkflow).toContain('upload-release-assets: false');
    expect(releaseWorkflow).not.toContain('npx --yes @cyclonedx/cyclonedx-npm');
    expect(benchmarkWorkflow).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });

  it('keeps the release-managed Claude plugin manifest compatible with Prettier', () => {
    const prettierConfig = JSON.parse(readText('.prettierrc')) as {
      overrides?: Array<{ files?: string; options?: { printWidth?: number } }>;
    };

    expect(prettierConfig.overrides).toContainEqual({
      files: '.claude-plugin/plugin.json',
      options: { printWidth: 60 },
    });
  });

  it('documents the local/cloud split and provides a structured pull request template', () => {
    const guide = readText('docs/development/security-tooling.md');
    const contributionGuide = readText('CONTRIBUTING.md');
    const template = readText('.github/pull_request_template.md');

    expect(guide).toContain('pre-commit install --hook-type pre-commit');
    expect(guide).toContain('actionlint');
    expect(guide).toContain('zizmor');
    expect(guide).toContain('Trivy');
    expect(guide).toContain('Snyk scans are explicit');
    expect(guide).toContain('SonarQube for IDE');
    expect(guide).toContain('Connected Mode');
    expect(contributionGuide).not.toContain('pre-push stage runs the Snyk');
    expect(template).toContain('## Summary');
    expect(template).toContain('## Risk');
    expect(template).toContain('## Validation');
    expect(template).toContain('## Security and supply chain');

    const dockerfile = readText('Dockerfile');
    expect(dockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(dockerfile).toContain('/usr/local/lib/node_modules/corepack');
    expect(dockerfile).toContain('USER node');
  });
});
