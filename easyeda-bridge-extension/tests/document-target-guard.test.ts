import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/dispatcher.js';
import {
  assertExpectedDocument,
  withTargetDocumentEvidence,
} from '../src/document-target-guard.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

function makeDispatcher(focusedUuid: string, type = 3) {
  const mutateTrack = vi.fn(async () => ({ getState_PrimitiveId: () => 'new-track' }));
  const deleteLine = vi.fn(async () => true);
  const modifySchematic = vi.fn(async () => true);
  const getCurrentDocumentInfo = vi.fn(async () => ({
    uuid: focusedUuid,
    documentType: type,
    parentProjectUuid: 'project-1',
  }));
  const getCurrentProjectInfo = vi.fn(async () => ({ uuid: 'project-1' }));
  const global = {
    DMT_SelectControl: { getCurrentDocumentInfo },
    DMT_Project: { getCurrentProjectInfo },
    DMT_Pcb: {
      getCurrentPcbInfo: async () => ({
        uuid: focusedUuid,
        name: 'Production PCB',
        parentProjectUuid: 'project-1',
      }),
    },
    DMT_Schematic: {
      getCurrentSchematicPageInfo: async () => ({ uuid: focusedUuid, name: 'Schematic page' }),
    },
    PCB_PrimitiveLine: { create: mutateTrack, delete: deleteLine },
    SCH_PrimitiveComponent: { modify: modifySchematic },
  };
  const toolkit: DispatcherToolkit = {
    getEda: () => global,
    getEDA: () => undefined,
    getApi: () => undefined,
    getGlobal: () => global,
    log: () => {},
    showToast: () => {},
    getBridgeMaxPayloadSize: () => 1_048_576,
    getBridgeVersion: () => '1.0.0',
  };
  return {
    dispatcher: createDispatcher(toolkit),
    mutateTrack,
    deleteLine,
    modifySchematic,
    getCurrentDocumentInfo,
    getCurrentProjectInfo,
  };
}

const addTrack = {
  expectedPcbUuid: 'board-copy',
  netName: 'GND',
  layer: 1,
  width: 0.2,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ],
};

describe('target document guard #946', () => {
  it('refuses wrong focused PCB even when primitive IDs are identical', async () => {
    const { dispatcher, mutateTrack, deleteLine } = makeDispatcher('production-board');
    await expect(dispatcher.dispatch('pcb.addTrack', addTrack)).rejects.toMatchObject({
      code: 'TARGET_DOCUMENT_MISMATCH',
    });
    await expect(
      dispatcher.dispatch('api.call', {
        path: 'PCB_PrimitiveLine.delete',
        args: ['shared-id'],
        expectedPcbUuid: 'board-copy',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_DOCUMENT_MISMATCH' });
    expect(mutateTrack).not.toHaveBeenCalled();
    expect(deleteLine).not.toHaveBeenCalled();
  });

  it('names the actual focused PCB on wrong-target rejection when the selector lacks a name', async () => {
    const { dispatcher, mutateTrack } = makeDispatcher('production-board');
    await expect(dispatcher.dispatch('pcb.addTrack', addTrack)).rejects.toMatchObject({
      code: 'TARGET_DOCUMENT_MISMATCH',
      message: expect.stringContaining('Production PCB'),
      data: expect.objectContaining({
        focusedUuid: 'production-board',
        focusedName: 'Production PCB',
      }),
    });
    expect(mutateTrack).not.toHaveBeenCalled();
  });

  it('allows the intended focused PCB and echoes its identity', async () => {
    const { dispatcher, mutateTrack } = makeDispatcher('board-copy');
    const result = await dispatcher.dispatch('pcb.addTrack', addTrack);
    expect(mutateTrack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      targetDocument: { uuid: 'board-copy', name: 'Production PCB', documentType: 'pcb' },
    });
  });

  it('refuses a copied PCB in the wrong project before any native mutation', async () => {
    const { dispatcher, mutateTrack } = makeDispatcher('board-copy');
    await expect(
      dispatcher.dispatch('pcb.addTrack', {
        ...addTrack,
        expectedProjectUuid: 'different-project',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_PROJECT_MISMATCH' });
    expect(mutateTrack).not.toHaveBeenCalled();
  });

  it('echoes source project identity only for a matching explicit project expectation', async () => {
    const { dispatcher, mutateTrack } = makeDispatcher('board-copy');
    const result = await dispatcher.dispatch('pcb.addTrack', {
      ...addTrack,
      expectedProjectUuid: 'project-1',
    });
    expect(mutateTrack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      targetDocument: {
        uuid: 'board-copy',
        name: 'Production PCB',
        documentType: 'pcb',
        projectUuid: 'project-1',
      },
    });
  });

  it('rechecks focus after an async project-bound native zone preview', async () => {
    const { dispatcher, getCurrentDocumentInfo, mutateTrack } = makeDispatcher('board-copy');
    const result = await dispatcher.dispatch('pcb.zonePreflight', {
      netName: 'GND',
      layer: 2,
      expectedPcbUuid: 'board-copy',
      expectedProjectUuid: 'project-1',
    });
    expect(result).toMatchObject({
      readyToApply: false,
      targetDocument: {
        uuid: 'board-copy',
        projectUuid: 'project-1',
        documentType: 'pcb',
      },
    });
    expect(getCurrentDocumentInfo.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mutateTrack).not.toHaveBeenCalled();
  });

  it.each([
    ['another PCB', { uuid: 'other-board', parentProjectUuid: 'project-1' }],
    ['a copied PCB in another project', { uuid: 'board-copy', parentProjectUuid: 'other-project' }],
  ] as const)(
    'discards stale zone preview target evidence after focus switches to %s',
    async (_, switched) => {
      const { dispatcher, getCurrentDocumentInfo, getCurrentProjectInfo, mutateTrack } =
        makeDispatcher('board-copy');
      let reads = 0;
      getCurrentDocumentInfo.mockImplementation(async () => {
        reads++;
        return {
          uuid: reads >= 5 ? switched.uuid : 'board-copy',
          documentType: 3,
          parentProjectUuid: reads >= 5 ? switched.parentProjectUuid : 'project-1',
        };
      });
      let projectReads = 0;
      getCurrentProjectInfo.mockImplementation(async () => ({
        uuid: ++projectReads >= 5 ? switched.parentProjectUuid : 'project-1',
      }));
      await expect(
        dispatcher.dispatch('pcb.zonePreflight', {
          netName: 'GND',
          layer: 2,
          expectedPcbUuid: 'board-copy',
          expectedProjectUuid: 'project-1',
        }),
      ).rejects.toMatchObject({ code: 'TARGET_CONTEXT_CHANGED' });
      expect(mutateTrack).not.toHaveBeenCalled();
    },
  );

  it('detects a copied PCB in a different project even without an explicit project guard', async () => {
    const { dispatcher, getCurrentDocumentInfo, getCurrentProjectInfo } =
      makeDispatcher('board-copy');
    let reads = 0;
    getCurrentDocumentInfo.mockImplementation(async () => ({
      uuid: 'board-copy',
      documentType: 3,
      parentProjectUuid: ++reads >= 5 ? 'other-project' : 'project-1',
    }));
    let projectReads = 0;
    getCurrentProjectInfo.mockImplementation(async () => ({
      uuid: ++projectReads >= 5 ? 'other-project' : 'project-1',
    }));
    await expect(
      dispatcher.dispatch('pcb.zonePreflight', {
        netName: 'GND',
        layer: 2,
        expectedPcbUuid: 'board-copy',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_CONTEXT_CHANGED' });
  });

  it('does not leak native focus errors when the post-read target becomes unavailable', async () => {
    const { dispatcher, getCurrentDocumentInfo } = makeDispatcher('board-copy');
    let reads = 0;
    getCurrentDocumentInfo.mockImplementation(async () => {
      if (++reads >= 5) throw new Error('private native document metadata');
      return { uuid: 'board-copy', documentType: 3, parentProjectUuid: 'project-1' };
    });
    const rejection = await dispatcher
      .dispatch('pcb.zonePreflight', {
        netName: 'GND',
        layer: 2,
        expectedPcbUuid: 'board-copy',
        expectedProjectUuid: 'project-1',
      })
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'TARGET_CONTEXT_CHANGED' });
    expect(JSON.stringify(rejection)).not.toContain('private native document metadata');
  });

  it('refuses mismatched schematic identity before any primitive mutation', async () => {
    const { dispatcher, modifySchematic } = makeDispatcher('schematic-actual', 1);
    await expect(
      dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'R1',
        property: { x: 20 },
        expectedSchematicPageUuid: 'schematic-intended',
      }),
    ).rejects.toMatchObject({ code: 'TARGET_DOCUMENT_MISMATCH' });
    expect(modifySchematic).not.toHaveBeenCalled();
  });

  it('fails closed when document identity cannot be verified or expectation is invalid', async () => {
    const { dispatcher, getCurrentDocumentInfo, mutateTrack } = makeDispatcher('board-copy');
    getCurrentDocumentInfo.mockResolvedValueOnce({
      uuid: '',
      name: 'missing',
      documentType: 3,
      parentProjectUuid: 'project-1',
    });
    await expect(dispatcher.dispatch('pcb.addTrack', addTrack)).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    });
    await expect(
      dispatcher.dispatch('pcb.addTrack', { ...addTrack, expectedPcbUuid: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(mutateTrack).not.toHaveBeenCalled();
  });
});

// Exercise the complete native boundary independently of domain handlers.
// An absent or stale native identity must never produce a best-effort write.
describe('document target verification edge cases', () => {
  function errorFactory(code: string, message: string, suggestion: string, data?: unknown): Error {
    return Object.assign(new Error(message), { code, suggestion, data });
  }
  function scopedReaders(documentInfo: unknown, projectInfo: unknown = { uuid: 'project-1' }) {
    const getCurrentDocumentInfo = vi.fn(async () => documentInfo);
    const getCurrentProjectInfo = vi.fn(async () => projectInfo);
    const doc = documentInfo as Record<string, unknown> | null;
    const getCurrentPcbInfo = vi.fn(async () => ({
      uuid: doc?.uuid,
      name: 'Known PCB',
      parentProjectUuid: doc?.parentProjectUuid,
    }));
    const getCurrentSchematicPageInfo = vi.fn(async () => ({
      uuid: doc?.uuid,
      name: 'Known schematic page',
    }));
    return {
      readFirstPath: <T>(paths: readonly string[]): T | undefined => {
        if (paths[0] === 'DMT_SelectControl') return { getCurrentDocumentInfo } as T;
        if (paths[0] === 'DMT_Project') return { getCurrentProjectInfo } as T;
        if (paths[0] === 'DMT_Pcb') return { getCurrentPcbInfo } as T;
        if (paths[0] === 'DMT_Schematic') return { getCurrentSchematicPageInfo } as T;
        return undefined;
      },
      getCurrentDocumentInfo,
      getCurrentProjectInfo,
      getCurrentPcbInfo,
      getCurrentSchematicPageInfo,
    };
  }
  const focused = {
    uuid: 'expected-board',
    name: 'Known PCB',
    documentType: 3,
    parentProjectUuid: 'project-1',
  };

  it('omits an unrequested expectation without touching native focus', async () => {
    const calls = vi.fn();
    await expect(
      assertExpectedDocument('pcb.addTrack', {}, calls, errorFactory),
    ).resolves.toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    { expectedPcbUuid: false },
    { expectedPcbUuid: ' ' },
    { expectedSchematicPageUuid: 34 },
    { expectedSchematicPageUuid: '' },
    { expectedPcbUuid: 'expected-board', expectedSchematicPageUuid: 'page' },
    { expectedProjectUuid: 'project-1' },
    { expectedPcbUuid: 'expected-board', expectedProjectUuid: '' },
    { expectedPcbUuid: 'expected-board', expectedProjectUuid: false },
  ])('rejects malformed or conflicting UUID fields %#', async (params) => {
    const reader = scopedReaders(focused);
    await expect(
      assertExpectedDocument('pcb.addTrack', params, reader.readFirstPath, errorFactory),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(reader.getCurrentDocumentInfo).not.toHaveBeenCalled();
  });

  it.each([
    ['pcb.addTrack', { expectedSchematicPageUuid: 'page' }],
    ['schematic.modifyPrimitive', { expectedPcbUuid: 'expected-board' }],
    ['project.save', { expectedPcbUuid: 'expected-board' }],
    ['api.call', { path: 'SCH_PrimitiveWire.delete', expectedPcbUuid: 'expected-board' }],
    ['api.call', { path: 'PCB_PrimitiveLine.delete', expectedSchematicPageUuid: 'page' }],
  ])('rejects unsafe method/identity pairing for %s', async (method, params) => {
    const reader = scopedReaders(focused);
    await expect(
      assertExpectedDocument(
        method as string,
        params as Record<string, unknown>,
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(reader.getCurrentDocumentInfo).not.toHaveBeenCalled();
  });

  it('accepts a matching guarded native API call and audits its target', async () => {
    const reader = scopedReaders(focused);
    const result = await assertExpectedDocument(
      'api.call',
      {
        path: 'PCB_PrimitiveLine.delete',
        expectedPcbUuid: 'expected-board',
      },
      reader.readFirstPath,
      errorFactory,
    );
    expect(result).toEqual({ uuid: 'expected-board', name: 'Known PCB', documentType: 'pcb' });
    expect(reader.getCurrentDocumentInfo).toHaveBeenCalledOnce();
  });

  it('accepts a matching schematic page and resolves its native page name', async () => {
    const reader = scopedReaders({
      uuid: 'page-2',
      documentType: 1,
      parentProjectUuid: 'project-1',
    });
    const result = await assertExpectedDocument(
      'schematic.modifyPrimitive',
      {
        expectedSchematicPageUuid: 'page-2',
      },
      reader.readFirstPath,
      errorFactory,
    );
    expect(result).toEqual({
      uuid: 'page-2',
      name: 'Known schematic page',
      documentType: 'schematic',
    });
  });

  it('rejects a focused schematic when the expected PCB UUID happens to match', async () => {
    const reader = scopedReaders({
      uuid: 'expected-board',
      documentType: 1,
      parentProjectUuid: 'project-1',
    });
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_DOCUMENT_MISMATCH' });
  });

  it('rejects absent native identity getters', async () => {
    const getter = <T>(): T | undefined => undefined;
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        getter,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it('rejects an error during native identity reads', async () => {
    const reader = scopedReaders(focused);
    reader.getCurrentProjectInfo.mockRejectedValueOnce(new Error('native API unavailable'));
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it.each([
    { uuid: 'expected-board', documentType: 3, parentProjectUuid: 'wrong-project' },
    { uuid: 'expected-board', documentType: 3, parentProjectUuid: 'project-1' },
  ])('rejects absent or mismatched project identity %#', async (document) => {
    const reader = scopedReaders(document, {
      uuid: document.parentProjectUuid === 'wrong-project' ? 'project-1' : '',
    });
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it.each([
    [
      { uuid: 'different-board', name: 'Unexpected PCB', parentProjectUuid: 'project-1' },
      'uuid changed',
    ],
    [
      { uuid: 'expected-board', name: 'Known PCB', parentProjectUuid: 'different-project' },
      'project changed',
    ],
    [{ uuid: 'expected-board', name: '', parentProjectUuid: 'project-1' }, 'empty native name'],
    [{ uuid: 'expected-board', name: '  ', parentProjectUuid: 'project-1' }, 'blank native name'],
    [null, 'native getter returned null'],
  ])('fails closed on native PCB identity disagreement: %s (%s)', async (native) => {
    const reader = scopedReaders(focused);
    reader.getCurrentPcbInfo.mockResolvedValueOnce(native as never);
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it('rejects native metadata read errors after confirming selected document', async () => {
    const reader = scopedReaders(focused);
    reader.getCurrentPcbInfo.mockRejectedValueOnce(new Error('native read failed'));
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it('refuses a guard if the focused document has no native PCB metadata method', async () => {
    const reader = scopedReaders(focused);
    const originalRead = reader.readFirstPath;
    const withoutPcbGetter = <T>(paths: readonly string[]): T | undefined =>
      paths[0] === 'DMT_Pcb' ? undefined : originalRead<T>(paths);
    await expect(
      assertExpectedDocument(
        'pcb.addTrack',
        { expectedPcbUuid: 'expected-board' },
        withoutPcbGetter,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it('refuses a focused schematic page if native page metadata refers to a different page', async () => {
    const reader = scopedReaders({
      uuid: 'schematic-one',
      documentType: 1,
      parentProjectUuid: 'project-1',
    });
    reader.getCurrentSchematicPageInfo.mockResolvedValueOnce({
      uuid: 'schematic-other',
      name: 'Other page',
    });
    await expect(
      assertExpectedDocument(
        'schematic.modifyPrimitive',
        { expectedSchematicPageUuid: 'schematic-one' },
        reader.readFirstPath,
        errorFactory,
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });

  it('does not attach evidence to arrays, scalars or absent targets', () => {
    const evidence = { uuid: 'expected-board', name: 'Known PCB', documentType: 'pcb' as const };
    expect(withTargetDocumentEvidence([1, 2], evidence)).toEqual([1, 2]);
    expect(withTargetDocumentEvidence('ok', evidence)).toBe('ok');
    expect(withTargetDocumentEvidence({ count: 1 })).toEqual({ count: 1 });
    expect(withTargetDocumentEvidence({ count: 1 }, evidence)).toEqual({
      count: 1,
      targetDocument: evidence,
    });
  });
});
