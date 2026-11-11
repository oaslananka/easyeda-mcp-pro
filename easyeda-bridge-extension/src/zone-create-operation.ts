import {
  findMatchingExistingZoneSources,
  planExactZoneRollback,
  reconcileZoneCreation,
  type ExpectedZoneSource,
  type ZoneInventory,
} from './zone-create-evidence.js';

// Candidate operation is intentionally NOT attached to pcb.addZone or exposed
// to the public MCP write path until disposable end-to-end acceptance.
// A future adapter must supply a real zero-write exact-focus/geometry preflight.
export interface NativeZoneCreateDependencies {
  focus(): Promise<string | undefined>;
  preflight(): Promise<boolean>;
  readInventory(): Promise<ZoneInventory | undefined>;
  create(expected: ExpectedZoneSource): Promise<unknown>;
  rebuild(sourceId: string): Promise<unknown>;
  save(): Promise<boolean>;
  deleteSource(sourceId: string): Promise<boolean>;
}

export type NativeZoneCreateResult =
  | {
      status: 'saved-readback';
      sourceId: string;
      pouredId: string;
      saveReturnedTrue: true;
      persistenceVerified: false;
    }
  | { status: 'rolled-back'; sourceId: string; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'uncertain'; reason: string };

interface ZoneAttempt {
  focus: string;
  before: ZoneInventory;
  expected: ExpectedZoneSource;
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
    return uncertain('New copper is unverified and exact-id rollback is unavailable.');
  if ((await deps.focus()) !== attempt.focus)
    return uncertain('Focus changed before rollback; no deletion attempted.');
  if (!(await deps.deleteSource(rollback.sourceId)) || !(await deps.save()))
    return uncertain('Exact-id rollback failed or could not be saved.');
  const restored = await deps.readInventory();
  if (
    !restored ||
    (await deps.focus()) !== attempt.focus ||
    !inventoryEquals(attempt.before, restored)
  )
    return uncertain('Exact-id rollback did not restore the original native inventory.');
  return { status: 'rolled-back', sourceId: rollback.sourceId, reason };
}

async function verifySavedZone(
  deps: NativeZoneCreateDependencies,
  attempt: ZoneAttempt,
): Promise<NativeZoneCreateResult> {
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
  await deps.rebuild(sourceId);
  const afterRebuild = await deps.readInventory();
  if (!afterRebuild || (await deps.focus()) !== attempt.focus)
    return uncertain('Rebuilt copper or unchanged PCB focus could not be verified.');
  const verdict = reconcileZoneCreation(attempt.before, afterRebuild, attempt.expected);
  if (verdict.status !== 'verified')
    return recoverIncompleteZone(deps, attempt, afterRebuild, verdict.status);
  return verifySavedZone(deps, attempt);
}

async function preflightZone(
  deps: NativeZoneCreateDependencies,
  expected: ExpectedZoneSource,
): Promise<ZoneAttempt | undefined> {
  const focus = await deps.focus();
  if (!focus || !(await deps.preflight())) return undefined;
  const before = await deps.readInventory();
  if (!before || (await deps.focus()) !== focus) return undefined;
  if (findMatchingExistingZoneSources(before, expected).length > 0)
    throw new Error('An existing identical native Pour already matches this plan; do not retry.');
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
    inProgress = true;
    let nativeMutationStarted = false;
    try {
      const attempt = await preflightZone(deps, expected);
      if (!attempt)
        return {
          status: 'blocked',
          reason: 'Exact PCB identity, net, outline or inventory preflight failed.',
        };
      nativeMutationStarted = true;
      reconciliationRequired = true;
      await deps.create(expected);
      const afterCreate = await deps.readInventory();
      if (!afterCreate || (await deps.focus()) !== attempt.focus)
        return uncertain(
          'The new Pour inventory or active PCB could not be verified after create.',
        );
      const candidate = planExactZoneRollback(attempt.before, afterCreate, expected);
      if (!candidate.safeToDelete)
        return uncertain('Create did not produce exactly one identifiable matching native Pour.');
      const result = await rebuildAndVerifyZone(deps, attempt, candidate.sourceId);
      if (result.status === 'saved-readback' || result.status === 'rolled-back')
        reconciliationRequired = false;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return nativeMutationStarted
        ? uncertain('Native zone create/rebuild/save raised: ' + message)
        : { status: 'blocked', reason: 'Read-only preflight raised: ' + message };
    } finally {
      inProgress = false;
    }
  }
  return { execute };
}
