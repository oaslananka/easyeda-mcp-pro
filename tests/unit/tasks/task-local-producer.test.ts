import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { EnvSchema } from '../../../src/config/env.js';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import {
  createLocalStdioTaskSession,
  resolveLocalStdioTaskPrincipal,
} from '../../../src/tasks/task-local-session.js';
import {
  createLocalTaskFromToolCall,
  type LocalTaskProducerDependencies,
} from '../../../src/tasks/task-local-producer.js';
import { DurableReadOnlyTaskRunner } from '../../../src/tasks/task-runner.js';
import { DurableTaskStore } from '../../../src/tasks/task-store.js';

const requestContext = (enabled = true, modern = true) =>
  ({
    mcpReq: {
      envelope: {
        [PROTOCOL_VERSION_META_KEY]: modern ? '2026-07-28' : '2025-11-25',
        [CLIENT_CAPABILITIES_META_KEY]: {
          extensions: enabled ? { 'io.modelcontextprotocol/tasks': {} } : {},
        },
      },
    },
  }) as unknown as ServerContext;

function fixture(overrides: Record<string, string> = {}) {
  const config = EnvSchema.parse({ NODE_ENV: 'test', TRANSPORT: 'stdio', ...overrides });
  const registry = new ToolRegistry();
  registry.setProfile('core');
  registerBuiltinTools(registry, config);
  const session = createLocalStdioTaskSession(config, registry);
  const store = new DurableTaskStore(':memory:');
  let executed = 0;
  const runner = new DurableReadOnlyTaskRunner(store, async () => {
    executed++;
    return { content: [{ type: 'text', text: 'mock read only' }] };
  });
  const deps: LocalTaskProducerDependencies = { registry, config, session, store, runner };
  const call = (
    name = 'easyeda_bom_generate',
    args: Record<string, unknown> = { projectId: 'fixture' },
    ctx = requestContext(),
  ) => createLocalTaskFromToolCall(deps, { name, arguments: args }, ctx);
  return { deps, store, runner, call, executed: () => executed };
}

describe('local no-OAuth 2026 Tasks producer, staging only', () => {
  it('commits task before acknowledging a handle and queues only read operations', async () => {
    const f = fixture();
    try {
      const result = f.call();
      expect(result).toMatchObject({
        resultType: 'task',
        status: 'working',
        taskId: expect.any(String),
      });
      const identity = resolveLocalStdioTaskPrincipal(
        f.deps.session,
        f.deps.config,
        f.deps.registry,
      )!;
      const entry = f.store.list(identity.ownerId)[0];
      expect(entry?.id).toBe(result.taskId);
      expect(['working', 'completed']).toContain(entry?.status);
      await vi.waitFor(() =>
        expect(f.store.get(identity.ownerId, result.taskId)?.status).toBe('completed'),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.executed()).toBe(1);
    } finally {
      f.runner.stop();
      f.store.close();
    }
  });

  it('denies legacy or missing Tasks opt-in before creating a task', () => {
    const f = fixture();
    try {
      expect(() =>
        f.call('easyeda_bom_generate', { projectId: 'fixture' }, requestContext(false)),
      ).toThrowError(
        expect.objectContaining({ code: ProtocolErrorCode.MissingRequiredClientCapability }),
      );
      expect(() =>
        f.call('easyeda_bom_generate', { projectId: 'fixture' }, requestContext(true, false)),
      ).toThrowError(expect.objectContaining({ code: ProtocolErrorCode.MethodNotFound }));
      expect(f.executed()).toBe(0);
    } finally {
      f.runner.stop();
      f.store.close();
    }
  });

  it('rejects unallowlisted writes, remote approval parameters, invalid input and missing project ID', () => {
    const f = fixture();
    try {
      for (const [name, args] of [
        ['easyeda_pcb_add_track', { projectId: 'fixture' }],
        ['easyeda_bom_generate', { projectId: 'fixture', writeMode: 'apply' }],
        ['easyeda_bom_generate', { projectId: 'fixture', ownerId: 'forged' }],
        ['easyeda_bom_generate', { projectId: '' }],
        ['easyeda_bom_generate', { projectId: 'fixture', format: 'invalid' }],
      ] as const) {
        expect(() => f.call(name, args)).toThrow();
      }
      expect(f.executed()).toBe(0);
    } finally {
      f.runner.stop();
      f.store.close();
    }
  });

  it('rejects fake process session and current HTTP/Relay/scope changes without a task', () => {
    const f = fixture();
    try {
      f.deps.session = { mode: 'stdio' };
      expect(() => f.call()).toThrow('Task not authorized');
      f.deps.session = createLocalStdioTaskSession(f.deps.config, f.deps.registry);
      f.deps.config = { ...f.deps.config, TRANSPORT: 'http' };
      expect(() => f.call()).toThrow('Task not authorized');
      f.deps.config = { ...f.deps.config, TRANSPORT: 'stdio', MCP_BRIDGE_BACKEND: 'remote_relay' };
      expect(() => f.call()).toThrow('Task not authorized');
      f.deps.config = {
        ...f.deps.config,
        MCP_BRIDGE_BACKEND: 'local_bridge',
        TOOL_SCOPES: 'pcb:read',
      };
      expect(() => f.call()).toThrow('Task not authorized');
      expect(f.executed()).toBe(0);
    } finally {
      f.runner.stop();
      f.store.close();
    }
  });
});
