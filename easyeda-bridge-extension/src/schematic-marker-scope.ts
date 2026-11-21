import type { ApiRuntime } from './api-runtime.js';
import type { SchematicPrimitiveSnapshot } from './schematic-transaction-operations.js';
import { isRecord } from './utils.js';

type MarkerContext = NonNullable<SchematicPrimitiveSnapshot['nativeContext']>;

export async function readNativeMarkerContext(
  callFirst: ApiRuntime['callFirst'],
  getEasyedaVersion: (() => string | undefined) | undefined,
): Promise<MarkerContext | undefined> {
  const active = await callFirst(['DMT_Project.getCurrentProjectInfo']);
  const focused = await callFirst(['DMT_SelectControl.getCurrentDocumentInfo']);
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
