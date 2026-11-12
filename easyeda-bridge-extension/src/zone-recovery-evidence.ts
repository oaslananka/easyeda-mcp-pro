import {
  reconcileZoneCreation,
  type ExpectedZoneSource,
  type ZoneDerivedEvidence,
  type ZoneInventory,
  type ZoneSourceEvidence,
} from './zone-create-evidence.js';

/**
 * Evidence captured BEFORE an attempt. This is a candidate recovery input,
 * never authorization to clear a quarantine or perform an automatic retry.
 */
export interface ZoneWriteReservation {
  focus: string;
  before: ZoneInventory;
  expected: ExpectedZoneSource;
}

interface StoredZoneInventory {
  sources: ZoneSourceEvidence[];
  derived: ZoneDerivedEvidence[];
}

export interface ZonePendingEvidence {
  version: 2;
  status: 'reconciliation-required';
  focus: string;
  expected: ExpectedZoneSource;
  before: StoredZoneInventory;
}

export type ZoneRecoveryCandidate =
  | { status: 'candidate-unchanged'; persistenceVerified: false; releaseAuthorized: false }
  | {
      status: 'candidate-created';
      sourceId: string;
      pouredId: string;
      persistenceVerified: false;
      releaseAuthorized: false;
    }
  | { status: 'unresolved'; reason: string; persistenceVerified: false; releaseAuthorized: false };

const MAX_MARKER_LENGTH = 256_000;
const MAX_INVENTORY_SIZE = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100_000;
}

function isExpectedZone(value: unknown): value is ExpectedZoneSource {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 9 &&
    isText(value.net) &&
    Number.isInteger(value.layer) &&
    isText(value.polygonSignature) &&
    isText(value.fillMethod) &&
    typeof value.preserveSilos === 'boolean' &&
    isText(value.pourName) &&
    Number.isInteger(value.pourPriority) &&
    typeof value.lineWidth === 'number' &&
    Number.isFinite(value.lineWidth) &&
    value.lineWidth > 0 &&
    typeof value.locked === 'boolean'
  );
}

function isSourceEvidence(value: unknown): value is ZoneSourceEvidence {
  if (!isRecord(value) || !isText(value.sourceId)) return false;
  const { sourceId: _sourceId, ...fields } = value;
  return Object.keys(value).length === 10 && isExpectedZone(fields);
}

function isDerivedEvidence(value: unknown): value is ZoneDerivedEvidence {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 4 &&
    isText(value.sourceId) &&
    isText(value.pouredId) &&
    isText(value.fillSignature) &&
    typeof value.hasFilledGeometry === 'boolean'
  );
}

function isStoredInventory(value: unknown): value is StoredZoneInventory {
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.derived))
    return false;
  if (
    Object.keys(value).length !== 2 ||
    value.sources.length > MAX_INVENTORY_SIZE ||
    value.derived.length > MAX_INVENTORY_SIZE
  )
    return false;
  if (!value.sources.every(isSourceEvidence) || !value.derived.every(isDerivedEvidence))
    return false;
  const sourceIds = value.sources.map((x: ZoneSourceEvidence) => x.sourceId);
  const derivedIds = value.derived.map((x: ZoneDerivedEvidence) => x.sourceId);
  return (
    new Set(sourceIds).size === sourceIds.length && new Set(derivedIds).size === derivedIds.length
  );
}

function sortedInventory(value: ZoneInventory): StoredZoneInventory {
  const bySourceId = <T extends { sourceId: string }>(a: T, b: T) =>
    a.sourceId.localeCompare(b.sourceId);
  return {
    sources: [...value.sources.values()].sort(bySourceId),
    derived: [...value.derived.values()].sort(bySourceId),
  };
}

function restoredInventory(value: StoredZoneInventory): ZoneInventory {
  return {
    sources: new Map(value.sources.map((x) => [x.sourceId, x])),
    derived: new Map(value.derived.map((x) => [x.sourceId, x])),
  };
}

/** A source-less Poured cannot be proof of a valid native recovery baseline. */
function hasOrphanedPoured(value: StoredZoneInventory): boolean {
  const sources = new Set(value.sources.map((source) => source.sourceId));
  return value.derived.some((poured) => !sources.has(poured.sourceId));
}

/** One native Poured primitive cannot be the derived copper of two Pour sources. */
function hasSharedPouredIdentity(value: StoredZoneInventory): boolean {
  const ids = value.derived.map((poured) => poured.pouredId);
  return new Set(ids).size !== ids.length;
}

/** Writes a compact, deterministically ordered record, or refuses oversized/malformed evidence. */
export function encodeZoneWriteReservation(reservation: ZoneWriteReservation): string | undefined {
  if (
    !isText(reservation.focus) ||
    reservation.focus.trim().length === 0 ||
    reservation.focus.length > 1024 ||
    !isExpectedZone(reservation.expected)
  )
    return undefined;
  const stored: ZonePendingEvidence = {
    version: 2,
    status: 'reconciliation-required',
    focus: reservation.focus,
    expected: reservation.expected,
    before: sortedInventory(reservation.before),
  };
  if (
    !isStoredInventory(stored.before) ||
    hasOrphanedPoured(stored.before) ||
    hasSharedPouredIdentity(stored.before) ||
    [...reservation.before.sources].some(([key, item]) => key !== item.sourceId) ||
    [...reservation.before.derived].some(([key, item]) => key !== item.sourceId)
  )
    return undefined;
  try {
    const raw = JSON.stringify(stored);
    return raw.length <= MAX_MARKER_LENGTH ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Legacy v1, incomplete or tampered records are NOT candidates for recovery. */
export function decodeZonePendingEvidence(raw: string): ZonePendingEvidence | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MARKER_LENGTH)
    return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 5 ||
      value.version !== 2 ||
      value.status !== 'reconciliation-required' ||
      !isText(value.focus) ||
      value.focus.trim().length === 0 ||
      value.focus.length > 1024 ||
      !isExpectedZone(value.expected) ||
      !isStoredInventory(value.before)
    )
      return undefined;
    return value as unknown as ZonePendingEvidence;
  } catch {
    return undefined;
  }
}

/** Read-only classification. The caller must separately establish a real cold reopen. */
export function assessZoneRecoveryCandidate(
  pendingRaw: string,
  focusedDocument: string,
  fresh: ZoneInventory | undefined,
): ZoneRecoveryCandidate {
  const deny = (reason: string): ZoneRecoveryCandidate => ({
    status: 'unresolved',
    reason,
    persistenceVerified: false,
    releaseAuthorized: false,
  });
  const pending = decodeZonePendingEvidence(pendingRaw);
  if (!pending) return deny('Pending marker lacks a complete, valid original inventory.');
  if (hasOrphanedPoured(pending.before))
    return deny('Pending baseline has a Poured entry without its exact native Pour source.');
  if (hasSharedPouredIdentity(pending.before))
    return deny('Pending baseline reuses one Poured primitive identity for multiple Pour sources.');
  if (pending.focus !== focusedDocument || !fresh)
    return deny('The reopened PCB focus or current native inventory is unverified.');
  const verdict = reconcileZoneCreation(restoredInventory(pending.before), fresh, pending.expected);
  if (verdict.status === 'unchanged')
    return { status: 'candidate-unchanged', persistenceVerified: false, releaseAuthorized: false };
  if (verdict.status === 'verified')
    return {
      status: 'candidate-created',
      sourceId: verdict.sourceId,
      pouredId: verdict.pouredId,
      persistenceVerified: false,
      releaseAuthorized: false,
    };
  return deny(verdict.reason);
}
