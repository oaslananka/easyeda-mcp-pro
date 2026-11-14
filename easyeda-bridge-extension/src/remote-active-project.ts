import { isRecord, readPath } from './utils.js';
import type { RemoteActiveProject } from './remote-client.js';

/** UI names never establish project authorization; only native UUIDs do. */
function displayName(project: Record<string, unknown>): string | undefined {
  for (const value of [project.friendlyName, project.name]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function focusedIdentity(project: unknown, document: unknown): RemoteActiveProject | undefined {
  if (!isRecord(project) || !isRecord(document)) return undefined;
  if (
    typeof project.uuid !== 'string' ||
    !project.uuid ||
    typeof document.uuid !== 'string' ||
    !document.uuid ||
    document.parentProjectUuid !== project.uuid
  )
    return undefined;

  const documentType =
    document.documentType === 3 ? 'pcb' : document.documentType === 1 ? 'schematic' : undefined;
  if (!documentType) return undefined;
  return {
    projectId: project.uuid,
    documentId: document.uuid,
    projectName: displayName(project),
    documentType,
  };
}

/**
 * Preview-only EasyEDA focus APIs. Never derive a hosted Cloud authorization
 * boundary from a window title or shared editor URL.
 *
 * The native focus APIs are optional in older editor versions. Missing or
 * inconsistent identity therefore means "not selectable", not "the last tab".
 */
export async function readNativeRemoteActiveProject(
  root: unknown,
): Promise<RemoteActiveProject | undefined> {
  const projectApi =
    readPath<Record<string, unknown>>(root, 'dmt_Project') ??
    readPath<Record<string, unknown>>(root, 'DMT_Project');
  const documentApi =
    readPath<Record<string, unknown>>(root, 'dmt_SelectControl') ??
    readPath<Record<string, unknown>>(root, 'DMT_SelectControl');
  if (
    typeof projectApi?.getCurrentProjectInfo !== 'function' ||
    typeof documentApi?.getCurrentDocumentInfo !== 'function'
  )
    return undefined;
  try {
    const project = (await projectApi.getCurrentProjectInfo.call(projectApi)) as unknown;
    const document = (await documentApi.getCurrentDocumentInfo.call(documentApi)) as unknown;
    return focusedIdentity(project, document);
  } catch {
    // Beta native APIs may be absent or throw: do not authorize an ambiguous tab.
    return undefined;
  }
}
