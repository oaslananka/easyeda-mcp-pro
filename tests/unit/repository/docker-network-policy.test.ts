import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('Docker network verification policy', () => {
  it('tests the published host port and unsafe non-loopback startup in CI', () => {
    const workflow = read('.github/workflows/ci.yml');
    const script = read('scripts/e2e/docker-network-smoke.mjs');

    expect(workflow).toContain(
      'node scripts/e2e/docker-network-smoke.mjs --image easyeda-mcp-pro:ci',
    );
    expect(script).toContain('127.0.0.1::3000');
    expect(script).toContain('HTTP_HOST=0.0.0.0');
    expect(script).toContain('SAFETY:');
    expect(script).toContain('/healthz');
    expect(script).toContain('Runtime mode: production-runtime');
    expect(script).toContain('pnpm: NOT REQUIRED (production-runtime)');
    expect(script).toContain('EasyEDA extension package: OK');
    expect(script).toContain('forbiddenRuntimePackages');
    for (const packageName of ['archiver', 'brace-expansion', 'eslint', 'typescript', 'vitest']) {
      expect(script).toContain(`'${packageName}'`);
    }
    expect(script).toContain('runtime dependency tree: production-only');
  });

  it('documents local-only and authenticated published-port deployments separately', () => {
    const docs = `${read('docs/INSTALLATION.md')}\n${read('docs/SELF_HOSTED_REMOTE_MCP.md')}`;
    expect(docs).toContain('Local-only Docker');
    expect(docs).toContain('Authenticated published-port Docker');
    expect(docs).toContain('HTTP_HOST=0.0.0.0');
    expect(docs).toContain('OAUTH_JWKS_URI');
  });
});
