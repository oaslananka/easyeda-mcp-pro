import { resolve } from 'node:path';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

type RpcResponse = {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};
const caps = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const standardMeta = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'local-no-login-raw-protocol-test', version: '1' },
  [CLIENT_CAPABILITIES_META_KEY]: { extensions: {} },
};
const withCapabilities = {
  ...standardMeta,
  [CLIENT_CAPABILITIES_META_KEY]: caps,
};

async function fixtureTransport() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve('node_modules/tsx/dist/cli.mjs'),
      'tests/fixtures/task-local-producer-stdio-server.ts',
    ],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: { ...getDefaultEnvironment(), LOG_LEVEL: 'silent' },
  });
  const pending = new Map<number, (response: RpcResponse) => void>();
  let counter = 0;
  transport.onmessage = (message) => {
    const response = message as RpcResponse;
    if (typeof response.id !== 'number') return;
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  };
  await transport.start();
  const request = async (
    method: string,
    params: Record<string, unknown>,
    meta: Record<string, unknown> = withCapabilities,
  ): Promise<RpcResponse> => {
    const id = ++counter;
    const receiving = new Promise<RpcResponse>((resolvePromise) => pending.set(id, resolvePromise));
    await transport.send({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: meta },
    });
    return receiving;
  };
  return { transport, request };
}

describe('2026-07-28 raw-wire Tasks creation via real SDK stdio transport', () => {
  // The current @modelcontextprotocol/client@2.4.0 high-level codec rejects
  // resultType=task. Test the actual on-wire contract without claiming it
  // currently supports high-level task result decoding.
  it('requires client opt-in and returns an immediately queryable durable task result', async () => {
    const { transport, request } = await fixtureTransport();
    try {
      const missing = await request(
        'tools/call',
        {
          name: 'easyeda_bom_generate',
          arguments: { projectId: 'fixture' },
        },
        standardMeta,
      );
      expect(missing.error?.code).toBe(ProtocolErrorCode.MissingRequiredClientCapability);
      const created = await request('tools/call', {
        name: 'easyeda_bom_generate',
        arguments: { projectId: 'fixture' },
      });
      expect(created.result).toMatchObject({
        resultType: 'task',
        taskId: expect.any(String),
        status: 'working',
        ttlMs: 3600000,
      });
      const taskId = created.result!.taskId as string;
      // Immediate post-ack read is guaranteed, even if worker has completed.
      let polled = await request('tasks/get', { taskId });
      expect(['working', 'completed']).toContain(polled.result?.status);
      for (let tries = 0; tries < 20 && polled.result?.status !== 'completed'; tries++) {
        await new Promise((r) => setTimeout(r, 10));
        polled = await request('tasks/get', { taskId });
      }
      expect(polled.result).toMatchObject({
        taskId,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'fixture:easyeda_bom_generate' }] },
      });
      const unauthorizedPoll = await request('tasks/get', { taskId }, standardMeta);
      expect(unauthorizedPoll.error?.code).toBe(ProtocolErrorCode.MissingRequiredClientCapability);
    } finally {
      await transport.close();
    }
  }, 45_000);

  it('refuses write, malformed args and forwards cancellation to the running worker', async () => {
    const { transport, request } = await fixtureTransport();
    try {
      const write = await request('tools/call', {
        name: 'easyeda_pcb_add_track',
        arguments: { projectId: 'hold' },
      });
      expect(write.error?.code).toBe(ProtocolErrorCode.InvalidParams);
      const invalid = await request('tools/call', {
        name: 'easyeda_bom_generate',
        arguments: { projectId: '  ' },
      });
      expect(invalid.error?.code).toBe(ProtocolErrorCode.InvalidParams);
      const created = await request('tools/call', {
        name: 'easyeda_bom_generate',
        arguments: { projectId: 'hold' },
      });
      expect(created.result?.resultType).toBe('task');
      const taskId = created.result!.taskId as string;
      const cancelled = await request('tasks/cancel', { taskId });
      expect(cancelled.error).toBeUndefined();
      let polled = await request('tasks/get', { taskId });
      for (let tries = 0; tries < 20 && polled.result?.status !== 'cancelled'; tries++) {
        await new Promise((r) => setTimeout(r, 10));
        polled = await request('tasks/get', { taskId });
      }
      expect(polled.result?.status).toBe('cancelled');
    } finally {
      await transport.close();
    }
  }, 45_000);
});
