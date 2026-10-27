import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { DurableTaskStore } from '../../src/tasks/task-store.js';
import { registerTaskStatusHandlers } from '../../src/tasks/task-protocol.js';

// Process-level modern MCP conformance fixture; NEVER imported by product.
const store = new DurableTaskStore(':memory:');
const testRecord = store.create('fixture-owner', 'easyeda_bom_generate', {
  projectId: 'disposable',
});
void serveStdio(
  () => {
    const server = new McpServer(
      { name: 'fixture-modern-tasks-only', version: '1.0.0' },
      { capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } },
    );
    registerTaskStatusHandlers(server, {
      store,
      trustedPrincipal: () => ({
        ownerId: 'fixture-owner',
        allowedOperations: new Set(['easyeda_bom_generate']),
      }),
    });
    server.registerTool(
      'fixture_task_identity',
      { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => ({
        content: [{ type: 'text' as const, text: testRecord.id }],
        structuredContent: { taskId: testRecord.id },
      }),
    );
    return server;
  },
  { legacy: 'reject' },
);
