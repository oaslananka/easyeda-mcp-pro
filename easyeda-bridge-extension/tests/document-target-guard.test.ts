import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/dispatcher.js';
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
