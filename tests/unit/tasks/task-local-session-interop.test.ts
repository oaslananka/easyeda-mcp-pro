import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

describe('real SDK stdio local Tasks identity without login', () => {
  it('can derive local read-only session permissions without OAuth or token headers', async () => {
    const client = new Client(
      { name: 'local-no-login-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('node_modules/tsx/dist/cli.mjs'), 'tests/fixtures/task-local-stdio-server.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        TRANSPORT: 'stdio',
        MCP_BRIDGE_BACKEND: 'local_bridge',
        MCP_TASKS_ENABLED: 'false',
        LOG_LEVEL: 'silent',
      },
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain('fixture_local_stdio_permissions');
      const result = await client.callTool({
        name: 'fixture_local_stdio_permissions',
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        hasLocalSession: true,
        allowedReadOnlyOperations: 2,
        tasksEnabled: false,
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  }, 45_000);
});
