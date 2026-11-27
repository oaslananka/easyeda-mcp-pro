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
  errorCode: z.string().optional(),
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
  errorCode: z.string().optional(),
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
  errorCode: z.string().optional(),
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

const activateInput = z.object({ projectId, documentId: z.string().trim().min(1).max(128) });
const activateOutput = z.object({
  success: z.boolean(),
  status: z.string(),
  errorCode: z.string().optional(),
  projectId: z.string().optional(),
  documentId: z.string().optional(),
  type: z.enum(['pcb', 'schematic']).optional(),
  tabId: z.string().optional(),
});
const createInput = z.object({
  friendlyName: z.string().trim().min(1).max(120),
  projectName: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .max(120)
    .optional(),
  description: z.string().max(500).optional(),
  open: z.boolean().default(true),
  confirmWrite: z.literal(true),
});
const createOutput = z.object({
  success: z.boolean(),
  status: z.string(),
  errorCode: z.string().optional(),
  projectId: z.string().optional(),
  documents: z.array(documentEvidence).optional(),
});
const importInput = z.object({ projectId, confirmWrite: z.literal(true) });
const importOutput = z.object({
  success: z.boolean(),
  status: z.string(),
  errorCode: z.string().optional(),
  projectId: z.string().optional(),
  pcbId: z.string().optional(),
  schematicId: z.string().optional(),
});

/** A forced schematic-to-PCB import waits for EasyEDA to finish; allow more than a plain call. */
const IMPORT_TIMEOUT_MS = 5 * 60 * 1000;
/** Creating and opening a project waits for EasyEDA to build the default board. */
const CREATE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Surface only the structured bridge error code (for example EXTENSION_VERSION_MISMATCH or
 * METHOD_NOT_FOUND). Messages stay hidden because native errors can carry local paths.
 */
function bridgeErrorCode(error: unknown): { errorCode?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
    ? { errorCode: code }
    : { errorCode: 'BRIDGE_ERROR' };
}

function callWithBoundary(
  ctx: ToolContext,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  // Handle both a synchronous bridge exception and an asynchronous lost reply.
  // Either outcome remains UNKNOWN: never retry or claim a native rollback.
  return Promise.resolve()
    .then(() =>
      timeoutMs === undefined
        ? ctx.bridge.call(method, params)
        : ctx.bridge.call(method, params, { timeoutMs }),
    )
    .catch((error: unknown) => ({
      success: false,
      status: 'native_outcome_unknown',
      ...bridgeErrorCode(error),
      projectId: params.projectId,
    }));
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
      } catch (error) {
        return {
          status: 'native_listing_unavailable',
          projects: [],
          complete: false,
          ...bridgeErrorCode(error),
        };
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
    name: 'easyeda_document_activate',
    title: 'Activate a document of the active project',
    description:
      'Open if needed and focus one schematic page or PCB of the active project by document UUID, then verify the focus by read-back. Changes only UI focus, never design data.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'low',
    sideEffect: 'local-state-write',
    confirmWrite: false,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: activateInput,
    outputSchema: activateOutput,
    handler: async (ctx: ToolContext, raw: unknown) => {
      const input = activateInput.parse(raw);
      const result = await callWithBoundary(ctx, 'document.activate', input);
      return resultOrSafeFailure(activateOutput, result, {
        success: false,
        status: 'native_outcome_unverified',
        projectId: input.projectId,
        documentId: input.documentId,
      });
    },
  } satisfies ToolDefinition);

  registry.register({
    name: 'easyeda_project_create',
    title: 'Create and open a new EasyEDA project',
    description:
      'Create a project and, by default, open it once EasyEDA has built its default board (schematic + PCB). Opening is refused while other documents may hold unsaved edits.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'medium',
    sideEffect: 'local-state-write',
    confirmWrite: true,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: createInput,
    outputSchema: createOutput,
    handler: async (ctx: ToolContext, raw: unknown) => {
      const input = createInput.parse(raw);
      const result = await callWithBoundary(ctx, 'project.create', input, CREATE_TIMEOUT_MS);
      return resultOrSafeFailure(createOutput, result, {
        success: false,
        status: 'native_outcome_unverified',
      });
    },
  } satisfies ToolDefinition);

  registry.register({
    name: 'easyeda_pcb_import_from_schematic',
    title: 'Update the focused PCB from its schematic',
    description:
      'Import schematic changes into the focused PCB of the active project without the confirmation dialog (PCB_Document.importChanges with force). Run DRC afterwards: new nets arrive unrouted.',
    profile: 'pro',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'high',
    sideEffect: 'design-mutation',
    confirmWrite: true,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: importInput,
    outputSchema: importOutput,
    handler: async (ctx: ToolContext, raw: unknown) => {
      const input = importInput.parse(raw);
      const result = await callWithBoundary(
        ctx,
        'pcb.importFromSchematic',
        input,
        IMPORT_TIMEOUT_MS,
      );
      return resultOrSafeFailure(importOutput, result, {
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
      'Default refuses when dirty status is unknown. Explicit confirmed save-and-close requires a trusted native save; schematic pages with unverified durable persistence fail closed instead of risking data loss. Explicit discard is destructive.',
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
