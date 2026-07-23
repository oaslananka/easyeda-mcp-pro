import { describe, expect, it, vi } from 'vitest';
import { createPcbMutationOperations } from '../src/pcb-mutation-operations.js';

function createOperations() {
  const callFirst = vi.fn(async (_paths: readonly string[], ...args: unknown[]) => ({ args }));
  const deletePrimitives = vi.fn(
    async (ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> => ({
      deleted: ids.filter((id) => id !== 'missing'),
      notFound: ids.filter((id) => id === 'missing'),
    }),
  );
  return {
    callFirst,
    deletePrimitives,
    operations: createPcbMutationOperations({ callFirst, deletePrimitives }),
  };
}

describe('createPcbMutationOperations', () => {
  it('creates zones with the existing EasyEDA path order and arguments', async () => {
    const { callFirst, operations } = createOperations();
    const params = {
      points: [0, 0, 10, 0, 10, 10],
      layer: 1,
      netName: 'GND',
      clearance: 0.2,
    };

    await operations.addZone(params);

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitivePour.create', 'PCB_ComplexPolygon.create', 'pcb_PrimitivePour.create'],
      params.points,
      params.layer,
      params.netName,
      params.clearance,
    );
  });

  it('modifies components with the existing primitive id and property order', async () => {
    const { callFirst, operations } = createOperations();
    const property = { X: 12, Y: 34, Rotation: 90 };

    await operations.modifyComponent({ primitiveId: 'component-1', property });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
      'component-1',
      property,
    );
  });

  it('normalizes complete and partial deletion results without throwing', async () => {
    const { deletePrimitives, operations } = createOperations();

    await expect(
      operations.deleteComponents({ primitiveIds: ['component-1', 'missing'] }),
    ).resolves.toEqual({
      success: false,
      deletedCount: 1,
      deleted: ['component-1'],
      notFound: ['missing'],
    });
    expect(deletePrimitives).toHaveBeenCalledWith(['component-1', 'missing']);
  });

  it('treats a non-array primitiveIds value as an empty deletion request', async () => {
    const { deletePrimitives, operations } = createOperations();

    await expect(operations.deleteComponents({ primitiveIds: 'component-1' })).resolves.toEqual({
      success: true,
      deletedCount: 0,
      deleted: [],
      notFound: [],
    });
    expect(deletePrimitives).toHaveBeenCalledWith([]);
  });
});
