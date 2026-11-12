import {
  findMatchingExistingZoneSources,
  planExactZoneRollback,
  reconcileZoneCreation,
  type ExpectedZoneSource,
  type ZoneInventory,
} from './zone-create-evidence.js';
import type { ZoneWriteReservation } from './zone-recovery-evidence.js';

// Candidate operation is intentionally NOT attached to pcb.addZone or exposed
// to the public MCP write path until disposable end-to-end acceptance.
// A future adapter must supply a real zero-write exact-focus/geometry preflight.
export interface NativeZoneCreateDependencies {
  focus(): Promise<string | undefined>;
  preflight(expected: ExpectedZoneSource): Promise<boolean>;
  readInventory(): Promise<ZoneInventory | undefined>;
  create(expected: ExpectedZoneSource): Promise<unknown>;
  rebuild(sourceId: string): Promise<unknown>;
  save(): Promise<boolean>;
  deleteSource(sourceId: string): Promise<boolean>;
  /** Mandatory write-ahead reservation; a rejected/missing fence cannot allow native create. */
  reserveMutation(reservation: ZoneWriteReservation): Promise<boolean> | boolean;
}

export type NativeZoneCreateResult =
  | {
      status: 'saved-readback';
      sourceId: string;
      pouredId: string;
      saveReturnedTrue: true;
      persistenceVerified: false;
    }
  | { status: 'rollback-readback'; sourceId: string; reason: string; persistenceVerified: false }
  | { status: 'blocked'; reason: string }
  | { status: 'uncertain'; reason: string };

interface ZoneAttempt {
  focus: string;
  before: ZoneInventory;
  expected: ExpectedZoneSource;
}

/** Only internally generated plan-collision reasons may surface verbatim. */
class ExistingNativeZonePlanError extends Error {}

/**
 * Only these creation settings have survived a real isolated 3.2.209
 * native create/readback/cold-reopen cycle. Other values were silently
 * normalized: rejecting before mutation is safer than post-hoc cleanup.
 * Version/board/net/outline checks remain mandatory in deps.preflight().
 */
function measuredNativeZoneSettings(expected: ExpectedZoneSource): boolean {
  return (
    expected.net === 'GND' &&
    expected.layer === 2 &&
    expected.fillMethod === 'solid' &&
    expected.preserveSilos === true &&
    expected.pourPriority === 1 &&
    expected.lineWidth === 0.2 &&
    expected.locked === false
  );
}

function uncertain(reason: string): NativeZoneCreateResult {
  return {
    status: 'uncertain',
    reason: reason + ' Outcome requires independent inspection; do not retry blindly.',
  };
}

function inventoryEquals(before: ZoneInventory, after: ZoneInventory): boolean {
  if (before.sources.size !== after.sources.size || before.derived.size !== after.derived.size)
    return false;
  for (const [id, source] of before.sources) {
    if (JSON.stringify(source) !== JSON.stringify(after.sources.get(id))) return false;
  }
  for (const [id, copper] of before.derived) {
    if (JSON.stringify(copper) !== JSON.stringify(after.derived.get(id))) return false;
  }
  return true;
}

async function recoverIncompleteZone(
  deps: NativeZoneCreateDependencies,
  attempt: ZoneAttempt,
  observed: ZoneInventory,
  reason: string,
): Promise<NativeZoneCreateResult> {
  const rollback = planExactZoneRollback(attempt.before, observed, attempt.expected);
  if (!rollback.safeToDelete)
    return uncertain(
      'New copper is unverified and exact-id rollback is unavailable. ' +
        reason +
        ' ' +
        rollback.reason,
    );
  if ((await deps.focus()) !== attempt.focus)
    return uncertain('Focus changed before rollback; no deletion attempted.');
  if (!(await deps.deleteSource(rollback.sourceId)))
    return uncertain('Exact-id rollback failed; deletion outcome requires independent inspection.');
  if ((await deps.focus()) !== attempt.focus)
    return uncertain('Focus changed after native rollback deletion; no document save attempted.');
  if (!(await deps.save())) return uncertain('Native rollback deletion could not be saved.');
  const restored = await deps.readInventory();
  if (
    !restored ||
    (await deps.focus()) !== attempt.focus ||
    !inventoryEquals(attempt.before, restored)
  )
    return uncertain('Exact-id rollback did not restore the original native inventory.');
  return {
    status: 'rollback-readback',
    sourceId: rollback.sourceId,
    reason,
    persistenceVerified: false,
  };
}

async function verifySavedZone(
  deps: NativeZoneCreateDependencies,
  attempt: ZoneAttempt,
): Promise<NativeZoneCreateResult> {
  if ((await deps.focus()) !== attempt.focus)
    return uncertain('Active PCB changed before the native zone save; no save attempted.');
  if (!(await deps.save())) return uncertain('Native document save did not return true.');
  const persisted = await deps.readInventory();
  if (!persisted || (await deps.focus()) !== attempt.focus)
    return uncertain('Post-save native inventory or PCB focus could not be verified.');
  const final = reconcileZoneCreation(attempt.before, persisted, attempt.expected);
  if (final.status !== 'verified')
    return uncertain('Post-save source/Poured read-back did not match the saved candidate.');
  // Native save(true) and same-session inventory cannot alone prove cold-reopen persistence.
  return {
    status: 'saved-readback',
    sourceId: final.sourceId,
    pouredId: final.pouredId,
    saveReturnedTrue: true,
    persistenceVerified: false,
  };
}

async function rebuildAndVerifyZone(
  deps: NativeZoneCreateDependencies,
  attempt: ZoneAttempt,
  sourceId: string,
): Promise<NativeZoneCreateResult> {
  if ((await deps.focus()) !== attempt.focus)
    return uncertain('Active PCB changed before native copper rebuild; no rebuild attempted.');
  await deps.rebuild(sourceId);
  const afterRebuild = await deps.readInventory();
  if (!afterRebuild || (await deps.focus()) !== attempt.focus)
    return uncertain('Rebuilt copper or unchanged PCB focus could not be verified.');
  const verdict = reconcileZoneCreation(attempt.before, afterRebuild, attempt.expected);
  if (verdict.status !== 'verified')
    return recoverIncompleteZone(deps, attempt, afterRebuild, verdict.reason);
  return verifySavedZone(deps, attempt);
}

/**
 * An async beta native create may become observable after its first getter.
 * One bounded follow-up READ (only when the first snapshot equals baseline)
 * records this disagreement. It never continues the mutation based on a
 * late source, deletes it, clears the persistent fence, or retries create.
 */
async function classifyLateNativeSource(
  deps: NativeZoneCreateDependencies,
  attempt: ZoneAttempt,
): Promise<NativeZoneCreateResult> {
  if ((await deps.focus()) !== attempt.focus)
    return uncertain('Active PCB changed before bounded read-only follow-up inventory.');
  const later = await deps.readInventory();
  if (!later || (await deps.focus()) !== attempt.focus)
    return uncertain('Bounded read-only follow-up inventory or PCB focus is unavailable.');
  const exact = planExactZoneRollback(attempt.before, later, attempt.expected);
  if (exact.safeToDelete)
    return uncertain(
      'A new native source was visible only on a later native inventory read. ' +
        'It still requires independent reconciliation before any further mutation.',
    );
  if (inventoryEquals(attempt.before, later))
    return uncertain('Neither bounded post-create inventory showed a new source.');
  return uncertain('A later native inventory remains unsafe for reconciliation. ' + exact.reason);
}

async function preflightZone(
  deps: NativeZoneCreateDependencies,
  expected: ExpectedZoneSource,
): Promise<ZoneAttempt | undefined> {
  const focus = await deps.focus();
  if (!focus || !(await deps.preflight(expected))) return undefined;
  const before = await deps.readInventory();
  if (!before || (await deps.focus()) !== focus) return undefined;
  if (findMatchingExistingZoneSources(before, expected).length > 0)
    throw new ExistingNativeZonePlanError(
      'An existing identical native Pour already matches this plan; do not retry.',
    );
  return { focus, before, expected };
}

export function createNativeZoneCandidateOperation(deps: NativeZoneCreateDependencies) {
  let inProgress = false;
  let reconciliationRequired = false;
  async function execute(expected: ExpectedZoneSource): Promise<NativeZoneCreateResult> {
    if (inProgress)
      return { status: 'blocked', reason: 'A native zone creation is already in progress.' };
    if (reconciliationRequired)
      return {
        status: 'blocked',
        reason:
          'Previous native zone write requires independent reconciliation; no automatic retry.',
      };
    if (!measuredNativeZoneSettings(expected))
      return {
        status: 'blocked',
        reason:
          'Native zone settings are unverified: only solid fill, keep islands=true, ' +
          'priority=1, line width=0.2, unlocked GND/BOTTOM are accepted by this candidate.',
      };
    inProgress = true;
    let reservationGranted = false;
    try {
      const attempt = await preflightZone(deps, expected);
      if (!attempt)
        return {
          status: 'blocked',
          reason: 'Exact PCB identity, net, outline or inventory preflight failed.',
        };
      if (!(await deps.reserveMutation({ focus: attempt.focus, before: attempt.before, expected })))
        return {
          status: 'blocked',
          reason: 'Persistent native write fence requires independent reconciliation; no retry.',
        };
      // The host lease and pending native fence may now survive this session.
      // Even a focus failure before the first native API write requires
      // independent recovery; the in-memory candidate must not attempt again.
      reservationGranted = true;
      reconciliationRequired = true;
      if ((await deps.focus()) !== attempt.focus)
        return uncertain('Active PCB changed after write reservation; no native create attempted.');
      await deps.create(expected);
      const afterCreate = await deps.readInventory();
      if (!afterCreate || (await deps.focus()) !== attempt.focus)
        return uncertain(
          'The new Pour inventory or active PCB could not be verified after create.',
        );
      const candidate = planExactZoneRollback(attempt.before, afterCreate, expected);
      if (!candidate.safeToDelete) {
        if (inventoryEquals(attempt.before, afterCreate))
          return classifyLateNativeSource(deps, attempt);
        return uncertain(
          'Create did not produce exactly one identifiable matching native Pour. ' +
            candidate.reason,
        );
      }
      const result = await rebuildAndVerifyZone(deps, attempt, candidate.sourceId);
      // No same-session result proves persistence across an editor restart.
      // The dispatcher remains locked until an independent cold-reopen check exists.
      return result;
    } catch (error) {
      // A plan collision is our own fixed, non-sensitive diagnostic. All
      // native-provided errors must stay opaque, including preflight failures.
      if (error instanceof ExistingNativeZonePlanError)
        return { status: 'blocked', reason: error.message };
      return reservationGranted
        ? uncertain('Native zone operation failed after reservation; recovery is required.')
        : {
            status: 'blocked',
            reason: 'Native zone preflight or reservation failed; no native create was attempted.',
          };
    } finally {
      inProgress = false;
    }
  }
  return { execute };
}
