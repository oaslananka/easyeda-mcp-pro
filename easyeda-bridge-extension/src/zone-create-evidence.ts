import { nativeClosedPolyline } from './zone-polygon-intersection.js';

// Immutable readback evidence for one native PCB_PrimitivePour.create attempt.
// A native create/rebuild return value alone is not evidence of a completed fill.
export interface ZoneSourceEvidence {
  sourceId: string;
  net: string;
  layer: number;
  polygonSignature: string;
  fillMethod: string;
  preserveSilos: boolean;
  pourName: string;
  pourPriority: number;
  lineWidth: number;
  locked: boolean;
}

export interface ZoneDerivedEvidence {
  sourceId: string;
  pouredId: string;
  fillSignature: string;
  hasFilledGeometry: boolean;
}

export interface ZoneInventory {
  sources: ReadonlyMap<string, ZoneSourceEvidence>;
  derived: ReadonlyMap<string, ZoneDerivedEvidence>;
}

export type ExpectedZoneSource = Omit<ZoneSourceEvidence, 'sourceId'>;

export type ZoneCreationVerdict =
  | { status: 'verified'; sourceId: string; pouredId: string }
  | { status: 'unchanged'; reason: string }
  | { status: 'ambiguous'; reason: string; candidateIds: string[] };

function sameEvidence(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One native Poured primitive must not be claimed by separate Pour sources. */
function hasSharedPouredIdentity(derived: ReadonlyMap<string, ZoneDerivedEvidence>): boolean {
  const ids = [...derived.values()].map((item) => item.pouredId);
  return new Set(ids).size !== ids.length;
}

function unchanged<T>(before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>): boolean {
  for (const [key, value] of before) {
    if (!after.has(key) || !sameEvidence(value, after.get(key))) return false;
  }
  return true;
}

function isSingleSourceAndCopperDelta(
  before: ZoneInventory,
  after: ZoneInventory,
  count: number,
): boolean {
  return (
    count === 1 &&
    after.sources.size === before.sources.size + 1 &&
    after.derived.size === before.derived.size + 1
  );
}

function sameRequestedProperties(
  actual: ZoneSourceEvidence | undefined,
  expected: ExpectedZoneSource,
): boolean {
  if (!actual) return false;
  return (Object.keys(expected) as Array<keyof ExpectedZoneSource>).every(
    (key) => actual[key] === expected[key],
  );
}

/** A same-plan native source surviving across a restart is not a retry invitation. */
export function findMatchingExistingZoneSources(
  inventory: ZoneInventory,
  expected: ExpectedZoneSource,
): string[] {
  return [...inventory.sources.values()]
    .filter((source) => sameRequestedProperties(source, expected))
    .map((source) => source.sourceId);
}

export function reconcileZoneCreation(
  before: ZoneInventory,
  after: ZoneInventory,
  expected: ExpectedZoneSource,
): ZoneCreationVerdict {
  const candidateIds = [...after.sources.keys()].filter((id) => !before.sources.has(id));
  const ambiguous = (reason: string): ZoneCreationVerdict => ({
    status: 'ambiguous',
    reason,
    candidateIds,
  });
  if (hasSharedPouredIdentity(after.derived))
    return ambiguous('Multiple Pour sources claim the same native Poured primitive.');
  if (!unchanged(before.sources, after.sources) || !unchanged(before.derived, after.derived))
    return ambiguous('An existing Pour or Poured geometry changed; outcome is not isolated.');
  if (
    candidateIds.length === 0 &&
    after.sources.size === before.sources.size &&
    after.derived.size === before.derived.size
  ) {
    return { status: 'unchanged', reason: 'No new native Pour or Poured was observed.' };
  }
  if (!isSingleSourceAndCopperDelta(before, after, candidateIds.length))
    return ambiguous('The post-write Pour/Poured inventory has an ambiguous delta.');
  const sourceId = candidateIds[0];
  if (!sourceId) return ambiguous('New Pour source identity is unavailable.');
  const actual = after.sources.get(sourceId);
  if (!sameRequestedProperties(actual, expected))
    return ambiguous('The new Pour does not match the exact requested native properties.');
  const filled = after.derived.get(sourceId);
  if (!filled || filled.sourceId !== sourceId || filled.pouredId !== sourceId)
    return ambiguous('The newly created Pour lacks a unique matching Poured source link.');
  if (!filled.hasFilledGeometry || !filled.fillSignature)
    return ambiguous('The newly created Poured has no independently validated filled copper.');
  return { status: 'verified', sourceId, pouredId: filled.pouredId };
}

export type ZoneRollbackDecision =
  | { safeToDelete: true; sourceId: string }
  | { safeToDelete: false; reason: string; candidateIds: string[] };

/**
 * Authorizes attempting only an exact-id source deletion. It does NOT claim the
 * native delete succeeded; a new full inventory snapshot must match baseline
 * before rollback can be called verified. Never delete all/newest blindly.
 */
export function planExactZoneRollback(
  before: ZoneInventory,
  after: ZoneInventory,
  expected: ExpectedZoneSource,
): ZoneRollbackDecision {
  const candidateIds = [...after.sources.keys()].filter((id) => !before.sources.has(id));
  const refuse = (reason: string): ZoneRollbackDecision => ({
    safeToDelete: false,
    reason,
    candidateIds,
  });
  if (hasSharedPouredIdentity(after.derived))
    return refuse('Multiple Pour sources claim the same native Poured primitive.');
  if (!unchanged(before.sources, after.sources) || !unchanged(before.derived, after.derived))
    return refuse('Existing sources or copper changed; safe rollback cannot be identified.');
  if (candidateIds.length !== 1 || after.sources.size !== before.sources.size + 1)
    return refuse('No unique native source appeared for exact-id rollback.');
  const sourceId = candidateIds[0];
  if (!sourceId || !sameRequestedProperties(after.sources.get(sourceId), expected))
    return refuse('The only new source is not a verified match for the requested plan.');
  const extraDerived = [...after.derived.values()].filter(
    (item) => !before.derived.has(item.sourceId),
  );
  if (
    extraDerived.length > 1 ||
    extraDerived.some((item) => item.sourceId !== sourceId || item.pouredId !== sourceId)
  )
    return refuse('Unrelated new copper cannot be excluded.');
  return { safeToDelete: true, sourceId };
}

/** Snapshot only native geometry variants that can be compared deterministically. */
function nativePolygonSignature(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const getter = (value as { getSource?: unknown }).getSource;
  if (typeof getter !== 'function') return undefined;
  try {
    const source = getter.call(value);
    if (!Array.isArray(source) || source.length > 1027) return undefined;
    if (
      source[0] === 'R' &&
      source.length === 7 &&
      source[5] === 0 &&
      source[6] === 0 &&
      source.slice(1).every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
      source[3] > 0 &&
      source[4] > 0
    )
      return JSON.stringify(source);
    if (nativeClosedPolyline(source)) return JSON.stringify(source);
    return undefined;
  } catch {
    return undefined;
  }
}

function nativeField(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const getter = (value as Record<string, unknown>)['getState_' + name];
  if (typeof getter !== 'function') return undefined;
  return getter.call(value);
}

function validZoneSourceIdentity(evidence: ZoneSourceEvidence): boolean {
  return (
    typeof evidence.sourceId === 'string' &&
    evidence.sourceId.length > 0 &&
    typeof evidence.net === 'string' &&
    evidence.net.length > 0 &&
    typeof evidence.fillMethod === 'string' &&
    evidence.fillMethod.length > 0 &&
    typeof evidence.pourName === 'string' &&
    evidence.pourName.length > 0 &&
    typeof evidence.polygonSignature === 'string' &&
    evidence.polygonSignature.length > 0
  );
}

function validZoneSourceNumbers(evidence: ZoneSourceEvidence): boolean {
  return (
    typeof evidence.layer === 'number' &&
    Number.isInteger(evidence.layer) &&
    typeof evidence.pourPriority === 'number' &&
    Number.isInteger(evidence.pourPriority) &&
    typeof evidence.lineWidth === 'number' &&
    Number.isFinite(evidence.lineWidth) &&
    evidence.lineWidth > 0
  );
}

function validZoneSourceFlags(evidence: ZoneSourceEvidence): boolean {
  return typeof evidence.preserveSilos === 'boolean' && typeof evidence.locked === 'boolean';
}

function sourceSnapshot(item: unknown): ZoneSourceEvidence | undefined {
  const source = {
    sourceId: nativeField(item, 'PrimitiveId'),
    net: nativeField(item, 'Net'),
    layer: nativeField(item, 'Layer'),
    polygonSignature: nativePolygonSignature(nativeField(item, 'ComplexPolygon')),
    fillMethod: nativeField(item, 'PourFillMethod'),
    preserveSilos: nativeField(item, 'PreserveSilos'),
    pourName: nativeField(item, 'PourName'),
    pourPriority: nativeField(item, 'PourPriority'),
    lineWidth: nativeField(item, 'LineWidth'),
    locked: nativeField(item, 'PrimitiveLock'),
  } as ZoneSourceEvidence;
  return validZoneSourceIdentity(source) &&
    validZoneSourceNumbers(source) &&
    validZoneSourceFlags(source)
    ? source
    : undefined;
}

/**
 * Invalid/ambiguous existing Pour sources do not become an empty inventory.
 * The caller must fail before attempting a native mutation.
 */
export function snapshotNativeZoneSources(
  items: unknown[],
): Map<string, ZoneSourceEvidence> | undefined {
  const inventory = new Map<string, ZoneSourceEvidence>();
  try {
    for (const item of items) {
      const source = sourceSnapshot(item);
      if (!source || inventory.has(source.sourceId)) return undefined;
      inventory.set(source.sourceId, source);
    }
    return inventory;
  } catch {
    return undefined;
  }
}
