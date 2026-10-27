import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES_META_KEY, ProtocolErrorCode } from '@modelcontextprotocol/server';

const clientCapabilities = {
  extensions: { 'io.modelcontextprotocol/tasks': {} },
};
const result = z
  .object({
    taskId: z.string(),
    status: z.string(),
  })
  .passthrough();

describe('modern MCP Tasks status-only interoperability', () => {
  it('serves a durable handle only with per-request client capability', async () => {
    const client = new Client(
      { name: 'tasks-wire-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('node_modules/tsx/dist/cli.mjs'),
        'tests/fixtures/task-protocol-stdio-server.ts',
      ],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: { ...getDefaultEnvironment(), LOG_LEVEL: 'silent' },
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      const identity = await client.callTool({
        name: 'fixture_task_identity',
        arguments: {},
      });
      const taskId = (identity.structuredContent as { taskId: string }).taskId;
      await expect(
        client.request({ method: 'tasks/get', params: { taskId } }, result),
      ).rejects.toMatchObject({ code: ProtocolErrorCode.MissingRequiredClientCapability });

      const info = await client.request(
        {
          method: 'tasks/get',
          params: { taskId, _meta: { [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities } },
        },
        result,
      );
      expect(info).toMatchObject({
        taskId,
        status: 'working',
      });
      const cancelled = await client.request(
        {
          method: 'tasks/cancel',
          params: { taskId, _meta: { [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities } },
        },
        z.object({}),
      );
      expect(cancelled).toMatchObject({});
    } finally {
      await client.close();
    }
  }, 45_000);
});
