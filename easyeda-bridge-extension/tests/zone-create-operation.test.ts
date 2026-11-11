import { describe, expect, it, vi } from 'vitest';
import { createNativeZoneCandidateOperation } from '../src/zone-create-operation.js';
import type {
  ExpectedZoneSource,
  ZoneInventory,
  ZoneSourceEvidence,
  ZoneDerivedEvidence,
} from '../src/zone-create-evidence.js';

const expected: ExpectedZoneSource = {
  net: 'GND',
  layer: 2,
  polygonSignature: JSON.stringify(['R', 12, -20, 40, 30, 0, 0]),
  fillMethod: 'solid',
  preserveSilos: true,
  pourName: 'GND_NEW',
  pourPriority: 1,
  lineWidth: 0.2,
  locked: false,
};
const old: ZoneSourceEvidence = {
  sourceId: 'e336',
  ...expected,
  layer: 1,
  polygonSignature: JSON.stringify(['R', 0, 0, 300, 200, 0, 0]),
};
const newer: ZoneSourceEvidence = { sourceId: 'new-source', ...expected };
const oldCopper: ZoneDerivedEvidence = {
  sourceId: 'e336',
  pouredId: 'e336',
  fillSignature: 'old-fills',
  hasFilledGeometry: true,
};
const newCopper: ZoneDerivedEvidence = {
  sourceId: 'new-source',
  pouredId: 'new-source',
  fillSignature: 'filled-polygons',
  hasFilledGeometry: true,
};
const inventory = (
  created = false,
  filled = false,
  extra: ZoneSourceEvidence[] = [],
): ZoneInventory => ({
  sources: new Map([
    [old.sourceId, old],
    ...(created ? [[newer.sourceId, newer] as const] : []),
    ...extra.map((item) => [item.sourceId, item] as const),
  ]),
  derived: new Map([
    [oldCopper.sourceId, oldCopper],
    ...(filled ? [[newCopper.sourceId, newCopper] as const] : []),
  ]),
});
const baseline = inventory();
const created = inventory(true);
const filled = inventory(true, true);

function fixture(
  readbacks: Array<ZoneInventory | undefined> = [baseline, created, filled, filled],
) {
  const focus = vi.fn(async () => 'focus-project+pcb');
  const preflight = vi.fn(async () => true);
  const readInventory = vi.fn().mockImplementation(async () => readbacks.shift());
  const create = vi.fn(async () => ({ getState_PrimitiveId: () => 'e336' })); // stale beta return
  const rebuild = vi.fn(async (_sourceId: string) => ({ getState_PourPrimitiveId: () => 'e336' }));
  const save = vi.fn(async () => true);
  const deleteSource = vi.fn(async (_id: string) => true);
  const reserveMutation = vi.fn(async (_reservation: unknown) => true);
  return {
    deps: { focus, preflight, readInventory, create, rebuild, save, deleteSource, reserveMutation },
    focus,
    preflight,
    readInventory,
    create,
    rebuild,
    save,
    deleteSource,
    reserveMutation,
  };
}

describe('single native zone creation operation with no blind retries', () => {
  it('verifies a new true-filled target through snapshots regardless of beta stale returns', async () => {
    const f = fixture();
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toEqual({
      status: 'saved-readback',
      sourceId: 'new-source',
      pouredId: 'new-source',
      saveReturnedTrue: true,
      persistenceVerified: false,
    });
    expect(f.preflight).toHaveBeenCalledExactlyOnceWith(expected);
    expect(f.create).toHaveBeenCalledExactlyOnceWith(expected);
    expect(f.rebuild).toHaveBeenCalledExactlyOnceWith('new-source');
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it('refuses rebuild when the selected PCB changes after create reconciliation', async () => {
    const f = fixture();
    f.focus
      .mockResolvedValueOnce('focus-project+pcb') // preflight
      .mockResolvedValueOnce('focus-project+pcb') // preflight inventory
      .mockResolvedValueOnce('focus-project+pcb') // post-create inventory
      .mockResolvedValueOnce('different-project+pcb'); // immediately before rebuild
    const outcome = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(outcome).toMatchObject({ status: 'uncertain' });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('refuses save when selected PCB changes after the rebuilt copper readback', async () => {
    const f = fixture();
    f.focus
      .mockResolvedValueOnce('focus-project+pcb') // preflight
      .mockResolvedValueOnce('focus-project+pcb') // preflight inventory
      .mockResolvedValueOnce('focus-project+pcb') // post-create inventory
      .mockResolvedValueOnce('focus-project+pcb') // before rebuild
      .mockResolvedValueOnce('focus-project+pcb') // after rebuilt copper
      .mockResolvedValueOnce('different-project+pcb'); // before save
    const outcome = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(outcome).toMatchObject({ status: 'uncertain' });
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('reserves before any native mutation after the read-only preflight', async () => {
    const f = fixture();
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(expected),
    ).resolves.toMatchObject({
      status: 'saved-readback',
    });
    expect(f.reserveMutation).toHaveBeenCalledExactlyOnceWith({
      focus: 'focus-project+pcb',
      before: baseline,
      expected,
    });
    expect(f.reserveMutation.mock.invocationCallOrder[0]).toBeLessThan(
      f.create.mock.invocationCallOrder[0],
    );
  });

  it.each(['denied', 'exception'] as const)(
    'fails closed if a durable write-ahead reservation returns %s',
    async (caseName) => {
      const f = fixture();
      if (caseName === 'denied') f.reserveMutation.mockResolvedValue(false);
      else f.reserveMutation.mockRejectedValue(Error('storage denied'));
      await expect(
        createNativeZoneCandidateOperation(f.deps).execute(expected),
      ).resolves.toMatchObject({
        status: 'blocked',
      });
      expect(f.reserveMutation).toHaveBeenCalledOnce();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.rebuild).not.toHaveBeenCalled();
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it('blocks native create if the editor focus changes immediately after persisting a fence', async () => {
    const f = fixture();
    f.focus
      .mockResolvedValueOnce('focus-project+pcb')
      .mockResolvedValueOnce('focus-project+pcb')
      .mockResolvedValueOnce('other-project+pcb');
    const result = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('changed after write reservation'),
    });
    expect(f.reserveMutation).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not reserve a slot when the purely read-only preflight fails', async () => {
    const f = fixture();
    f.preflight.mockResolvedValue(false);
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(expected),
    ).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(f.reserveMutation).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it('keeps the write fence after same-session save because cold-reopen persistence is not verified', async () => {
    const f = fixture();
    const operation = createNativeZoneCandidateOperation(f.deps);
    await expect(operation.execute(expected)).resolves.toMatchObject({
      status: 'saved-readback',
      persistenceVerified: false,
    });
    await expect(
      operation.execute({ ...expected, pourName: 'GND_ANOTHER' }),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('reconciliation'),
    });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('does not create an identical second zone after reconnect when the first is already inventoried', async () => {
    const f = fixture([filled]);
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('existing'),
    });
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([
    ['priority silently normalized by native API', { ...expected, pourPriority: 5 }],
    ['line width silently normalized by native API', { ...expected, lineWidth: 10 }],
    ['island preservation not live-verified', { ...expected, preserveSilos: false }],
    ['primitive lock mode not live-verified', { ...expected, locked: true }],
    ['TOP creation not live-verified', { ...expected, layer: 1 }],
    ['non-GND creation not live-verified', { ...expected, net: 'VCC' }],
    ['inner copper layer not live-verified', { ...expected, layer: 15 }],
    ['fill mode not live-verified', { ...expected, fillMethod: 'hatched' }],
  ] as const)('blocks %s before even one native create', async (_, settings) => {
    const f = fixture();
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(settings),
    ).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not mutate when exact preflight or focus is unavailable', async () => {
    const f = fixture();
    f.preflight.mockResolvedValue(false);
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(expected),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
    const g = fixture();
    g.focus.mockResolvedValue(undefined as unknown as string);
    await expect(
      createNativeZoneCandidateOperation(g.deps).execute(expected),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(g.create).not.toHaveBeenCalled();
  });

  it('never retries a native create that threw after it may have written', async () => {
    const f = fixture([baseline]);
    f.create.mockRejectedValue(Error('native write timed out'));
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'uncertain' });
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it.each(['create', 'rebuild', 'save'] as const)(
    'redacts sensitive native %s exception details and holds the candidate fence',
    async (step) => {
      const f = fixture();
      const secret = 'private-GND:/home/user/secret-board.eprj2/token-123';
      f[step].mockRejectedValue(Error(secret));
      const op = createNativeZoneCandidateOperation(f.deps);
      const result = await op.execute(expected);
      expect(result).toMatchObject({
        status: 'uncertain',
        reason: expect.stringContaining('Native zone operation failed'),
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.deleteSource).not.toHaveBeenCalled();
    },
  );

  it.each(['preflight', 'reserveMutation'] as const)(
    'redacts sensitive %s failures before the first native create',
    async (step) => {
      const f = fixture();
      const secret = 'private-project-source-id:user-token-and-path';
      f[step].mockRejectedValue(Error(secret));
      const result = await createNativeZoneCandidateOperation(f.deps).execute(expected);
      expect(result).toMatchObject({
        status: 'blocked',
        reason: expect.stringContaining('Native zone preflight or reservation failed'),
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.rebuild).not.toHaveBeenCalled();
    },
  );

  it('does not treat a native create returning undefined as failure when readback identifies one new source', async () => {
    const f = fixture();
    f.create.mockResolvedValue(undefined);
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(expected),
    ).resolves.toMatchObject({ status: 'saved-readback' });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('classifies a source appearing only on a second read-only observation without rebuilding or retrying', async () => {
    const f = fixture([baseline, baseline, created]);
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('visible only on a later native inventory read'),
    });
    expect(f.readInventory).toHaveBeenCalledTimes(3);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
  });

  it('does not call create again when neither bounded post-create observation shows a native source', async () => {
    const f = fixture([baseline, baseline, baseline]);
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('Neither bounded post-create inventory showed a new source'),
    });
    expect(f.readInventory).toHaveBeenCalledTimes(3);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('keeps the marker unresolved if PCB focus changes before the late read-only observation', async () => {
    const f = fixture([baseline, baseline, created]);
    f.focus
      .mockResolvedValueOnce('focus-project+pcb')
      .mockResolvedValueOnce('focus-project+pcb')
      .mockResolvedValueOnce('focus-project+pcb')
      .mockResolvedValueOnce('focus-project+pcb')
      .mockResolvedValueOnce('different-project+pcb');
    const result = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(result).toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('Active PCB changed before bounded read-only follow-up'),
    });
    expect(f.readInventory).toHaveBeenCalledTimes(2);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it('treats a failed second read-only inventory as unresolved and never retries create', async () => {
    const f = fixture([baseline, baseline, undefined]);
    const result = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(result).toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('Bounded read-only follow-up inventory'),
    });
    expect(f.readInventory).toHaveBeenCalledTimes(3);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it('refuses a later read-only source snapshot when the original copper changed', async () => {
    const second = inventory(true);
    second.derived.set('e336', { ...oldCopper, fillSignature: 'private-current-copper-drift' });
    const f = fixture([baseline, baseline, second]);
    const result = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(result).toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('Existing sources or copper changed; safe rollback'),
    });
    expect(JSON.stringify(result)).not.toContain('private-current-copper-drift');
    expect(f.readInventory).toHaveBeenCalledTimes(3);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('does not blindly delete a source after a rebuild error with uncertain pending native work', async () => {
    const f = fixture([baseline, created]);
    f.rebuild.mockRejectedValue(Error('native beta timeout'));
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'uncertain' });
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it('rolls back a known exact source when rebuild completed without any filled copper', async () => {
    const f = fixture([baseline, created, created, baseline]);
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({
      status: 'rollback-readback',
      sourceId: 'new-source',
      reason: 'The post-write Pour/Poured inventory has an ambiguous delta.',
      persistenceVerified: false,
    });
    expect(f.deleteSource).toHaveBeenCalledExactlyOnceWith('new-source');
    expect(f.save).toHaveBeenCalledOnce();
    // No cold-reopen proof: the in-process write fence must still hold.
    expect(await op.execute(expected)).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('reconciliation'),
    });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('does not save a deleted source if focus changed during exact-id rollback', async () => {
    const f = fixture([baseline, created, created]);
    f.deleteSource.mockImplementation(async () => {
      f.focus.mockResolvedValue('different-project+pcb');
      return true;
    });
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(expected),
    ).resolves.toMatchObject({
      status: 'uncertain',
    });
    expect(f.deleteSource).toHaveBeenCalledExactlyOnceWith('new-source');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('fences all subsequent writes if exact-id rollback did not recover the original inventory', async () => {
    const f = fixture([baseline, created, created, created]);
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'uncertain' });
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.deleteSource).toHaveBeenCalledExactlyOnceWith('new-source');
  });

  it('explains a post-create source-property mismatch without leaking native values or retrying', async () => {
    const wrongSource = { ...newer, net: 'private-net-mismatch' };
    const f = fixture([baseline, inventory(false, false, [wrongSource])]);
    const op = createNativeZoneCandidateOperation(f.deps);
    const result = await op.execute(expected);
    expect(result).toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining(
        'The only new source is not a verified match for the requested plan.',
      ),
    });
    expect(JSON.stringify(result)).not.toContain('private-net-mismatch');
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(await op.execute(expected)).toMatchObject({ status: 'blocked' });
  });

  it('distinguishes a changed original Pour/Poured from a missing new source', async () => {
    const changedOldCopper: ZoneDerivedEvidence = {
      ...oldCopper,
      fillSignature: 'private-baseline-signature-changed',
    };
    const after = inventory(true);
    after.derived.set(oldCopper.sourceId, changedOldCopper);
    const f = fixture([baseline, after]);
    const result = await createNativeZoneCandidateOperation(f.deps).execute(expected);
    expect(result).toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('Existing sources or copper changed; safe rollback'),
    });
    expect(JSON.stringify(result)).not.toContain(changedOldCopper.fillSignature);
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.deleteSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('retains the original reconciliation failure when post-rebuild native copper changed', async () => {
    const after = inventory(true);
    after.derived.set('e336', { ...oldCopper, fillSignature: 'private-after-rebuild-fill' });
    const f = fixture([baseline, created, after]);
    const op = createNativeZoneCandidateOperation(f.deps);
    const result = await op.execute(expected);
    expect(result).toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining(
        'An existing Pour or Poured geometry changed; outcome is not isolated.',
      ),
    });
    expect(JSON.stringify(result)).not.toContain('private-after-rebuild-fill');
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.deleteSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(await op.execute(expected)).toMatchObject({ status: 'blocked' });
  });

  it('does not guess which source to remove after two new Pours appeared', async () => {
    const duplicate = inventory(true, false, [{ ...newer, sourceId: 'unrelated' }]);
    const f = fixture([baseline, duplicate]);
    await expect(
      createNativeZoneCandidateOperation(f.deps).execute(expected),
    ).resolves.toMatchObject({
      status: 'uncertain',
      reason: expect.stringContaining('No unique native source appeared for exact-id rollback.'),
    });
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it('treats failed or ambiguous native save as unresolved persistence', async () => {
    const f = fixture();
    f.save.mockResolvedValue(false);
    const op = createNativeZoneCandidateOperation(f.deps);
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'uncertain' });
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.deleteSource).not.toHaveBeenCalled();
  });

  it('prevents another create while an existing native operation is unresolved', async () => {
    const f = fixture();
    let unblock: (value: unknown) => void = () => undefined;
    f.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          unblock = resolve;
        }),
    );
    const op = createNativeZoneCandidateOperation(f.deps);
    const first = op.execute(expected);
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
    await expect(op.execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    unblock(undefined);
    await expect(first).resolves.toMatchObject({ status: 'saved-readback' });
    expect(f.create).toHaveBeenCalledOnce();
  });
});
