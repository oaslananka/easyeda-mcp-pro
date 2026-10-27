import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const REVIEW_URI = 'ui://easyeda/read-only-project-review';
const VIEW_ASSET = fileURLToPath(new URL('../../dist/apps/project-review.html', import.meta.url));

export function registerReadonlyAppIfEnabled(server: McpServer, enabled: boolean): void {
  if (!enabled) return;

  // Intentionally no bridge access. The view must use the preexisting ToolRegistry
  // registered read-only tools, which enforce OAuth, scope and Remote Relay policy.
  registerAppTool(
    server,
    'easyeda_readonly_project_review_app',
    {
      title: 'Read-only PCB/BOM/ERC review panel',
      description:
        'Open a sandboxed, read-only EasyEDA project review UI; projectId is only echoed. Reports are fetched via existing approved tools.',
      inputSchema: z.object({
        projectId: z
          .string()
          .min(1)
          .max(128)
          .refine((s) => s.trim() === s),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { resourceUri: REVIEW_URI } },
    },
    async ({ projectId }) => ({
      content: [
        { type: 'text' as const, text: 'Read-only review panel ready for requested project.' },
      ],
      structuredContent: { projectId },
    }),
  );

  registerAppResource(
    server,
    REVIEW_URI,
    REVIEW_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: REVIEW_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(VIEW_ASSET, 'utf8'),
        },
      ],
    }),
  );
}
