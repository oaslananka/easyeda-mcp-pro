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

describe('repository security tooling policy', () => {
  it('runs repository-owned Semgrep rules on staged files', () => {
    const config = readText('.pre-commit-config.yaml');

    expect(config).toContain('default_install_hook_types:');
    expect(config).toContain('- pre-commit');
    expect(config).toContain('- pre-push');
    expect(config).toContain('repo: https://github.com/semgrep/pre-commit');
    expect(config).toContain(`rev: v${SEMGREP_VERSION}`);
    expect(config).toContain('id: semgrep');
    expect(config).toContain('exclude: ^tests/semgrep/');
    expect(config).toContain('--config=.semgrep.yml');
    expect(config).toContain('--metrics=off');
    expect(config).toContain('stages: [pre-commit]');
  });

  it('keeps high-signal repository rules and generated-file exclusions under version control', () => {
    const rules = readText('.semgrep.yml');
    const ignore = readText('.semgrepignore');

    expect(rules).toContain('easyeda.security.no-dynamic-code-execution');
    expect(rules).toContain('easyeda.security.no-shell-child-process');
    expect(rules).toContain('easyeda.security.no-disabled-tls-verification');
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('tests/semgrep/');
    expect(ignore).toContain('easyeda-bridge-extension/dist/');
  });

  it('runs a pinned Snyk Open Source scan at pre-push', () => {
    const config = readText('.pre-commit-config.yaml');

    expect(config).toContain('id: snyk-oss');
    expect(config).toContain('entry: corepack pnpm security:snyk:oss');
    expect(config).toContain('stages: [pre-push]');
    expect(config).toContain('pass_filenames: false');
  });

  it('exposes version-pinned security commands', () => {
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
  });

  it('runs full Semgrep validation, rule tests, scanning, and SARIF upload in CI', () => {
    const workflow = readText('.github/workflows/static-security-analysis.yml');

    expect(workflow).toContain(`semgrep==${SEMGREP_VERSION}`);
    expect(workflow).toContain('semgrep --validate --config .semgrep.yml');
    expect(workflow).toContain('node scripts/test-semgrep-rules.mjs');
    expect(workflow).toContain('semgrep scan --config .semgrep.yml');
    expect(workflow).toContain('github/codeql-action/upload-sarif@');
    expect(workflow).not.toContain('SEMGREP_APP_TOKEN');
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

  it('documents hook setup, Snyk authentication, controlled bypass, and Sonar Connected Mode', () => {
    const guide = readText('docs/development/security-tooling.md');

    expect(guide).toContain('pre-commit install --hook-type pre-commit --hook-type pre-push');
    expect(guide).toContain('snyk auth');
    expect(guide).toContain('SKIP=snyk-oss');
    expect(guide).toContain('SonarQube for IDE');
    expect(guide).toContain('Connected Mode');
  });
});
