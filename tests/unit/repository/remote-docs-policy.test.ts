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

  it('routes status claims in every remote document to the canonical page', () => {
    for (const path of [
      'docs/EXTENSION_RELAY_PROTOCOL.md',
      'docs/REMOTE_GATEWAY_DESIGN.md',
      'docs/REMOTE_MCP_MODES.md',
      'docs/REMOTE_MCP_TEST_PLAN.md',
      'docs/REMOTE_OBSERVABILITY.md',
      'docs/REMOTE_RELEASE_READINESS.md',
      'docs/REMOTE_SECURITY_MODEL.md',
      'docs/SELF_HOSTED_REMOTE_MCP.md',
    ]) {
      expect(read(path), path).toContain(
        '[Canonical Remote Relay status](./REMOTE_RELAY_STATUS.md)',
      );
    }
  });

  it('links release, compatibility, and continuity evidence to tracking issues', () => {
    const status = read('docs/REMOTE_RELAY_STATUS.md');
    for (const issue of ['#391', '#392', '#407']) {
      expect(status).toContain(
        `https://github.com/oaslananka/easyeda-mcp-pro/issues/${issue.slice(1)}`,
      );
    }
    expect(read('docs/REMOTE_SECURITY_MODEL.md')).not.toContain(
      'That integration does not exist yet',
    );
  });

  it('distinguishes released Cloud behavior from remaining live acceptance', () => {
    const status = read('docs/REMOTE_RELAY_STATUS.md');
    const modes = read('docs/REMOTE_MCP_MODES.md');
    const guide = read('docs/guide/cloud-ai-connectors.md');

    expect(status).not.toContain('not-yet-released');
    expect(status).toContain('Hosted Cloud 1.17.0');
    expect(status).toContain('issuecomment-7051285101');
    expect(status).toContain('public rollout #850 remains HOLD');
    expect(status).toContain('remembered-device recovery remains unverified');
    expect(modes).not.toContain('the GitHub\nprovider callback');
    expect(guide).not.toContain('#1057 is Draft');
    expect(guide).toContain('[Canonical Remote Relay status](../REMOTE_RELAY_STATUS.md)');
    expect(guide).toContain('MCP OAuth connected does not mean EasyEDA is connected.');
  });

  it('links the canonical status page from VitePress navigation', () => {
    const config = read('docs/.vitepress/config.ts');
    expect(config).toContain("{ text: 'Remote Relay Status', link: '/REMOTE_RELAY_STATUS' }");
  });
});
