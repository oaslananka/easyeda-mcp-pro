import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { EnvSchema } from '../../src/config/env.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerBuiltinTools } from '../../src/tools/register.js';
import {
  createLocalStdioTaskSession,
  resolveLocalStdioTaskPrincipal,
} from '../../src/tasks/task-local-session.js';

// Test process only. No production Tasks registration and no native bridge.
const config = EnvSchema.parse({ NODE_ENV: 'test', TRANSPORT: 'stdio' });
const registry = new ToolRegistry();
registry.setProfile(config.TOOL_PROFILE);
registerBuiltinTools(registry, config);
const localSession = createLocalStdioTaskSession(config, registry);

void serveStdio(
  () => {
    const server = new McpServer(
      { name: 'local-stdio-no-login-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      'fixture_local_stdio_permissions',
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        const principal = resolveLocalStdioTaskPrincipal(localSession, config, registry);
        return {
          content: [
            {
              type: 'text' as const,
              text: principal ? 'local-no-oauth-ready' : 'local-session-denied',
            },
          ],
          structuredContent: {
            hasLocalSession: Boolean(principal),
            allowedReadOnlyOperations: principal?.allowedOperations.size ?? 0,
            tasksEnabled: config.MCP_TASKS_ENABLED,
          },
        };
      },
    );
    return server;
  },
  { legacy: 'serve' },
);
