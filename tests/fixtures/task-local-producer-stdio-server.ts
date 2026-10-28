import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { EnvSchema } from '../../src/config/env.js';
import { registerBuiltinTools } from '../../src/tools/register.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { DurableReadOnlyTaskRunner } from '../../src/tasks/task-runner.js';
import { DurableTaskStore } from '../../src/tasks/task-store.js';
import { createLocalStdioTaskSession } from '../../src/tasks/task-local-session.js';
import { registerStagedLocalTaskProducer } from '../../src/tasks/task-local-producer.js';

// A completely simulated and isolated modern MCP subprocess. No native
// EasyEDA bridge connection or production server registration.
const config = EnvSchema.parse({
  NODE_ENV: 'test',
  TRANSPORT: 'stdio',
  MCP_BRIDGE_BACKEND: 'local_bridge',
  MCP_TASKS_ENABLED: false,
});
const registry = new ToolRegistry();
registry.setProfile('core');
registerBuiltinTools(registry, config);
const session = createLocalStdioTaskSession(config, registry);
const store = new DurableTaskStore(':memory:');
const runner = new DurableReadOnlyTaskRunner(store, async (operation, args, signal) => {
  if ((args as { projectId: string }).projectId === 'hold') {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(new Error('test-cancelled'));
      else
        signal.addEventListener('abort', () => reject(new Error('test-cancelled')), { once: true });
    });
  }
  return { content: [{ type: 'text' as const, text: 'fixture:' + operation }] };
});

void serveStdio(
  () => {
    const server = new McpServer(
      { name: 'local-tasks-test-fixture', version: '1.0.0' },
      { capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } },
    );
    // The SDK uses these registrations for tools/list, while the staging
    // custom protocol handler (below) owns tools/call in this fixture only.
    server.registerTool(
      'easyeda_bom_generate',
      { inputSchema: z.object({ projectId: z.string() }), annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text' as const, text: 'sync-fixture' }] }),
    );
    registerStagedLocalTaskProducer(server, { config, registry, session, store, runner });
    return server;
  },
  { legacy: 'reject' },
);
