import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolDefinition } from './types.js';

const projectId = z.string().trim().min(1).max(128);
const documentEvidence = z.object({
  documentId: z.string(),
  type: z.enum(['pcb', 'schematic', 'panel']),
  tabId: z.string().nullable(),
});
const listInput = z.object({});
const listOutput = z.object({
  status: z.string(),
  complete: z.boolean(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      active: z.boolean(),
      open: z.boolean().nullable(),
    }),
  ),
  activeProjectId: z.string().nullable().optional(),
});
const openInput = z.object({
  projectId,
  confirmWrite: z.literal(true),
});
const openOutput = z.object({
  success: z.boolean(),
  status: z.string(),
  projectId: z.string().optional(),
  documents: z.array(documentEvidence).optional(),
});
const closeInput = z.object({
  projectId,
  mode: z.enum(['refuse_if_dirty', 'save', 'discard']).default('refuse_if_dirty'),
  confirmWrite: z.literal(true),
});
const closeOutput = z.object({
  success: z.boolean(),
  status: z.string(),
  projectId: z.string().optional(),
  openTabIds: z.array(z.string()).optional(),
  closedTabs: z.array(z.string()).optional(),
});

function resultOrSafeFailure<T extends z.ZodType>(
  schema: T,
  value: unknown,
  fallback: z.infer<T>,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

async function callWithBoundary(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ctx.bridge.call(method, params);
  } catch {
    // A lost reply after a native write has UNKNOWN outcome.
    // Never expose raw native errors or imply a mutation was rolled back.
    return { success: false, status: 'native_outcome_unknown', projectId: params.projectId };
  }
}

export function registerProjectLifecycleTools(registry: Pick<ToolRegistry, 'register'>): void {
  registry.register({
    name: 'easyeda_project_list',
    title: 'List available EasyEDA projects',
    description:
      'Read team-scoped EasyEDA projects and active identity. Only the active project can be verified open; unknown projects report open=null. No native project or document changes.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'low',
    sideEffect: 'read-only',
    confirmWrite: false,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: listInput,
    outputSchema: listOutput,
    handler: async (ctx: ToolContext) => {
      try {
        const response = await ctx.bridge.call('project.list', {});
        return resultOrSafeFailure(listOutput, response, {
          status: 'native_listing_unverified',
          projects: [],
          complete: false,
        });
      } catch {
        return { status: 'native_listing_unavailable', projects: [], complete: false };
      }
    },
  } satisfies ToolDefinition);

  registry.register({
    name: 'easyeda_project_open',
    title: 'Open a project without losing unsaved work',
    description:
      'Open an EasyEDA project by UUID only when no other document is open. Requires explicit write confirmation and read-back of active project. Never silently switches away from an open document.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'medium',
    sideEffect: 'local-state-write',
    confirmWrite: true,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: openInput,
    outputSchema: openOutput,
    handler: async (ctx: ToolContext, raw: unknown) => {
      const input = openInput.parse(raw);
      const result = await callWithBoundary(ctx, 'project.open', input);
      return resultOrSafeFailure(openOutput, result, {
        success: false,
        status: 'native_outcome_unverified',
        projectId: input.projectId,
      });
    },
  } satisfies ToolDefinition);

  registry.register({
    name: 'easyeda_project_close',
    title: 'Safely close EasyEDA project documents',
    description:
      'Default refuses when dirty status is unknown. Explicit confirmed save first verifies native save then closes; explicit discard is destructive. Never silently discards unsaved documents.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'high',
    sideEffect: 'design-mutation',
    confirmWrite: true,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: closeInput,
    outputSchema: closeOutput,
    handler: async (ctx: ToolContext, raw: unknown) => {
      const input = closeInput.parse(raw);
      const result = await callWithBoundary(ctx, 'project.close', input);
      return resultOrSafeFailure(closeOutput, result, {
        success: false,
        status: 'native_outcome_unverified',
        projectId: input.projectId,
      });
    },
  } satisfies ToolDefinition);
}
