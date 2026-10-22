import type { ApiRuntime } from './api-runtime.js';

export interface PcbMutationOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  readFirstPath: ApiRuntime['readFirstPath'];
  requireActivePcbContext(): Promise<unknown>;
  deletePrimitives(ids: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
}

const PCB_COMPONENT_TRANSFORM_FIELDS = new Set(['layer', 'x', 'y', 'rotation', 'primitiveLock']);

function validatedComponentTransformProperty(value: unknown): Record<string, number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PCB component transform property must be an object');
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, number | boolean> = {};
  for (const [key, fieldValue] of Object.entries(input)) {
    if (!PCB_COMPONENT_TRANSFORM_FIELDS.has(key)) {
      throw new TypeError(`Unsupported PCB component transform field: ${key}`);
    }
    if (key === 'primitiveLock') {
      if (typeof fieldValue !== 'boolean') {
        throw new TypeError('PCB component primitiveLock must be a boolean');
      }
      output[key] = fieldValue;
      continue;
    }
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
      throw new TypeError(`PCB component ${key} must be a finite number`);
    }
    if (key === 'layer' && fieldValue !== 1 && fieldValue !== 2) {
      throw new TypeError('PCB component layer must be 1 (top) or 2 (bottom)');
    }
    output[key] = fieldValue;
  }
  if (Object.keys(output).length === 0) {
    throw new TypeError('PCB component transform must change at least one supported field');
  }
  return output;
}

type NativeMethod = (...args: unknown[]) => unknown;
type CopperRebuildStatus =
  'rebuilt' | 'no-copper' | 'error' | 'readback-missing' | 'readback-mismatch';

interface CopperRebuildItem {
  pourId: string;
  pouredId: string | null;
  status: CopperRebuildStatus;
  verified: boolean;
  error?: string;
  warning?: string;
}

interface CopperRebuildResult {
  success: boolean;
  matchedCount: number;
  attemptedCount: number;
  rebuiltCount: number;
  noCopperCount: number;
  transactionCovered: false;
  planeZonesSupported: false;
  results: CopperRebuildItem[];
  error?: string;
}

interface CopperRebuildAttempt {
  pourId: string;
  nativeResult?: unknown;
  error?: string;
  notInvoked?: boolean;
}

// Snapshot calculated geometry before the beta rebuild, rather than retaining
// mutable native objects that the editor can change in place.
interface PouredEvidence {
  pouredId: string;
  sourceId: string;
  fillSignature: string;
}

function validCopperPathPart(part: unknown): boolean {
  return (
    Array.isArray(part) &&
    part.length >= 5 &&
    part.filter((value) => typeof value === 'number' && Number.isFinite(value)).length >= 4 &&
    part.some((value) => typeof value === 'string' && value.length > 0) &&
    part.every(
      (value) =>
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length > 0),
    )
  );
}

function validCopperPathSource(source: unknown): boolean {
  return (
    Array.isArray(source) &&
    source.length > 0 &&
    (Array.isArray(source[0]) ? source.every(validCopperPathPart) : validCopperPathPart(source))
  );
}

function fillSignature(fill: unknown): unknown[] | undefined {
  if (!fill || typeof fill !== 'object') return undefined;
  const part = fill as Record<string, unknown>;
  const getter = nativeMethod(part.path, 'getSource');
  if (
    typeof part.id !== 'string' ||
    typeof part.lineWidth !== 'number' ||
    !Number.isFinite(part.lineWidth) ||
    typeof part.fill !== 'boolean' ||
    !getter
  )
    return undefined;
  try {
    const source = getter.call(part.path);
    if (!validCopperPathSource(source)) return undefined;
    return [part.id, part.lineWidth, part.fill, source];
  } catch {
    return undefined;
  }
}

function pouredFillSignature(item: unknown): string | undefined {
  const getter = nativeMethod(item, 'getState_PourFills');
  if (!getter) return undefined;
  let fills: unknown;
  try {
    fills = getter.call(item);
  } catch {
    return undefined;
  }
  if (!Array.isArray(fills) || fills.length === 0) return undefined;
  const signatures = fills.map(fillSignature);
  if (signatures.some((signature) => signature === undefined)) return undefined;
  return JSON.stringify(signatures);
}

function snapshotPoured(items: unknown[]): Map<string, PouredEvidence> | undefined {
  const snapshot = new Map<string, PouredEvidence>();
  for (const item of items) {
    const pouredId = nativeStateString(item, 'getState_PrimitiveId');
    const sourceId = nativeStateString(item, 'getState_PourPrimitiveId');
    const fillSignature = pouredFillSignature(item);
    if (!pouredId || !sourceId || !fillSignature || snapshot.has(sourceId)) return undefined;
    snapshot.set(sourceId, { pouredId, sourceId, fillSignature });
  }
  return snapshot;
}

async function focusedPcbIdentity(
  readFirstPath: ApiRuntime['readFirstPath'],
): Promise<string | undefined> {
  const project = readFirstPath<unknown>(['DMT_Project', 'dmt_Project']);
  const selector = readFirstPath<unknown>(['DMT_SelectControl', 'dmt_SelectControl']);
  if (
    !nativeMethod(project, 'getCurrentProjectInfo') ||
    !nativeMethod(selector, 'getCurrentDocumentInfo')
  ) {
    return undefined;
  }
  try {
    const p = (await invokeNative(project, 'getCurrentProjectInfo')) as Record<
      string,
      unknown
    > | null;
    const d = (await invokeNative(selector, 'getCurrentDocumentInfo')) as Record<
      string,
      unknown
    > | null;
    if (
      !p ||
      !d ||
      typeof p.uuid !== 'string' ||
      !p.uuid ||
      typeof d.uuid !== 'string' ||
      !d.uuid ||
      d.documentType !== 3 ||
      d.parentProjectUuid !== p.uuid
    )
      return undefined;
    return JSON.stringify([p.uuid, d.uuid]);
  } catch {
    return undefined;
  }
}

function existingPouredUnchanged(
  before: Map<string, PouredEvidence>,
  after: Map<string, PouredEvidence>,
): boolean {
  for (const [source, expected] of before) {
    const current = after.get(source);
    if (
      !current ||
      current.pouredId !== expected.pouredId ||
      current.fillSignature !== expected.fillSignature
    ) {
      return false;
    }
  }
  return true;
}

function independentlyReconciled(
  attempt: CopperRebuildAttempt,
  beforeEvidence: Map<string, PouredEvidence> | undefined,
  after: unknown[],
  focusUnchanged: boolean,
): string | undefined {
  if (!focusUnchanged) return undefined;
  let afterEvidence: Map<string, PouredEvidence> | undefined;
  try {
    afterEvidence = snapshotPoured(after);
  } catch {
    return undefined;
  }
  if (!beforeEvidence || !afterEvidence || beforeEvidence.has(attempt.pourId)) return undefined;
  const target = afterEvidence.get(attempt.pourId);
  if (
    !target ||
    target.pouredId !== attempt.pourId ||
    afterEvidence.size !== beforeEvidence.size + 1
  )
    return undefined;
  if (!existingPouredUnchanged(beforeEvidence, afterEvidence)) return undefined;
  const returnedSource = nativeStateString(attempt.nativeResult, 'getState_PourPrimitiveId');
  const returnedId = nativeStateString(attempt.nativeResult, 'getState_PrimitiveId');
  const priorReturn = returnedSource && beforeEvidence.get(returnedSource);
  if (!priorReturn || priorReturn.pouredId !== returnedId) return undefined;
  return target.pouredId;
}

function nativeMethod(target: unknown, name: string): NativeMethod | undefined {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const candidate = (target as Record<string, unknown>)[name];
  return typeof candidate === 'function' ? (candidate as NativeMethod) : undefined;
}

async function invokeNative(target: unknown, name: string, ...args: unknown[]): Promise<unknown> {
  const method = nativeMethod(target, name);
  if (!method) {
    throw new Error(`EasyEDA runtime does not expose ${name}().`);
  }
  return await method.apply(target, args);
}

function nativeStateString(target: unknown, getter: string): string | undefined {
  const method = nativeMethod(target, getter);
  if (!method) return undefined;
  const value = method.call(target);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function nativeStateNumber(target: unknown, getter: string): number | undefined {
  const method = nativeMethod(target, getter);
  if (!method) return undefined;
  const value = method.call(target);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nativeItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined);
  return value === null || value === undefined ? [] : [value];
}

function copperLayer(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !(value === 1 || value === 2 || (value >= 15 && value <= 44))
  ) {
    throw new TypeError(
      'PCB copper rebuild layer must be TOP=1, BOTTOM=2, or INNER_1..INNER_30=15..44.',
    );
  }
  return value;
}

function requestedPourIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((id) => typeof id !== 'string' || id.trim().length === 0)
  ) {
    throw new TypeError('PCB copper rebuild pourIds must be a non-empty array of primitive ids.');
  }
  const ids = value.map((id) => (id as string).trim());
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('PCB copper rebuild pourIds must not contain duplicates.');
  }
  return ids;
}

interface CopperRebuildTarget {
  pourId: string;
  primitive: unknown;
}

function requestedNet(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  throw new TypeError('PCB copper rebuild net must be a non-empty string.');
}

function selectPourCandidate(candidates: unknown[], id: string): unknown | undefined {
  const exact = candidates.find(
    (candidate) => nativeStateString(candidate, 'getState_PrimitiveId') === id,
  );
  if (exact !== undefined) return exact;
  return undefined;
}

async function resolvePoursByIds(pourClass: unknown, ids: string[]): Promise<unknown[]> {
  const resolved: unknown[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const candidates = nativeItems(await invokeNative(pourClass, 'get', id));
    const selected = selectPourCandidate(candidates, id);
    if (selected === undefined) missing.push(id);
    else resolved.push(selected);
  }
  if (missing.length > 0) {
    throw new Error(
      `PCB pour primitive id(s) not found on the active PCB: ${missing.join(', ')}. No copper was rebuilt.`,
    );
  }
  return resolved;
}

function validatedPourTarget(
  primitive: unknown,
  net: string | undefined,
  layer: number | undefined,
): CopperRebuildTarget | undefined {
  const pourId = nativeStateString(primitive, 'getState_PrimitiveId');
  if (!pourId) {
    throw new Error(
      'EasyEDA PCB_PrimitivePour returned an item without getState_PrimitiveId(). No copper was rebuilt.',
    );
  }

  if (net !== undefined) {
    const actualNet = nativeStateString(primitive, 'getState_Net');
    if (actualNet === undefined) {
      throw new Error(
        `PCB pour ${pourId} does not expose getState_Net(); the requested net filter cannot be verified. No copper was rebuilt.`,
      );
    }
    if (actualNet !== net) return undefined;
  }

  if (layer !== undefined) {
    const actualLayer = nativeStateNumber(primitive, 'getState_Layer');
    if (actualLayer === undefined) {
      throw new Error(
        `PCB pour ${pourId} does not expose getState_Layer(); the requested layer filter cannot be verified. No copper was rebuilt.`,
      );
    }
    if (actualLayer !== layer) return undefined;
  }

  if (!nativeMethod(primitive, 'rebuildCopperRegion')) {
    throw new Error(
      `PCB pour ${pourId} does not expose rebuildCopperRegion(); no copper was rebuilt.`,
    );
  }
  return { pourId, primitive };
}

function selectValidatedPours(
  pours: unknown[],
  net: string | undefined,
  layer: number | undefined,
): CopperRebuildTarget[] {
  const selected: CopperRebuildTarget[] = [];
  for (const primitive of pours) {
    const target = validatedPourTarget(primitive, net, layer);
    if (target) selected.push(target);
  }
  if (selected.length === 0) {
    throw new Error('No existing PCB pours matched the requested filters. No copper was rebuilt.');
  }
  if (new Set(selected.map((item) => item.pourId)).size !== selected.length) {
    throw new Error('EasyEDA returned duplicate PCB pour primitive ids. No copper was rebuilt.');
  }
  return selected;
}

async function resolvePours(
  pourClass: unknown,
  params: Record<string, unknown>,
): Promise<CopperRebuildTarget[]> {
  const ids = requestedPourIds(params.pourIds);
  const net = requestedNet(params.net);
  const layer = copperLayer(params.layer);
  const pours = ids
    ? await resolvePoursByIds(pourClass, ids)
    : nativeItems(await invokeNative(pourClass, 'getAll', net, layer));
  return selectValidatedPours(pours, net, layer);
}

function pouredReadbackMap(items: unknown[]): Map<string, string[]> {
  const byPourId = new Map<string, string[]>();
  for (const item of items) {
    const pourId = nativeStateString(item, 'getState_PourPrimitiveId');
    const pouredId = nativeStateString(item, 'getState_PrimitiveId');
    if (!pourId || !pouredId) continue;
    const current = byPourId.get(pourId) ?? [];
    current.push(pouredId);
    byPourId.set(pourId, current);
  }
  return byPourId;
}

function mapReadbackFailureResults(
  attempts: CopperRebuildAttempt[],
  message: string,
): CopperRebuildItem[] {
  return attempts.map((attempt) => {
    if (attempt.error) {
      return {
        pourId: attempt.pourId,
        pouredId: null,
        status: 'error',
        verified: false,
        error: attempt.error,
      };
    }
    if (attempt.nativeResult === undefined) {
      return {
        pourId: attempt.pourId,
        pouredId: null,
        status: 'no-copper',
        verified: false,
        error: `Native rebuild returned no copper, but PCB_PrimitivePoured read-back failed: ${message}`,
      };
    }
    return {
      pourId: attempt.pourId,
      pouredId: null,
      status: 'readback-missing',
      verified: false,
      error: `Copper rebuild returned, but PCB_PrimitivePoured read-back failed: ${message}`,
    };
  });
}

function unchangedNoCopperReadback(
  before: Map<string, PouredEvidence> | undefined,
  items: unknown[],
  otherRebuiltIds: ReadonlySet<string>,
): boolean {
  if (!before) return false;
  try {
    const after = snapshotPoured(items);
    return !!after && !unexpectedPouredChanges(before, after, otherRebuiltIds);
  } catch {
    return false;
  }
}

function noCopperRebuildItem(
  attempt: CopperRebuildAttempt,
  readbackIds: string[],
  before: Map<string, PouredEvidence> | undefined,
  after: unknown[],
  otherRebuiltIds: ReadonlySet<string>,
): CopperRebuildItem {
  if (readbackIds.length === 0) {
    if (!unchangedNoCopperReadback(before, after, otherRebuiltIds)) {
      return {
        pourId: attempt.pourId,
        pouredId: null,
        status: 'readback-mismatch',
        verified: false,
        error:
          'Native rebuild returned no copper, but unrelated Poured geometry changed or the read-back inventory could not be validated.',
      };
    }
    return {
      pourId: attempt.pourId,
      pouredId: null,
      status: 'no-copper',
      verified: true,
    };
  }
  return {
    pourId: attempt.pourId,
    pouredId: readbackIds[0] ?? null,
    status: 'readback-mismatch',
    verified: false,
    error:
      'Native rebuild returned undefined (no copper), but PCB_PrimitivePoured still reports derived copper for this pour.',
  };
}

function mapRebuildResults(
  attempts: CopperRebuildAttempt[],
  preEvidence: Map<string, PouredEvidence> | undefined,
  postReadback: unknown[],
  focusUnchanged: boolean,
): CopperRebuildItem[] {
  const byPourId = pouredReadbackMap(postReadback);
  // Only native calls with non-undefined successful returns may legitimately
  // modify other pours in this batch. Never exempt skipped, errored or no-copper sources.
  const rebuiltIds = new Set(
    attempts
      .filter(
        (attempt) => !attempt.error && !attempt.notInvoked && attempt.nativeResult !== undefined,
      )
      .map((attempt) => attempt.pourId),
  );
  return attempts.map((attempt) => {
    if (attempt.error) {
      return {
        pourId: attempt.pourId,
        pouredId: null,
        status: 'error',
        verified: false,
        error: attempt.error,
      };
    }

    const readbackIds = byPourId.get(attempt.pourId) ?? [];
    if (attempt.nativeResult === undefined) {
      return noCopperRebuildItem(attempt, readbackIds, preEvidence, postReadback, rebuiltIds);
    }

    // EasyEDA Pro 3.2.206 has returned an existing pour's copper when asked to
    // rebuild a newly created pour. Never attribute that result to our target.
    const nativeSourcePourId = nativeStateString(attempt.nativeResult, 'getState_PourPrimitiveId');
    if (nativeSourcePourId !== undefined && nativeSourcePourId !== attempt.pourId) {
      const reconciledId = independentlyReconciled(
        attempt,
        preEvidence,
        postReadback,
        focusUnchanged,
      );
      if (reconciledId !== undefined) {
        return {
          pourId: attempt.pourId,
          pouredId: reconciledId,
          status: 'rebuilt',
          verified: true,
          warning:
            'Beta native rebuild returned an unrelated pre-existing Pour; independent newly created Poured geometry was verified without changes to existing Poured objects.',
        };
      }
      return {
        pourId: attempt.pourId,
        pouredId: readbackIds[0] ?? null,
        status: 'readback-mismatch',
        verified: false,
        error: `Pour ${nativeSourcePourId} != ${attempt.pourId} (rebuild source mismatch).`,
      };
    }

    if (readbackIds.length === 0) {
      return {
        pourId: attempt.pourId,
        pouredId: null,
        status: 'readback-missing',
        verified: false,
        error:
          'Native rebuild returned a poured result, but PCB_PrimitivePoured.getAll() did not confirm it.',
      };
    }
    if (readbackIds.length !== 1) {
      return {
        pourId: attempt.pourId,
        pouredId: readbackIds[0] ?? null,
        status: 'readback-mismatch',
        verified: false,
        error: `PCB_PrimitivePoured read-back is ambiguous for this pour (found ${readbackIds.length} derived primitives).`,
      };
    }

    const nativePouredId = nativeStateString(attempt.nativeResult, 'getState_PrimitiveId');
    if (nativePouredId !== undefined && nativePouredId !== readbackIds[0]) {
      return {
        pourId: attempt.pourId,
        pouredId: readbackIds[0],
        status: 'readback-mismatch',
        verified: false,
        error: `Native rebuild returned poured id ${nativePouredId}, but persisted read-back reported ${readbackIds[0]}.`,
      };
    }

    return directRebuildItemWithGeometry(
      attempt.pourId,
      readbackIds[0],
      preEvidence,
      postReadback,
      rebuiltIds,
    );
  });
}

function mapFocusChangedRebuildResults(attempts: CopperRebuildAttempt[]): CopperRebuildItem[] {
  return attempts.map((attempt) => ({
    pourId: attempt.pourId,
    pouredId: null,
    status: attempt.error ? 'error' : 'readback-mismatch',
    verified: false,
    error:
      attempt.error ??
      'Active PCB project/document identity changed or became unavailable during copper rebuild.',
  }));
}

function mapResultsAfterFocusCheck(
  attempts: CopperRebuildAttempt[],
  preEvidence: Map<string, PouredEvidence> | undefined,
  postReadback: unknown[],
  focusUnchanged: boolean,
): CopperRebuildItem[] {
  return focusUnchanged
    ? mapRebuildResults(attempts, preEvidence, postReadback, true)
    : mapFocusChangedRebuildResults(attempts);
}

function unexpectedPouredChanges(
  before: Map<string, PouredEvidence>,
  after: Map<string, PouredEvidence>,
  attemptedIds: ReadonlySet<string>,
): boolean {
  for (const [sourceId, previous] of before) {
    if (attemptedIds.has(sourceId)) continue;
    const current = after.get(sourceId);
    if (
      !current ||
      current.pouredId !== previous.pouredId ||
      current.fillSignature !== previous.fillSignature
    )
      return true;
  }
  for (const sourceId of after.keys()) {
    if (!before.has(sourceId) && !attemptedIds.has(sourceId)) return true;
  }
  return false;
}

function directRebuildItemWithGeometry(
  pourId: string,
  pouredId: string,
  before: Map<string, PouredEvidence> | undefined,
  items: unknown[],
  attemptedIds: ReadonlySet<string>,
): CopperRebuildItem {
  let after: Map<string, PouredEvidence> | undefined;
  try {
    after = snapshotPoured(items);
  } catch {
    // A native getter can throw; never attribute such geometry to success.
  }
  const target = after?.get(pourId);
  if (
    !before ||
    !after ||
    target?.pouredId !== pouredId ||
    unexpectedPouredChanges(before, after, attemptedIds)
  ) {
    return {
      pourId,
      pouredId,
      status: 'readback-mismatch',
      verified: false,
      error:
        'Native copper read-back lacks validated fill geometry or changed unrelated Poured geometry.',
    };
  }
  return { pourId, pouredId, status: 'rebuilt', verified: true };
}

function requireCopperRebuildRuntime(readFirstPath: ApiRuntime['readFirstPath']): {
  pourClass: unknown;
  pouredClass: unknown;
} {
  const pourClass = readFirstPath<unknown>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
  const pouredClass = readFirstPath<unknown>(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']);
  if (!pourClass || !nativeMethod(pourClass, 'getAll') || !nativeMethod(pourClass, 'get')) {
    throw new Error(
      'EasyEDA runtime does not expose PCB_PrimitivePour.get()/getAll(); no copper was rebuilt.',
    );
  }
  if (!pouredClass || !nativeMethod(pouredClass, 'getAll')) {
    throw new Error(
      'EasyEDA runtime does not expose PCB_PrimitivePoured.getAll(); read-back cannot be verified, so no copper was rebuilt.',
    );
  }
  return { pourClass, pouredClass };
}

async function readPouredItems(pouredClass: unknown): Promise<unknown[]> {
  const value = await invokeNative(pouredClass, 'getAll');
  if (!Array.isArray(value)) {
    throw new Error('PCB_PrimitivePoured.getAll() did not return an array.');
  }
  return value;
}

async function executeCopperRebuilds(
  targets: CopperRebuildTarget[],
  expectedIdentity: string,
  readFirstPath: ApiRuntime['readFirstPath'],
): Promise<CopperRebuildAttempt[]> {
  const attempts: CopperRebuildAttempt[] = [];
  for (const target of targets) {
    try {
      if ((await focusedPcbIdentity(readFirstPath)) !== expectedIdentity) {
        attempts.push({
          pourId: target.pourId,
          notInvoked: true,
          error: 'Active PCB changed before this pour; rebuildCopperRegion() was not invoked.',
        });
        break;
      }
      attempts.push({
        pourId: target.pourId,
        nativeResult: await invokeNative(target.primitive, 'rebuildCopperRegion'),
      });
    } catch (error) {
      attempts.push({
        pourId: target.pourId,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return attempts;
}

function nativeAttemptCount(attempts: CopperRebuildAttempt[]): number {
  return attempts.filter((attempt) => !attempt.notInvoked).length;
}

function readbackFailureResult(
  matchedCount: number,
  attempts: CopperRebuildAttempt[],
  error: unknown,
): CopperRebuildResult {
  const message = error instanceof Error ? error.message : String(error);
  const results = mapReadbackFailureResults(attempts, message);
  return {
    success: false,
    matchedCount,
    attemptedCount: nativeAttemptCount(attempts),
    rebuiltCount: 0,
    noCopperCount: results.filter((item) => item.status === 'no-copper').length,
    transactionCovered: false,
    planeZonesSupported: false,
    results,
    error:
      'PCB copper rebuild completed or partially completed, but persisted read-back could not be verified.',
  };
}

function finalRebuildResult(
  matchedCount: number,
  attempts: CopperRebuildAttempt[],
  results: CopperRebuildItem[],
): CopperRebuildResult {
  const rebuiltCount = results.filter((item) => item.status === 'rebuilt').length;
  const noCopperCount = results.filter((item) => item.status === 'no-copper').length;
  const success =
    nativeAttemptCount(attempts) === matchedCount &&
    results.length === matchedCount &&
    rebuiltCount === matchedCount;
  const firstFailure = results.find((item) => item.status !== 'rebuilt');
  const error =
    firstFailure?.error ??
    (noCopperCount > 0
      ? 'One or more pours produced no copper and were not counted as successful rebuilds.'
      : 'One or more pours could not be rebuilt and verified.');

  return {
    success,
    matchedCount,
    attemptedCount: nativeAttemptCount(attempts),
    rebuiltCount,
    noCopperCount,
    transactionCovered: false,
    planeZonesSupported: false,
    results,
    ...(success ? {} : { error }),
  };
}

async function preRebuildEvidence(
  pouredClass: unknown,
): Promise<Map<string, PouredEvidence> | undefined> {
  let items: unknown[];
  try {
    items = await readPouredItems(pouredClass);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(
      'PCB_PrimitivePoured.getAll() preflight failed; read-back cannot be verified, so no copper was rebuilt. ' +
        message,
    ) as Error & { cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }
  // Freeze now: EasyEDA can mutate previous native object references in place.
  // With an unreadable baseline, a later success cannot exclude collateral writes.
  let evidence: Map<string, PouredEvidence> | undefined;
  try {
    evidence = snapshotPoured(items);
  } catch {
    // A failing native getter must not make an unverified write possible.
  }
  if (!evidence) {
    throw new Error('Existing Poured geometry cannot be snapshotted; no copper was rebuilt.');
  }
  return evidence;
}

export interface PcbMutationOperations {
  addZone(params: Record<string, unknown>): Promise<unknown>;
  rebuildCopper(params: Record<string, unknown>): Promise<CopperRebuildResult>;
  modifyComponent(params: Record<string, unknown>): Promise<unknown>;
  deleteComponents(params: Record<string, unknown>): Promise<{
    success: boolean;
    deletedCount: number;
    deleted: string[];
    notFound: string[];
  }>;
}

async function rejectUnverifiedZoneCreation(_params: Record<string, unknown>): Promise<unknown> {
  throw new Error(
    'PCB copper-zone creation is unavailable until the complete native contract is verified.',
  );
}

export function createPcbMutationOperations({
  callFirst,
  readFirstPath,
  requireActivePcbContext,
  deletePrimitives,
}: PcbMutationOperationDependencies): PcbMutationOperations {
  // The dispatcher owns one operation instance. Do not interleave multiple
  // asynchronous native rebuilds; timeouts may leave the first invocation running.
  let rebuildInProgress = false;
  // A failed/ambiguous native write may still be active after a bridge timeout.
  // Never retry against the same dispatcher without independent reconciliation.
  let rebuildRequiresReconciliation = false;
  async function rebuildCopper(params: Record<string, unknown>): Promise<CopperRebuildResult> {
    if (rebuildInProgress) {
      throw new Error(
        'A PCB copper rebuild is already in progress. Inspect its result before retrying.',
      );
    }
    if (rebuildRequiresReconciliation) {
      throw new Error(
        'A previous native PCB copper rebuild ended without complete verification. ' +
          'Inspect and reconcile the PCB independently before reconnecting; ' +
          'reconnecting alone does not prove rollback. No copper was rebuilt.',
      );
    }
    rebuildInProgress = true;
    try {
      await requireActivePcbContext();

      const initialFocus = await focusedPcbIdentity(readFirstPath);
      if (!initialFocus) {
        throw new Error('Active PCB project/document identity unavailable; no copper was rebuilt.');
      }
      const { pourClass, pouredClass } = requireCopperRebuildRuntime(readFirstPath);
      const targets = await resolvePours(pourClass, params);

      const preEvidence = await preRebuildEvidence(pouredClass);
      // Resolving target IDs and snapshotting geometry are asynchronous. Reject a
      // document change before even one native write, rather than post-hoc only.
      const beforeWriteFocus = await focusedPcbIdentity(readFirstPath);
      if (beforeWriteFocus !== initialFocus) {
        throw new Error(
          'Active PCB changed during copper rebuild preflight; no copper was rebuilt.',
        );
      }
      const attempts = await executeCopperRebuilds(targets, initialFocus, readFirstPath);
      // Fail closed after any native invocation until its post-write evidence is
      // fully verified. A timeout/error is not evidence the native write stopped.
      rebuildRequiresReconciliation = nativeAttemptCount(attempts) > 0;

      let postReadback: unknown[];
      try {
        postReadback = await readPouredItems(pouredClass);
      } catch (error) {
        return readbackFailureResult(targets.length, attempts, error);
      }

      const finalFocus = await focusedPcbIdentity(readFirstPath);
      const focusUnchanged = initialFocus !== undefined && initialFocus === finalFocus;
      const result = finalRebuildResult(
        targets.length,
        attempts,
        mapResultsAfterFocusCheck(attempts, preEvidence, postReadback, focusUnchanged),
      );
      if (
        focusUnchanged &&
        nativeAttemptCount(attempts) === targets.length &&
        result.results.length === targets.length &&
        result.results.every(
          (item) => item.verified && (item.status === 'rebuilt' || item.status === 'no-copper'),
        )
      ) {
        rebuildRequiresReconciliation = false;
      }
      return result;
    } finally {
      rebuildInProgress = false;
    }
  }

  async function modifyComponent(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
      params.primitiveId,
      validatedComponentTransformProperty(params.property),
    );
  }

  async function deleteComponents(params: Record<string, unknown>): Promise<{
    success: boolean;
    deletedCount: number;
    deleted: string[];
    notFound: string[];
  }> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    const result = await deletePrimitives(ids);
    return {
      success: result.notFound.length === 0,
      deletedCount: result.deleted.length,
      deleted: result.deleted,
      notFound: result.notFound,
    };
  }

  return {
    addZone: rejectUnverifiedZoneCreation,
    rebuildCopper,
    modifyComponent,
    deleteComponents,
  };
}
