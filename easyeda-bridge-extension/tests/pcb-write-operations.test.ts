import { describe, expect, it, vi } from 'vitest';
import { createPcbWriteOperations } from '../src/pcb-write-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function makeOperations() {
  const callFirst = vi.fn(async (...args: unknown[]) => ({
    primitiveId: `id-${callFirst.mock.calls.length}`,
    args,
  }));
  const extractPrimitiveId = vi.fn((value: unknown) =>
    String((value as { primitiveId?: unknown } | null)?.primitiveId ?? ''),
  );
  return {
    callFirst,
    extractPrimitiveId,
    operations: createPcbWriteOperations({
      callFirst,
      extractPrimitiveId,
      createBridgeError: bridgeError,
    }),
  };
}

describe('PCB write operations', () => {
  it('rejects missing or undersized track point arrays before native calls', async () => {
    const { callFirst, operations } = makeOperations();

    await expect(operations.addTrack({ points: 'not-an-array' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'pcb.addTrack requires at least 2 points',
      suggestion: 'Provide a points array with at least a start and end coordinate.',
    });
    await expect(operations.addTrack({ points: [{ x: 0, y: 0 }] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('creates one native line per consecutive track point pair', async () => {
    const { callFirst, extractPrimitiveId, operations } = makeOperations();

    await expect(
      operations.addTrack({
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
        netName: 'GND',
        layer: 1,
        width: 0.25,
      }),
    ).resolves.toEqual({
      primitiveId: 'id-1',
      primitiveIds: ['id-1', 'id-2'],
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      'GND',
      1,
      1,
      2,
      3,
      4,
      0.25,
      false,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      'GND',
      1,
      3,
      4,
      5,
      6,
      0.25,
      false,
    );
    expect(extractPrimitiveId).toHaveBeenCalledTimes(2);
  });

  it('applies the exact PCB text defaults when optional fields are absent', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.addText({ layer: 3, x: 10, y: 20, text: 'REF' });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
      3,
      10,
      20,
      'REF',
      'NotoSansMonoCJKsc-Regular',
      1,
      0.15,
      0,
      0,
      false,
      0,
      false,
      false,
    );
  });

  it('preserves explicit PCB text values including zero and false', async () => {
    const { callFirst, operations } = makeOperations();
    const params = {
      layer: 4,
      x: 1,
      y: 2,
      text: 'TXT',
      fontFamily: 'CustomFont',
      fontSize: 0,
      lineWidth: 0,
      alignMode: 0,
      rotation: 0,
      reverse: false,
      expansion: 0,
      mirror: false,
      locked: false,
    };

    await operations.addText(params);

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
      4,
      1,
      2,
      'TXT',
      'CustomFont',
      0,
      0,
      0,
      0,
      false,
      0,
      false,
      false,
    );
  });

  it('creates silkscreen lines with an empty net and preserves width fallback', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.addSilkscreenLine({
      layer: 3,
      startX: 1,
      startY: 2,
      endX: 3,
      endY: 4,
    });
    await operations.addSilkscreenLine({
      layer: 3,
      startX: 5,
      startY: 6,
      endX: 7,
      endY: 8,
      lineWidth: 0,
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      '',
      3,
      1,
      2,
      3,
      4,
      0.2,
      false,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      '',
      3,
      5,
      6,
      7,
      8,
      0,
      false,
    );
  });

  it('creates vias with the live-verified native argument order', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.addVia({
      netName: 'VCC',
      x: 100,
      y: 200,
      holeSize: 30,
      outerDiameter: 60,
    });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
      'VCC',
      100,
      200,
      30,
      60,
      0,
      '',
      false,
      undefined,
    );
  });
});
