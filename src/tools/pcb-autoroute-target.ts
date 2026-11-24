import type { ToolContext } from './types.js';

interface AutorouteTarget {
  expectedProjectUuid: string;
  expectedPcbUuid: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Caller board data is not native identity evidence. Read the selected tab, not a cached PCB. */
export async function readAutorouteTarget(
  ctx: ToolContext,
  projectId: string,
  expectedPcbUuid?: string,
): Promise<AutorouteTarget | undefined> {
  try {
    if (!ctx.bridge.connected || ctx.bridge.registryMismatch || ctx.bridge.extensionVersionMismatch)
      return undefined;
    const project = record(
      record(
        await ctx.bridge.call('api.read', {
          path: 'DMT_Project.getCurrentProjectInfo',
          args: [],
        }),
      ).result,
    );
    const document = record(
      record(
        await ctx.bridge.call('api.read', {
          path: 'DMT_SelectControl.getCurrentDocumentInfo',
          args: [],
        }),
      ).result,
    );
    if (
      project.uuid !== projectId ||
      document.parentProjectUuid !== projectId ||
      document.documentType !== 3 ||
      typeof document.uuid !== 'string' ||
      !document.uuid.trim() ||
      (expectedPcbUuid !== undefined && document.uuid !== expectedPcbUuid)
    )
      return undefined;
    return { expectedProjectUuid: projectId, expectedPcbUuid: document.uuid };
  } catch {
    return undefined;
  }
}

export async function prepareAutorouteTarget(
  ctx: ToolContext,
  projectId: string,
  expectedPcbUuid?: string,
): Promise<AutorouteTarget | undefined> {
  try {
    const status = record(await ctx.bridge.call('system.getStatus', {}));
    if (status.documentTargetGuard !== true || status.documentProjectGuard !== true)
      return undefined;
    return readAutorouteTarget(ctx, projectId, expectedPcbUuid);
  } catch {
    return undefined;
  }
}

/** The existing dispatcher enforces both identifiers immediately before the native call. */
export function hasAutorouteTargetEvidence(response: unknown, target: AutorouteTarget): boolean {
  const evidence = record(record(response).targetDocument);
  return (
    evidence.uuid === target.expectedPcbUuid &&
    evidence.projectUuid === target.expectedProjectUuid &&
    evidence.documentType === 'pcb' &&
    typeof evidence.name === 'string' &&
    evidence.name.trim().length > 0
  );
}
