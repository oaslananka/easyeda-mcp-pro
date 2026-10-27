import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerReadonlyAppIfEnabled, REVIEW_URI } from '../../../src/server/apps.js';

async function pairedServer(enabled: boolean) {
  const server = new McpServer(
    { name: 'mcp-app-readonly-tests', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerReadonlyAppIfEnabled(server, enabled);
  const client = new Client({ name: 'apps-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe('MCP Apps read-only registration and policy', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [resolve('scripts/build-mcp-apps.mjs')], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
  });

  it('does not expose the App tool or resource while disabled', async () => {
    const { server, client } = await pairedServer(false);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      expect((await client.listResources()).resources).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('serves only offline HTML and a read-only tool when enabled', async () => {
    const { server, client } = await pairedServer(true);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools).toHaveLength(1);
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
      expect(tools[0]?._meta?.ui).toMatchObject({ resourceUri: REVIEW_URI });

      const response = await client.callTool({
        name: 'easyeda_readonly_project_review_app',
        arguments: { projectId: 'test-project' },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toEqual({ projectId: 'test-project' });

      const listed = await client.listResources();
      expect(listed.resources.map((resource) => resource.uri)).toContain(REVIEW_URI);
      const resource = await client.readResource({ uri: REVIEW_URI });
      expect(resource.contents[0]).toMatchObject({ uri: REVIEW_URI });
      const html = resource.contents[0]?.text;
      expect(html).toContain('EasyEDA — read-only project review');
      expect(html).toContain('easyeda_bom_generate');
      expect(html).toContain('easyeda_pcb_components');
      expect(html).toContain('easyeda_erc_run');
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('rejects a missing, oversized or whitespace-padded project identity', async () => {
    const { server, client } = await pairedServer(true);
    try {
      for (const input of [{}, { projectId: ' x ' }, { projectId: 'x'.repeat(129) }]) {
        const response = await client.callTool({
          name: 'easyeda_readonly_project_review_app',
          arguments: input,
        });
        expect(response.isError).toBe(true);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
