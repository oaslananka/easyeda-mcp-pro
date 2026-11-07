import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import { isRecord } from './utils.js';

export interface TargetDocumentEvidence {
  uuid: string;
  name?: string;
  documentType: 'pcb' | 'schematic';
}

type ExpectedDocument = { uuid: string; documentType: TargetDocumentEvidence['documentType'] };

type FocusedDocument = {
  uuid: string;
  name?: string;
  documentType: unknown;
  parentProjectUuid: unknown;
};

function parseExpectedDocument(
  params: Record<string, unknown>,
  createBridgeError: BridgeErrorFactory,
): ExpectedDocument | undefined {
  const pcb = params.expectedPcbUuid;
  const page = params.expectedSchematicPageUuid;
  if (pcb === undefined && page === undefined) return undefined;
  if (
    (pcb !== undefined && (typeof pcb !== 'string' || !pcb.trim())) ||
    (page !== undefined && (typeof page !== 'string' || !page.trim())) ||
    (pcb !== undefined && page !== undefined)
  ) {
    throw createBridgeError(
      'INVALID_PARAMS',
      'Specify exactly one non-empty expectedPcbUuid or expectedSchematicPageUuid.',
      'Provide the intended focused document UUID.',
    );
  }
  return pcb !== undefined
    ? { uuid: pcb as string, documentType: 'pcb' }
    : { uuid: page as string, documentType: 'schematic' };
}

function assertTargetSupportsMethod(
  method: string,
  params: Record<string, unknown>,
  expected: ExpectedDocument,
  createBridgeError: BridgeErrorFactory,
): void {
  const accepted = method === 'api.call' || method.startsWith(`${expected.documentType}.`);
  if (!accepted) {
    throw createBridgeError(
      'INVALID_PARAMS',
      `Expected document UUID cannot guard ${method}.`,
      'Use a document-specific write method.',
    );
  }
  if (method !== 'api.call') return;
  const nativePath = typeof params.path === 'string' ? params.path.toUpperCase() : '';
  const wrongDomain = expected.documentType === 'pcb' ? 'SCH_' : 'PCB_';
  if (nativePath.startsWith(wrongDomain)) {
    throw createBridgeError(
      'INVALID_PARAMS',
      `A ${expected.documentType} UUID cannot guard ${String(params.path)}.`,
      'Provide a matching expected document UUID.',
    );
  }
}

async function focusedDocument(
  readFirstPath: ApiRuntime['readFirstPath'],
  createBridgeError: BridgeErrorFactory,
): Promise<FocusedDocument> {
  const selector = readFirstPath<unknown>(['DMT_SelectControl', 'dmt_SelectControl']);
  const project = readFirstPath<unknown>(['DMT_Project', 'dmt_Project']);
  const readDocument = isRecord(selector) ? selector.getCurrentDocumentInfo : undefined;
  const readProject = isRecord(project) ? project.getCurrentProjectInfo : undefined;
  if (typeof readDocument !== 'function' || typeof readProject !== 'function') {
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      'Focused document identity API is unavailable; write refused.',
      'Focus the intended design document in EasyEDA Pro.',
    );
  }
  let selected: unknown;
  let activeProject: unknown;
  try {
    selected = await readDocument.call(selector);
    activeProject = await readProject.call(project);
  } catch {
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      'Could not read focused document identity; write refused.',
      'Focus the intended design document in EasyEDA Pro.',
    );
  }
  const projectUuid = isRecord(activeProject) ? activeProject.uuid : undefined;
  if (
    !isRecord(selected) ||
    typeof selected.uuid !== 'string' ||
    !selected.uuid ||
    typeof projectUuid !== 'string' ||
    !projectUuid ||
    selected.parentProjectUuid !== projectUuid
  ) {
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      'Focused document/project identity is not verifiable; write refused.',
      'Open the expected design document in its project.',
    );
  }
  return {
    uuid: selected.uuid,
    ...(typeof selected.name === 'string' ? { name: selected.name } : {}),
    documentType: selected.documentType,
    parentProjectUuid: selected.parentProjectUuid,
  };
}

/** Primitive IDs may be identical on copied PCBs; verify the caller's selected
 * document against native focus at the extension boundary before a write. */
export async function assertExpectedDocument(
  method: string,
  params: Record<string, unknown>,
  readFirstPath: ApiRuntime['readFirstPath'],
  createBridgeError: BridgeErrorFactory,
): Promise<TargetDocumentEvidence | undefined> {
  const expected = parseExpectedDocument(params, createBridgeError);
  if (!expected) return undefined;
  assertTargetSupportsMethod(method, params, expected, createBridgeError);
  const current = await focusedDocument(readFirstPath, createBridgeError);
  const type = expected.documentType === 'pcb' ? 3 : 1;
  if (current.uuid !== expected.uuid || current.documentType !== type) {
    throw createBridgeError(
      'TARGET_DOCUMENT_MISMATCH',
      `Refusing ${method}: expected ${expected.uuid}, focused ${current.uuid} (${current.name ?? 'unnamed'}).`,
      'Focus the intended document or update the expected UUID after a fresh read.',
      {
        expectedUuid: expected.uuid,
        focusedUuid: current.uuid,
        focusedName: current.name,
        focusedDocumentType: current.documentType,
      },
    );
  }
  return {
    uuid: current.uuid,
    ...(current.name ? { name: current.name } : {}),
    documentType: expected.documentType,
  };
}

export function withTargetDocumentEvidence(
  value: unknown,
  target?: TargetDocumentEvidence,
): unknown {
  return target && isRecord(value) && !Array.isArray(value)
    ? { ...value, targetDocument: target }
    : value;
}
