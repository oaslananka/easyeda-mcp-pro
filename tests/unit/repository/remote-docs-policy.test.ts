import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('Remote Relay documentation policy', () => {
  it('publishes one canonical implementation-status page', () => {
    const status = read('docs/REMOTE_RELAY_STATUS.md');

    expect(status).toContain('# Remote Relay implementation status');
    expect(status).toContain('Canonical status source');
    expect(status).toContain('Current maturity: Experimental');
    expect(status).toContain('Hosted service deployment');
    expect(status).toContain('Live EasyEDA relay dogfood');
  });

  it('routes status claims in older documents to the canonical page', () => {
    for (const path of [
      'docs/REMOTE_GATEWAY_DESIGN.md',
      'docs/REMOTE_MCP_MODES.md',
      'docs/REMOTE_RELEASE_READINESS.md',
      'docs/SELF_HOSTED_REMOTE_MCP.md',
    ]) {
      expect(read(path), path).toContain(
        '[Canonical Remote Relay status](./REMOTE_RELAY_STATUS.md)',
      );
    }
  });

  it('links the canonical status page from VitePress navigation', () => {
    const config = read('docs/.vitepress/config.ts');
    expect(config).toContain("{ text: 'Remote Relay Status', link: '/REMOTE_RELAY_STATUS' }");
  });
});
