import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_URI } from '../../../src/server/apps.js';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');

async function runAppCase(modern: boolean, enabled: boolean) {
  const client = new Client(
    { name: 'apps-interoperability-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, 'src/index.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      TRANSPORT: 'stdio',
      MCP_BRIDGE_BACKEND: 'remote_relay',
      MCP_V2_EXPERIMENTAL: String(modern),
      MCP_APPS_ENABLED: String(enabled),
      TOOL_PROFILE: 'core',
      LOG_LEVEL: 'silent',
    },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const app = tools.tools.find((tool) => tool.name === 'easyeda_readonly_project_review_app');
    if (!enabled) {
      expect(app).toBeUndefined();
      return;
    }
    expect(app?._meta?.ui).toMatchObject({ resourceUri: REVIEW_URI });
    const result = await client.callTool({
      name: 'easyeda_readonly_project_review_app',
      arguments: { projectId: 'disposable-project-id' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ projectId: 'disposable-project-id' });
    const resource = await client.readResource({ uri: REVIEW_URI });
    const html = resource.contents[0]?.text;
    expect(typeof html).toBe('string');
    expect(html).toContain('EasyEDA — read-only project review');
    expect(html).toContain('easyeda_bom_generate');
    expect(html).toContain('easyeda_pcb_components');
    expect(html).toContain('easyeda_erc_run');
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/i);
    if (modern) expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
  } finally {
    await client.close();
  }
}

describe('MCP Apps sandboxed review process interoperability', () => {
  // CI runs unit tests before package:prepare. Build the test asset from source
  // rather than relying on an ignored dist directory from a developer machine.
  beforeAll(() => {
    execFileSync(process.execPath, [resolve('scripts/build-mcp-apps.mjs')], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
  });

  it('serves a sandboxed review view on MCP 2026-07-28', async () => {
    await runAppCase(true, true);
  }, 35_000);
  it('serves the same view on legacy MCP without replacing transport', async () => {
    await runAppCase(false, true);
  }, 35_000);
  it('does not register any UI surface by default', async () => {
    await runAppCase(false, false);
  }, 35_000);
});
