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
    name: type === 3 ? 'Production PCB' : 'Schematic page',
    documentType: type,
    parentProjectUuid: 'project-1',
  }));
  const global = {
    DMT_SelectControl: { getCurrentDocumentInfo },
    DMT_Project: { getCurrentProjectInfo: async () => ({ uuid: 'project-1' }) },
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

  it('allows the intended focused PCB and echoes its identity', async () => {
    const { dispatcher, mutateTrack } = makeDispatcher('board-copy');
    const result = await dispatcher.dispatch('pcb.addTrack', addTrack);
    expect(mutateTrack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      targetDocument: { uuid: 'board-copy', name: 'Production PCB', documentType: 'pcb' },
    });
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
    return {
      readFirstPath: <T>(paths: readonly string[]): T | undefined => {
        if (paths[0] === 'DMT_SelectControl') return { getCurrentDocumentInfo } as T;
        if (paths[0] === 'DMT_Project') return { getCurrentProjectInfo } as T;
        return undefined;
      },
      getCurrentDocumentInfo,
      getCurrentProjectInfo,
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

  it('accepts a matching schematic page and returns its identity without an optional name', async () => {
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
    expect(result).toEqual({ uuid: 'page-2', documentType: 'schematic' });
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

  it('does not attach evidence to arrays, scalars or absent targets', () => {
    const evidence = { uuid: 'expected-board', documentType: 'pcb' as const };
    expect(withTargetDocumentEvidence([1, 2], evidence)).toEqual([1, 2]);
    expect(withTargetDocumentEvidence('ok', evidence)).toBe('ok');
    expect(withTargetDocumentEvidence({ count: 1 })).toEqual({ count: 1 });
    expect(withTargetDocumentEvidence({ count: 1 }, evidence)).toEqual({
      count: 1,
      targetDocument: evidence,
    });
  });
});
