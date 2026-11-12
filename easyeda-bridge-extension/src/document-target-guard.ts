import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import { isRecord } from './utils.js';
import { documentIdentity } from './zone-outline-evidence.js';

export interface TargetDocumentEvidence {
  uuid: string;
  name: string;
  documentType: 'pcb' | 'schematic';
  projectUuid?: string;
}

type ExpectedDocument = {
  uuid: string;
  documentType: TargetDocumentEvidence['documentType'];
  projectUuid?: string;
};

type FocusedDocument = {
  uuid: string;
  name?: string;
  documentType: unknown;
  parentProjectUuid: unknown;
};

function parseExpectedProject(
  project: unknown,
  createBridgeError: BridgeErrorFactory,
): string | undefined {
  if (project === undefined) return undefined;
  if (typeof project !== 'string' || !project.trim()) {
    throw createBridgeError(
      'INVALID_PARAMS',
      'Expected project UUID must be a non-empty string.',
      'Provide the exact owning project UUID.',
    );
  }
  return project;
}

function parseDocumentUuid(
  pcb: unknown,
  page: unknown,
  createBridgeError: BridgeErrorFactory,
): ExpectedDocument | undefined {
  if (pcb === undefined && page === undefined) return undefined;
  const uuid = pcb !== undefined ? pcb : page;
  if ((pcb !== undefined && page !== undefined) || typeof uuid !== 'string' || !uuid.trim()) {
    throw createBridgeError(
      'INVALID_PARAMS',
      'Specify exactly one non-empty expectedPcbUuid or expectedSchematicPageUuid.',
      'Provide the intended focused document UUID.',
    );
  }
  return { uuid, documentType: pcb !== undefined ? 'pcb' : 'schematic' };
}

function parseExpectedDocument(
  params: Record<string, unknown>,
  createBridgeError: BridgeErrorFactory,
): ExpectedDocument | undefined {
  const document = parseDocumentUuid(
    params.expectedPcbUuid,
    params.expectedSchematicPageUuid,
    createBridgeError,
  );
  const project = parseExpectedProject(params.expectedProjectUuid, createBridgeError);
  if (!document) {
    if (project !== undefined) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'Project expectation requires an expected PCB or schematic document UUID.',
        'Provide both intended project and document identifiers.',
      );
    }
    return undefined;
  }
  return { ...document, ...(project !== undefined ? { projectUuid: project } : {}) };
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

/** The native focused-document getter exposes identity but not a display name in
 * EasyEDA Pro 3.2.209. Resolve the focused PCB/page name from its owning DMT
 * class and cross-check it against the already verified selected document.
 * A stale or unavailable metadata getter must not turn into a best-effort write. */
async function verifiedFocusedName(
  current: FocusedDocument,
  kind: TargetDocumentEvidence['documentType'],
  readFirstPath: ApiRuntime['readFirstPath'],
  createBridgeError: BridgeErrorFactory,
): Promise<string> {
  const pcb = kind === 'pcb';
  const api = readFirstPath<unknown>(
    pcb ? ['DMT_Pcb', 'dmt_Pcb'] : ['DMT_Schematic', 'dmt_Schematic'],
  );
  const method = pcb ? 'getCurrentPcbInfo' : 'getCurrentSchematicPageInfo';
  const getter = isRecord(api) ? api[method] : undefined;
  if (typeof getter !== 'function') {
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      `Focused ${kind} name API is unavailable; write refused.`,
      `Focus the intended ${kind} document in EasyEDA Pro.`,
    );
  }
  let native: unknown;
  try {
    native = await getter.call(api);
  } catch {
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      `Focused ${kind} metadata could not be read; write refused.`,
      'Reload the intended document and retry.',
    );
  }
  if (
    !isRecord(native) ||
    native.uuid !== current.uuid ||
    (typeof native.parentProjectUuid === 'string' &&
      native.parentProjectUuid !== current.parentProjectUuid) ||
    typeof native.name !== 'string' ||
    !native.name.trim()
  ) {
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      `Focused ${kind} name/identity could not be cross-verified; write refused.`,
      'Read the focused document and project again before retrying.',
    );
  }
  return native.name;
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
  if (expected.projectUuid !== undefined && current.parentProjectUuid !== expected.projectUuid) {
    throw createBridgeError(
      'TARGET_PROJECT_MISMATCH',
      'Refusing operation: the focused document belongs to a different project.',
      'Open the expected EasyEDA project and recheck its focused document.',
    );
  }
  const type = expected.documentType === 'pcb' ? 3 : 1;
  const name = await verifiedFocusedName(
    current,
    current.documentType === 3 ? 'pcb' : 'schematic',
    readFirstPath,
    createBridgeError,
  );
  if (current.uuid !== expected.uuid || current.documentType !== type) {
    throw createBridgeError(
      'TARGET_DOCUMENT_MISMATCH',
      `Refusing ${method}: expected ${expected.uuid}, focused ${current.uuid} (${name}).`,
      'Focus the intended document or update the expected UUID after a fresh read.',
      {
        expectedUuid: expected.uuid,
        focusedUuid: current.uuid,
        focusedName: name,
        focusedDocumentType: current.documentType,
      },
    );
  }
  return {
    uuid: current.uuid,
    name,
    documentType: expected.documentType,
    ...(expected.projectUuid !== undefined
      ? { projectUuid: current.parentProjectUuid as string }
      : {}),
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

/** Recheck the same private project+PCB key after awaiting a native read-only zone
 * preflight. This is focus continuity evidence, never a saved PCB revision. */
export async function withGuardedZonePreflight<T>(
  method: string,
  params: Record<string, unknown>,
  target: TargetDocumentEvidence | undefined,
  readFirstPath: ApiRuntime['readFirstPath'],
  createBridgeError: BridgeErrorFactory,
  inspect: () => Promise<T>,
): Promise<T> {
  if (method !== 'pcb.zonePreflight' || !target) return inspect();
  const failedFocus = () =>
    createBridgeError(
      'TARGET_CONTEXT_CHANGED',
      'The focused PCB/project changed or could not be verified during zone inspection.',
      'Focus the intended PCB and repeat the read-only preview. No write attempted.',
    );
  const before = await documentIdentity(readFirstPath).catch(() => undefined);
  if (!before) throw failedFocus();
  const response = await inspect();
  const after = await documentIdentity(readFirstPath).catch(() => undefined);
  if (!after || before !== after) throw failedFocus();
  let verified: TargetDocumentEvidence | undefined;
  try {
    verified = await assertExpectedDocument(method, params, readFirstPath, createBridgeError);
  } catch {
    // Native focus failures may contain private document identifiers.
    throw failedFocus();
  }
  if (
    !verified ||
    verified.uuid !== target.uuid ||
    verified.documentType !== target.documentType ||
    verified.projectUuid !== target.projectUuid ||
    verified.name !== target.name
  ) {
    throw failedFocus();
  }
  return response;
}
