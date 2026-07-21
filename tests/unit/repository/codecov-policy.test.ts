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

describe('Codecov analytics policy', () => {
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
    expect(extensionVitestConfig).toContain("reporter: ['text', 'lcov']");
    expect(extensionVitestConfig).toContain("include: ['src/**/*.ts']");
    expect(packageJson.scripts?.['validate:codecov']).toContain('codecov.io/validate');
    expect(packageJson.devDependencies?.['@codecov/bundle-analyzer']).toBe('2.0.1');
    expect(packageJson.scripts?.['analyze:extension-bundle:ci']).toContain(
      'bundle-analyzer easyeda-bridge-extension/dist',
    );
  });

  it('uploads coverage and both test reports with pinned Codecov tooling', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const gitignore = readText('.gitignore');
    const action = 'codecov/codecov-action@cddd853df119a48c5be31a973f8cd97e12e35e16';

    expect(workflow.match(new RegExp(action, 'g'))).toHaveLength(4);
    expect(workflow).toContain('run: node scripts/install-codecov-cli.mjs');
    expect(
      workflow.match(/binary: \$\{\{ runner\.temp \}\}\/codecov-cli\/codecovcli/g),
    ).toHaveLength(4);
    expect(workflow).not.toContain('version: v11.3.1');
    expect(workflow).not.toContain('skip_validation: true');
    expect(workflow).not.toContain('use_pypi: true');
    expect(workflow.match(/report_type: coverage/g)).toHaveLength(2);
    expect(workflow.match(/report_type: test_results/g)).toHaveLength(2);
    expect(workflow.match(/token: \$\{\{ secrets\.CODECOV_TOKEN \}\}/g)).toHaveLength(4);
    expect(workflow).toContain('files: coverage/lcov.info');
    expect(workflow).toContain('files: easyeda-bridge-extension/coverage/lcov.info');
    expect(workflow).toContain('files: reports/server.junit.xml');
    expect(workflow).toContain('files: reports/extension.junit.xml');
    expect(workflow).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(workflow).not.toContain('@codecov/vite-plugin');
    expect(workflow).toContain("github.actor != 'dependabot[bot]'");
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('run: pnpm validate:codecov');
    expect(workflow).toContain('run: pnpm analyze:extension-bundle:ci');
    expect(workflow).toContain('CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}');
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

  it('starts Codecov statuses as informational and limits comments to changed coverage', () => {
    const config = readText('codecov.yml');

    expect(config).toContain('informational: true');
    expect(config).toContain('target: auto');
    expect(config).not.toContain('target: 80%');
    expect(config.match(/target: auto/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(config.match(/threshold: 1%/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(config).toContain('threshold: 1%');
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
});
