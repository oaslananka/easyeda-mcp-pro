import { describe, expect, it, vi } from 'vitest';
import { createSchematicSnapshotRecreator } from '../src/schematic-snapshot-recreation.js';
import type {
  SchematicPrimitiveSnapshot,
  SchematicPrimitiveSnapshotKind,
} from '../src/schematic-transaction-operations.js';

function snapshot(
  primitiveKind: SchematicPrimitiveSnapshotKind,
  property: Record<string, unknown>,
): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1' as const,
    primitiveId: `${primitiveKind}-old`,
    primitiveKind,
    property,
  };
}

describe('createSchematicSnapshotRecreator', () => {
  it('exposes the exact supported rollback creation kinds', () => {
    const recreator = createSchematicSnapshotRecreator({
      callFirst: vi.fn(),
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
    });

    expect(recreator.supportedKinds).toEqual(['circle', 'polygon', 'rectangle', 'text', 'wire']);
  });

  it('constructs wire and annotation primitives with the established native arguments', async () => {
    const callFirst = vi.fn(async () => ({ primitiveId: 'created' }));
    const recreator = createSchematicSnapshotRecreator({
      callFirst,
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 7),
    });

    await recreator.create(snapshot('wire', { line: [0, 0, 1, 1], net: 'GND' }));
    await recreator.create(snapshot('text', { x: 1, y: 2, content: 'note', alignMode: 7 }));
    await recreator.create(snapshot('rectangle', { x: 3, y: 4, width: 5, height: 6 }));

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
      [0, 0, 1, 1],
      'GND',
      undefined,
      undefined,
      undefined,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['SCH_PrimitiveText.create', 'sch_PrimitiveText.create'],
      1,
      -2,
      'note',
      0,
      '#000000',
      'Arial',
      20,
      false,
      false,
      false,
      7,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      3,
      ['SCH_PrimitiveRectangle.create', 'sch_PrimitiveRectangle.create'],
      3,
      -4,
      5,
      6,
      0,
      0,
      '#000000',
      'none',
      1,
      0,
      'none',
    );
  });

  it('constructs circle and polygon primitives with established defaults', async () => {
    const callFirst = vi.fn(async () => ({ primitiveId: 'created' }));
    const recreator = createSchematicSnapshotRecreator({
      callFirst,
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
    });

    await recreator.create(snapshot('circle', { centerX: 1, centerY: 2, radius: 3 }));
    await recreator.create(snapshot('polygon', { line: [0, 0, 2, 2] }));

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['SCH_PrimitiveCircle.create', 'sch_PrimitiveCircle.create'],
      1,
      2,
      3,
      '#000000',
      'none',
      1,
      0,
      'none',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['SCH_PrimitivePolygon.create', 'sch_PrimitivePolygon.create'],
      [0, 0, 2, 2],
      '#000000',
      'none',
      1,
      0,
    );
  });

  it('fails closed for incomplete snapshot fields and unsupported creation kinds', async () => {
    const createBridgeError = vi.fn((code, message) => Object.assign(new Error(message), { code }));
    const recreator = createSchematicSnapshotRecreator({
      callFirst: vi.fn(),
      createBridgeError,
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
    });

    await expect(
      recreator.create(snapshot('circle', { centerX: Number.NaN, centerY: 2, radius: 3 })),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(recreator.create(snapshot('component', {}))).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
  });
});
