import type {
  SchematicPrimitiveSnapshot,
  SchematicPrimitiveSnapshotKind,
} from './schematic-transaction-operations.js';
import { isRecord } from './utils.js';

type NativeScope = { projectId: string; documentId: string };
type BridgeError = (code: string, message: string, suggestion: string) => Error;

interface DeleteGuardDependencies {
  parseSnapshot(input: unknown): SchematicPrimitiveSnapshot;
  getSnapshot(
    primitiveId: string,
    kind: SchematicPrimitiveSnapshotKind,
  ): Promise<SchematicPrimitiveSnapshot>;
  callFirst(paths: readonly string[]): Promise<unknown>;
  createBridgeError: BridgeError;
}

const TRANSACTIONAL_DRAWING_KINDS = new Set<string>([
  'wire',
  'text',
  'rectangle',
  'circle',
  'polygon',
]);

/** Compare native snapshots without relying on JSON object property order. */
function canonicalJsonSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'undefined':
      return null;
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Non-finite snapshot value');
      return value;
    case 'object':
      break;
    default:
      throw new Error('Unsupported snapshot value');
  }
  if (seen.has(value)) throw new Error('Circular snapshot');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalJsonSnapshot(item, seen));
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('Unsafe snapshot key');
      }
      // Native optional fields are omitted by the JSON bridge transport.
      if (record[key] !== undefined) normalized[key] = canonicalJsonSnapshot(record[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function witnessedSnapshotMatches(
  expected: SchematicPrimitiveSnapshot,
  actual: SchematicPrimitiveSnapshot,
): boolean {
  try {
    return (
      JSON.stringify(canonicalJsonSnapshot(expected)) ===
      JSON.stringify(canonicalJsonSnapshot(actual))
    );
  } catch {
    return false;
  }
}

function refusal(createBridgeError: BridgeError, reason: string): never {
  throw createBridgeError(
    'NATIVE_DELETE_PRECONDITION_CHANGED',
    'Native transactional delete refused: ' + reason,
    'Reinspect the focused schematic, project and primitive before retrying.',
  );
}

function validateScope(
  scope: NativeScope | undefined,
  refuse: (reason: string) => never,
): NativeScope {
  if (!scope || typeof scope.projectId !== 'string' || !scope.projectId) {
    refuse('native source project UUID missing');
  }
  if (typeof scope.documentId !== 'string' || !scope.documentId) {
    refuse('native schematic page UUID missing');
  }
  return scope;
}

async function assertNativeScope(
  scope: NativeScope,
  callFirst: DeleteGuardDependencies['callFirst'],
  refuse: (reason: string) => never,
): Promise<void> {
  let project: unknown;
  let document: unknown;
  try {
    project = await callFirst(['DMT_Project.getCurrentProjectInfo']);
    document = await callFirst(['DMT_SelectControl.getCurrentDocumentInfo']);
  } catch {
    refuse('native project/page identity unavailable');
  }
  const matchesProject = isRecord(project) && project.uuid === scope.projectId;
  const matchesDocument = isRecord(document) && document.uuid === scope.documentId;
  const belongsToProject = isRecord(document) && document.parentProjectUuid === scope.projectId;
  const isSchematic = isRecord(document) && document.documentType === 1;
  if (!matchesProject || !matchesDocument || !belongsToProject || !isSchematic) {
    refuse('native focused project or schematic page changed');
  }
}

/**
 * Last-moment pre-delete witness check for the ordinary transactional drawing
 * path. This is NOT an editor-wide lock or a marker/component capability flag.
 * Unscoped legacy standalone deletion remains subject to its existing guards.
 */
export function createNativeTransactionalDeleteGuard(
  primitiveIds: string[],
  rawExpected: unknown,
  rawScope: NativeScope | undefined,
  deps: DeleteGuardDependencies,
):
  | {
      kind: SchematicPrimitiveSnapshotKind;
      assertBeforeDelete(id: string, kind?: SchematicPrimitiveSnapshotKind): Promise<void>;
    }
  | undefined {
  if (rawExpected === undefined) return undefined;
  const refuse = (reason: string): never => refusal(deps.createBridgeError, reason);
  const expected = deps.parseSnapshot(rawExpected);
  const scope = validateScope(rawScope, refuse);
  if (
    primitiveIds.length !== 1 ||
    expected.primitiveId !== primitiveIds[0] ||
    !TRANSACTIONAL_DRAWING_KINDS.has(expected.primitiveKind)
  ) {
    refuse('invalid single-target drawing snapshot');
  }

  return {
    kind: expected.primitiveKind,
    async assertBeforeDelete(id, kind) {
      if (id !== expected.primitiveId || kind !== expected.primitiveKind) {
        refuse('native primitive ID or class changed');
      }
      await assertNativeScope(scope, deps.callFirst, refuse);
      let latest: SchematicPrimitiveSnapshot | undefined;
      try {
        latest = await deps.getSnapshot(id, expected.primitiveKind);
      } catch {
        refuse('native primitive snapshot unavailable at deletion boundary');
      }
      await assertNativeScope(scope, deps.callFirst, refuse);
      if (!latest || !witnessedSnapshotMatches(expected, latest)) {
        refuse('native primitive ID, net or property changed');
      }
      await assertNativeScope(scope, deps.callFirst, refuse);
    },
  };
}
