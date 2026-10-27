import { describe, expect, it, vi } from 'vitest';
import {
  ProtocolErrorCode,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { DurableTaskStore, type SafeTaskOperation } from '../../../src/tasks/task-store.js';
import { registerTaskStatusHandlers, toTaskGetResponse } from '../../../src/tasks/task-protocol.js';

type Handler = (
  params: { taskId: string; inputResponses?: Record<string, unknown> },
  ctx: ServerContext,
) => Promise<unknown>;

const modern = (supports: boolean): ServerContext =>
  ({
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: supports ? { 'io.modelcontextprotocol/tasks': {} } : {},
        },
      },
    },
  }) as unknown as ServerContext;
const legacy = { mcpReq: { envelope: undefined } } as unknown as ServerContext;

function fixture() {
  const store = new DurableTaskStore(':memory:');
  const handlers = new Map<string, Handler>();
  const server = {
    server: {
      setRequestHandler: vi.fn((method: string, _schemas: unknown, handler: Handler) => {
        handlers.set(method, handler);
      }),
    },
  } as unknown as McpServer;
  let owner = 'alice';
  let allowed: SafeTaskOperation[] = ['easyeda_bom_generate'];
  registerTaskStatusHandlers(server, {
    store,
    trustedPrincipal: () =>
      owner ? { ownerId: owner, allowedOperations: new Set(allowed) } : undefined,
  });
  async function call(method: string, id: string, ctx = modern(true)) {
    const handler = handlers.get(method);
    if (!handler) throw new Error('missing handler');
    return handler({ taskId: id, inputResponses: {} }, ctx);
  }
  return {
    store,
    handlers,
    call,
    owner: (o: string) => {
      owner = o;
    },
    allowed: (ops: SafeTaskOperation[]) => {
      allowed = ops;
    },
  };
}

describe('2026 Tasks polling adapter - deliberately unregistered in production', () => {
  it('installs only get/update/cancel, never tool interception or legacy list', () => {
    const test = fixture();
    expect([...test.handlers.keys()].sort()).toEqual(['tasks/cancel', 'tasks/get', 'tasks/update']);
    test.store.close();
  });

  it('gets existing durable tasks; handles cooperative cancellation, completion and terminal immutability', async () => {
    const test = fixture();
    try {
      const pending = test.store.create('alice', 'easyeda_bom_generate', {});
      expect(await test.call('tasks/get', pending.id)).toMatchObject({
        resultType: 'complete',
        taskId: pending.id,
        status: 'working',
        ttlMs: 3600000,
        pollIntervalMs: 1500,
      });
      expect(await test.call('tasks/update', pending.id)).toEqual({ resultType: 'complete' });
      expect(await test.call('tasks/cancel', pending.id)).toEqual({ resultType: 'complete' });
      expect(test.store.get('alice', pending.id)?.cancelRequested).toBe(true);
      expect(test.store.markCancelled('alice', pending.id)).toBe(true);
      expect(await test.call('tasks/get', pending.id)).toMatchObject({ status: 'cancelled' });
      const done = test.store.create('alice', 'easyeda_bom_generate', {});
      expect(test.store.finish('alice', done.id, { content: [{ type: 'text', text: 'ok' }] })).toBe(
        true,
      );
      expect(await test.call('tasks/get', done.id)).toMatchObject({
        status: 'completed',
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
      expect(await test.call('tasks/cancel', done.id)).toEqual({ resultType: 'complete' });
      expect(test.store.get('alice', done.id)?.status).toBe('completed');
    } finally {
      test.store.close();
    }
  });

  it('rejects a missing per-request Tasks capability for all methods and fails closed for legacy', async () => {
    const test = fixture();
    try {
      const item = test.store.create('alice', 'easyeda_bom_generate', {});
      for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
        await expect(test.call(method, item.id, modern(false))).rejects.toMatchObject({
          code: ProtocolErrorCode.MissingRequiredClientCapability,
        });
        await expect(test.call(method, item.id, legacy)).rejects.toMatchObject({
          code: ProtocolErrorCode.MethodNotFound,
        });
      }
      expect(test.store.get('alice', item.id)?.cancelRequested).toBe(false);
    } finally {
      test.store.close();
    }
  });

  it('enforces owner and current operation scope on every action, hiding task existence', async () => {
    const test = fixture();
    try {
      const item = test.store.create('alice', 'easyeda_bom_generate', {});
      test.owner('bob');
      await expect(test.call('tasks/get', item.id)).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
      test.owner('alice');
      test.allowed(['easyeda_pcb_components']);
      for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
        await expect(test.call(method, item.id)).rejects.toMatchObject({
          code: ProtocolErrorCode.InvalidParams,
        });
      }
      expect(test.store.get('alice', item.id)?.cancelRequested).toBe(false);
      test.owner('');
      await expect(test.call('tasks/get', item.id)).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    } finally {
      test.store.close();
    }
  });

  it('rejects unknown task IDs and malformed completed tool results', async () => {
    const test = fixture();
    try {
      await expect(
        test.call('tasks/get', '11111111-1111-4111-8111-111111111111'),
      ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
      const item = test.store.create('alice', 'easyeda_bom_generate', {});
      test.store.finish('alice', item.id, { bad: 'not a CallToolResult' });
      expect(() => toTaskGetResponse(test.store.get('alice', item.id)!)).toThrow(
        'Malformed persisted tool result',
      );
    } finally {
      test.store.close();
    }
  });
});
