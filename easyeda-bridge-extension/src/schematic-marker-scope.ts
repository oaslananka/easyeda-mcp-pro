import type { ApiRuntime } from './api-runtime.js';
import type { SchematicPrimitiveSnapshot } from './schematic-transaction-operations.js';
import { isRecord } from './utils.js';

type MarkerContext = NonNullable<SchematicPrimitiveSnapshot['nativeContext']>;

export async function readNativeMarkerContext(
  callFirst: ApiRuntime['callFirst'],
  getEasyedaVersion: (() => string | undefined) | undefined,
): Promise<MarkerContext | undefined> {
  // Native focus APIs are optional and may be unavailable in older editor
  // runtimes. Continue the read-only snapshot without authorizing rollback.
  let active: unknown;
  let focused: unknown;
  try {
    active = await callFirst(['DMT_Project.getCurrentProjectInfo']);
    focused = await callFirst(['DMT_SelectControl.getCurrentDocumentInfo']);
  } catch {
    return undefined;
  }
  if (!isRecord(active) || !isRecord(focused)) return undefined;
  const projectId = active.uuid;
  const documentId = focused.uuid;
  const editorVersion = getEasyedaVersion?.();
  if (
    typeof projectId !== 'string' ||
    !projectId ||
    typeof documentId !== 'string' ||
    !documentId ||
    focused.parentProjectUuid !== projectId ||
    focused.documentType !== 1 ||
    editorVersion !== '4.1.105'
  )
    return undefined;
  return { projectId, documentId, editorVersion };
}

export function parseNativeMarkerContext(
  input: unknown,
  invalid: (message: string) => Error,
): MarkerContext | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw invalid('Invalid native marker snapshot context');
  const { projectId, documentId, editorVersion } = input;
  if (
    typeof projectId !== 'string' ||
    !projectId ||
    typeof documentId !== 'string' ||
    !documentId ||
    editorVersion !== '4.1.105'
  )
    throw invalid('Invalid native marker snapshot context');
  return { projectId, documentId, editorVersion };
}

/**
 * An editor-tab switch between the primitive read and its scope verification
 * must never produce a rollback-authorized native snapshot.
 */
export function sameNativeMarkerContext(
  before: MarkerContext,
  after: MarkerContext | undefined,
): boolean {
  return (
    after !== undefined &&
    before.projectId === after.projectId &&
    before.documentId === after.documentId &&
    before.editorVersion === after.editorVersion
  );
}
