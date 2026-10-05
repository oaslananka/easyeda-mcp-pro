import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? normalizeLineEndings(readFileSync(absolutePath, 'utf8')) : '';
};

const workflowStep = (workflow: string, name: string): string => {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  expect(start, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
};

describe('Codecov analytics policy', () => {
  it('normalizes Windows line endings before evaluating workflow policy', () => {
    expect(normalizeLineEndings('first\r\nsecond\r\n')).toBe('first\nsecond\n');
  });

  it('generates explicit LCOV and JUnit reports for server and extension tests', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const vitestConfig = readText('vitest.config.ts');
    const extensionVitestConfig = readText('easyeda-bridge-extension/vitest.config.ts');

    expect(packageJson.scripts?.['test:coverage:ci']).toContain(
      '--outputFile.junit=reports/server.junit.xml',
    );
    expect(packageJson.scripts?.['test:extension:ci']).toContain('--coverage');
    expect(packageJson.scripts?.['test:extension:ci']).toContain(
      '--outputFile.junit=../reports/extension.junit.xml',
    );
    expect(vitestConfig).toContain("reporter: ['text', 'json', 'html', 'lcov']");
    expect(vitestConfig).not.toContain("'src/router/**'");
    expect(vitestConfig).toContain("'src/remote/gateway.ts': {");
    expect(vitestConfig).toContain('lines: 80');
    expect(vitestConfig).toContain('branches: 70');
    expect(vitestConfig).not.toContain("'src/bridge/*-manager.ts'");
    expect(vitestConfig).toContain("'src/bridge/manager.ts': {");
    expect(vitestConfig).toContain("'src/bridge/cdp-manager.ts': {");
    expect(vitestConfig).toMatch(/'src\/bridge\/manager\.ts': \{\s+lines: 79,\s+branches: 64,/);
    expect(vitestConfig).toMatch(/'src\/bridge\/cdp-manager\.ts': \{\s+lines: 70,\s+branches: 50,/);
    expect(extensionVitestConfig).toContain("reporter: ['text', 'json-summary', 'lcov']");
    expect(extensionVitestConfig).toContain("include: ['src/**/*.ts']");
    expect(extensionVitestConfig).toContain('thresholds: {');
    expect(extensionVitestConfig).toContain('lines: 65');
    expect(extensionVitestConfig).toContain('statements: 65');
    expect(extensionVitestConfig).toContain('functions: 70');
    expect(extensionVitestConfig).toContain('branches: 60');
    expect(extensionVitestConfig).not.toContain("'src/index.ts'");
    expect(extensionVitestConfig).not.toContain("'src/dispatcher-entry.ts'");
    expect(packageJson.scripts?.['validate:codecov']).toContain('codecov.io/validate');
    expect(packageJson.devDependencies?.['@codecov/bundle-analyzer']).toBeUndefined();
    expect(packageJson.scripts?.['analyze:extension-bundle:ci']).toBeUndefined();
    const ratchet = readText('docs/coverage-ratchet.md');
    expect(ratchet).toContain('2026-07-23 extension baseline');
    expect(ratchet).toContain('2026-07-23 extension lifecycle ratchet');
    expect(ratchet).toContain('2026-07-23 remote gateway ratchet');
    expect(ratchet).toContain('2026-07-28 bridge manager visibility and extension branch ratchet');
    expect(ratchet).toMatch(
      /`src\/bridge\/manager\.ts`\s+\|\s+79\.05%\s+\|\s+64\.08%\s+\|\s+79%\s+\|\s+64%/,
    );
    expect(ratchet).toMatch(
      /`src\/bridge\/cdp-manager\.ts`\s+\|\s+71\.24%\s+\|\s+51\.68%\s+\|\s+70%\s+\|\s+50%/,
    );
    expect(ratchet).toContain('Do not exclude `src/index.ts`');
    expect(ratchet).not.toContain('unwired router');
  });

  it('uploads coverage and both test reports with pinned Codecov tooling', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const gitignore = readText('.gitignore');
    const action = 'codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5';

    expect(workflow.match(new RegExp(action, 'g'))).toHaveLength(6);
    expect(workflow).toContain('run: node scripts/install-codecov-cli.mjs');
    expect(
      workflow.match(/binary: \$\{\{ runner\.temp \}\}\/codecov-cli\/codecovcli/g),
    ).toHaveLength(6);
    expect(workflow).not.toContain('version: v11.3.1');
    expect(workflow).not.toContain('skip_validation: true');
    expect(workflow).not.toContain('use_pypi: true');
    expect(workflow.match(/report_type: coverage/g)).toHaveLength(4);
    expect(workflow.match(/report_type: test_results/g)).toHaveLength(2);
    expect(workflow.match(/plugins: noop/g)).toHaveLength(6);
    expect(workflow.match(/token: \$\{\{ secrets\.CODECOV_TOKEN \}\}/g)).toHaveLength(4);
    expect(workflow).toContain('files: coverage/lcov.info');
    expect(workflow).toContain('files: easyeda-bridge-extension/coverage/lcov.info');
    expect(workflow).toContain('files: reports/server.junit.xml');
    expect(workflow).toContain('files: reports/extension.junit.xml');
    expect(workflow).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(workflow).not.toContain('@codecov/vite-plugin');
    expect(workflow).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(workflow).not.toContain("github.actor == 'dependabot[bot]'");
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('run: pnpm validate:codecov');
    expect(workflow).not.toContain('Upload extension bundle analysis to Codecov');
    expect(workflow).not.toContain('run: pnpm analyze:extension-bundle:ci');
    expect(workflow).not.toContain('CODECOV_BUNDLE_SLUG:');
    expect(workflow).not.toContain('CODECOV_BUNDLE_SHA:');
    expect(workflow).not.toContain('CODECOV_BUNDLE_BRANCH:');
    expect(workflow).not.toContain('CODECOV_BUNDLE_PR:');
    expect(workflow.match(/if: \$\{\{ !cancelled\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(gitignore).toContain('reports/');
    expect(gitignore).toContain('easyeda-bridge-extension/coverage/');

    const cliConfig = JSON.parse(readText('config/codecov-cli.json')) as {
      version?: string;
      asset?: string;
      url?: string;
      size?: number;
      sha256?: string;
    };
    expect(cliConfig).toEqual({
      version: '11.3.1',
      asset: 'codecovcli_linux',
      url: 'https://github.com/codecov/codecov-cli/releases/download/v11.3.1/codecovcli_linux',
      size: 10402464,
      sha256: 'ca1d64196d2d34771084afe76ea657d581bf628e31d993ff8e52ea09cc88a56d',
    });
    const installer = readText('scripts/install-codecov-cli.mjs');
    expect(installer).toContain("createHash('sha256')");
    expect(installer).toContain('Only the pinned Codecov GitHub release URL is allowed');
  });

  it('blocks changed executable code below the documented patch target', () => {
    const config = readText('codecov.yml');

    expect(config).toContain('informational: true');
    expect(config).toContain('target: auto');
    expect(config).toContain('target: 80%');
    expect(config).toContain('threshold: 2%');
    expect(config).toContain('informational: false');
    expect(config).toContain('only_pulls: true');
    expect(config).toContain('if_ci_failed: error');
    expect(config).toContain('if_not_found: failure');
    expect(config).toContain('require_changes: true');
    expect(config).toContain('server:');
    expect(config).toContain('extension:');
    expect(config).toContain('- src/');
    expect(config).toContain('- easyeda-bridge-extension/src/');
    expect(config).toContain("layout: 'reach,diff,flags,files,components'");
    expect(config).toContain('component_management:');
    expect(config).toContain('component_id: server');
    expect(config).toContain('component_id: bridge-extension');
    expect(config).toContain('bundle_analysis:');
    expect(config).toContain("warning_threshold: '5%'");
    expect(config).toContain('status: informational');
    expect(config).toContain('require_bundle_changes: bundle_increase');
    expect(config).toContain("bundle_change_threshold: '1Kb'");
  });

  it('stops coverage work after an upstream failure while keeping server and extension failures independently diagnosable', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const audit = workflowStep(workflow, 'Run dependency audit');
    const server = workflowStep(workflow, 'Run server tests with coverage and JUnit output');
    const extension = workflowStep(workflow, 'Run extension tests with coverage and JUnit output');

    expect(audit).toContain('id: dependency_audit');
    expect(server).toContain('id: server_coverage');
    expect(server).not.toContain('if: ${{ !cancelled() }}');
    expect(extension).toContain('id: extension_coverage');
    expect(extension).toContain(
      "if: ${{ !cancelled() && steps.server_coverage.outcome != 'skipped' }}",
    );
  });

  it('stages validated reports before best-effort Codecov telemetry uploads', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const serverValidation = workflowStep(workflow, 'Validate server CI reports');
    const extensionValidation = workflowStep(workflow, 'Validate extension CI reports');
    const artifact = workflowStep(workflow, 'Stage coverage telemetry reports');
    const download = workflowStep(workflow, 'Download coverage telemetry reports');
    const installer = workflowStep(workflow, 'Install SHA-256 verified Codecov CLI');

    expect(serverValidation).toContain('id: server_reports');
    expect(serverValidation).toContain("steps.server_coverage.outcome == 'success'");
    expect(extensionValidation).toContain('id: extension_reports');
    expect(extensionValidation).toContain("steps.extension_coverage.outcome == 'success'");

    expect(artifact).toContain("steps.server_reports.outcome == 'success'");
    expect(artifact).toContain("steps.extension_reports.outcome == 'success'");
    expect(artifact).toContain('continue-on-error: true');
    expect(download).toContain('id: reports');
    expect(download).toContain('continue-on-error: true');
    expect(installer).toContain("steps.reports.outcome == 'success'");
    expect(installer).toContain('continue-on-error: true');

    for (const name of [
      'Upload server coverage to Codecov (trusted)',
      'Upload server coverage to Codecov (tokenless fork)',
      'Upload extension coverage to Codecov (trusted)',
      'Upload extension coverage to Codecov (tokenless fork)',
      'Upload server test results to Codecov',
      'Upload extension test results to Codecov',
    ]) {
      const step = workflowStep(workflow, name);
      expect(step).toContain("steps.reports.outcome == 'success'");
      expect(step).toContain("steps.codecov_cli.outcome == 'success'");
      expect(step).toContain('continue-on-error: true');
    }
  });

  it('keeps Codecov diagnostics in non-blocking coverage telemetry', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const telemetryStart = workflow.indexOf('  coverage_telemetry:');
    const matrixStart = workflow.indexOf('  test-matrix:');
    const telemetry = workflow.slice(telemetryStart, matrixStart);
    const summary = workflowStep(workflow, 'Summarize coverage telemetry');

    expect(telemetry).toContain('name: coverage-telemetry');
    expect(telemetry).toContain('continue-on-error: true');
    expect(summary).toContain('if: ${{ always() }}');
    expect(summary).toContain('GITHUB_STEP_SUMMARY');
    expect(summary).toContain('CODECOV_CLI_OUTCOME');
    expect(summary).toContain('SERVER_COVERAGE_UPLOAD_TRUSTED_OUTCOME');
    expect(summary).toContain('EXTENSION_COVERAGE_UPLOAD_TRUSTED_OUTCOME');
    expect(summary).toContain('not part of the required quality aggregator');
  });

  it('keeps the required quality aggregator independent from Codecov provider availability', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const quality = workflow.slice(workflow.indexOf('  quality:'), workflow.indexOf('  codeql:'));

    expect(quality).toContain('name: quality (24)');
    expect(quality).toContain('- static_quality');
    expect(quality).toContain('- tests');
    expect(quality).toContain('- extension_integrity');
    expect(quality).toContain('- package_docs');
    expect(quality).toContain('- test-matrix');
    expect(quality).not.toContain('coverage_telemetry');
    expect(quality).not.toContain('Codecov');
    expect(quality).toContain(
      'One or more required deterministic quality jobs failed or were skipped.',
    );
  });
});
