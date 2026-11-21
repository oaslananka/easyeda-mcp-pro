import { describe, expect, it, vi } from 'vitest';
import { createSchematicSnapshotRecreator } from '../src/schematic-snapshot-recreation.js';
import type {
  SchematicPrimitiveSnapshot,
  SchematicPrimitiveSnapshotKind,
} from '../src/schematic-transaction-operations.js';

const nativeGround = {
  name: 'Ground-GND',
  libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
  uuid: 'af20086a8911a85a',
};

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

  it('does not expose beta net flag reconstruction without explicit fixture capability', async () => {
    const callFirst = vi.fn();
    const recreator = createSchematicSnapshotRecreator({
      callFirst,
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
      getEasyedaVersion: () => '4.1.105',
    });
    await expect(
      recreator.create({
        ...snapshot('netflag', {
          identification: 'Ground',
          net: 'GND',
          x: 1,
          y: 2,
          rotation: 0,
          mirror: false,
        }),
        componentType: 'netflag',
        nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('rejects an unverified or missing native symbol descriptor even when Ground is claimed', async () => {
    const callFirst = vi.fn();
    const recreator = createSchematicSnapshotRecreator({
      callFirst,
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
      getEasyedaVersion: () => '4.1.105',
      allowExperimentalPowerNetFlagRecreation: () => true,
    });
    await expect(
      recreator.create({
        ...snapshot('netflag', {
          identification: 'Ground',
          net: 'GND',
          x: 240,
          y: 250,
          rotation: 0,
          mirror: false,
        }),
        componentType: 'netflag',
        nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    expect(callFirst).not.toHaveBeenCalledWith(
      ['SCH_PrimitiveComponent.createNetFlag', 'sch_PrimitiveComponent.createNetFlag'],
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('recreates an exact native power net flag with all typed arguments', async () => {
    const callFirst = vi.fn(async (paths: string[]) => {
      if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: 'project-1' };
      if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo'))
        return { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 };
      return { primitiveId: 'flag-new' };
    });
    const recreator = createSchematicSnapshotRecreator({
      callFirst,
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
      getEasyedaVersion: () => '4.1.105',
      allowExperimentalPowerNetFlagRecreation: () => true,
    });
    await recreator.create({
      ...snapshot('netflag', {
        identification: 'Ground',
        net: 'GND',
        nativeSymbol: nativeGround,
        x: 10,
        y: 20,
        rotation: 90,
        mirror: false,
      }),
      componentType: 'netflag',
      nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
    });
    expect(callFirst).toHaveBeenCalledWith(
      ['SCH_PrimitiveComponent.createNetFlag', 'sch_PrimitiveComponent.createNetFlag'],
      'Ground',
      'GND',
      10,
      20,
      90,
      false,
    );
  });

  it.each([
    {
      label: 'missing native scope',
      nativeContext: undefined,
      activeProject: 'project-1',
      activePage: 'page-1',
    },
    {
      label: 'wrong focused project',
      nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
      activeProject: 'other',
      activePage: 'page-1',
    },
    {
      label: 'wrong focused page',
      nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
      activeProject: 'project-1',
      activePage: 'other',
    },
    {
      label: 'wrong editor version',
      nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '3.2.209' },
      activeProject: 'project-1',
      activePage: 'page-1',
    },
  ])(
    'refuses net flag recreation for $label before native create',
    async ({ nativeContext, activeProject, activePage }) => {
      const callFirst = vi.fn(async (paths: string[]) => {
        if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: activeProject };
        if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo'))
          return { uuid: activePage, parentProjectUuid: activeProject, documentType: 1 };
        return { primitiveId: 'created' };
      });
      const recreator = createSchematicSnapshotRecreator({
        callFirst,
        createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
        requirePublicTextAlignMode: vi.fn((value) => value as 1),
        getEasyedaVersion: () => '4.1.105',
        allowExperimentalPowerNetFlagRecreation: () => true,
      });
      await expect(
        recreator.create({
          ...snapshot('netflag', {
            identification: 'Ground',
            net: 'GND',
            nativeSymbol: nativeGround,
            x: 10,
            y: 20,
            rotation: 0,
            mirror: false,
          }),
          componentType: 'netflag',
          nativeContext,
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
      expect(callFirst).not.toHaveBeenCalledWith(
        ['SCH_PrimitiveComponent.createNetFlag', 'sch_PrimitiveComponent.createNetFlag'],
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it.each([
    { kind: 'netflag', property: { net: 'GND', x: 1, y: 2, rotation: 0, mirror: false } },
    {
      kind: 'netflag',
      property: { identification: 'Ground', net: '', x: 1, y: 2, rotation: 0, mirror: false },
    },
    {
      kind: 'netflag',
      property: { identification: 'NotPower', net: 'GND', x: 1, y: 2, rotation: 0, mirror: false },
    },
    {
      kind: 'netflag',
      property: { identification: 'Ground', net: 'GND', x: 1, y: 2, rotation: 0 },
    },
    {
      kind: 'netport',
      property: { direction: 'SIDEWAYS', net: 'N1', x: 1, y: 2, rotation: 0, mirror: false },
    },
    {
      kind: 'component',
      property: { identification: 'Ground', net: 'GND', x: 1, y: 2, rotation: 0, mirror: false },
    },
  ] as const)(
    'rejects invalid or untyped $kind marker restoration before native mutation',
    async ({ kind, property }) => {
      const callFirst = vi.fn();
      const recreator = createSchematicSnapshotRecreator({
        callFirst,
        createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
        requirePublicTextAlignMode: vi.fn((value) => value as 1),
      });
      await expect(
        recreator.create({ ...snapshot(kind, property), componentType: kind }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
      expect(callFirst).not.toHaveBeenCalled();
    },
  );

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
