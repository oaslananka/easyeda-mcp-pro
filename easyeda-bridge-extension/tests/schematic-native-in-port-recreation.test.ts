import { describe, expect, it, vi } from 'vitest';
import { recreateVerifiedPrivateInPort } from '../src/schematic-native-in-port-recreation.js';
import type {
  SchematicPrimitiveSnapshot,
  SchematicPrimitiveSnapshotKind,
} from '../src/schematic-transaction-operations.js';

function snapshot(
  primitiveKind: SchematicPrimitiveSnapshotKind,
  property: Record<string, unknown>,
): SchematicPrimitiveSnapshot {
  return {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId: primitiveKind + '-old',
    primitiveKind,
    property,
  };
}

describe('private V4 IN net port reconstruction prototype', () => {
  const inSymbol = {
    libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
    uuid: '21c0c70348655df0',
    name: 'Netport-IN',
  };
  const profile = {
    projectId: 'project-1',
    documentId: 'page-1',
    originalPrimitiveId: 'port-old',
    net: 'QA_PORT_A',
    x: 650,
    y: 350,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    componentCount: 3,
    attributeCount: 47,
    attributeFingerprint: '3901dab9df8ea0694ee7c0b1dad50c139fc1169ccab04a8a09afc046c4adb2b3',
  };
  const nativePort = {
    ...snapshot('netport', {
      direction: 'IN',
      nativeSymbol: inSymbol,
      net: 'QA_PORT_A',
      x: 650,
      y: 350,
      rotation: 0,
      mirror: false,
    }),
    primitiveId: 'port-old',
    componentType: 'netport',
    nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
  } satisfies SchematicPrimitiveSnapshot;

  function subject(
    options: {
      optIn?: boolean;
      nativeVersion?: string;
      profile?: typeof profile | null;
      project?: string;
      page?: string;
      parentProject?: string;
    } = {},
  ) {
    const callFirst = vi.fn(async (paths: string[]) => {
      if (paths.includes('DMT_Project.getCurrentProjectInfo'))
        return { uuid: options.project ?? 'project-1' };
      if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo')) {
        return {
          uuid: options.page ?? 'page-1',
          parentProjectUuid: options.parentProject ?? options.project ?? 'project-1',
          documentType: 1,
        };
      }
      if (paths.includes('SCH_PrimitiveComponent.get')) return undefined;
      if (paths.includes('SCH_PrimitiveWire.getAll')) return [];
      if (paths.includes('SCH_PrimitiveComponent.getAll')) {
        return [
          { getState_ComponentType: () => 'sheet' },
          { getState_ComponentType: () => 'netflag', getState_Net: () => 'GND' },
        ];
      }
      if (paths.includes('SCH_PrimitiveAttribute.getAll'))
        return Array.from({ length: 38 }, () => ({}));
      if (paths.includes('SCH_PrimitivePin.getAll')) return [];
      return { primitiveId: 'new-port' };
    });
    const recreateDependencies = {
      callFirst,
      createBridgeError: vi.fn((code, message) => Object.assign(new Error(message), { code })),
      requirePublicTextAlignMode: vi.fn((value) => value as 1),
      getEasyedaVersion: () => options.nativeVersion ?? '4.1.105',
      allowExperimentalInPortRecreation: () => options.optIn ?? true,
      privateInPortProfile: options.profile === null ? undefined : (options.profile ?? profile),
    };
    const recreator = {
      create: (input: SchematicPrimitiveSnapshot) =>
        recreateVerifiedPrivateInPort(recreateDependencies, input),
    };
    return { callFirst, recreator };
  }

  it('recreates exact isolated IN with all six native arguments and validated project/page', async () => {
    const { recreator, callFirst } = subject();
    await recreator.create(nativePort);
    expect(callFirst).toHaveBeenCalledWith(
      ['SCH_PrimitiveComponent.createNetPort', 'sch_PrimitiveComponent.createNetPort'],
      'IN',
      'QA_PORT_A',
      650,
      350,
      0,
      false,
    );
  });

  it.each([
    ['missing trusted private profile', { profile: null }, nativePort],
    ['not explicitly opted in', { optIn: false }, nativePort],
    ['wrong editor runtime', { nativeVersion: '4.1.106' }, nativePort],
    ['wrong focused page', { page: 'other-page' }, nativePort],
    ['wrong focused project', { project: 'other-project' }, nativePort],
    ['wrong parent project', { parentProject: 'other-project' }, nativePort],
    [
      'mismatched fixture marker ID',
      { profile: { ...profile, originalPrimitiveId: 'other-port' } },
      nativePort,
    ],
    ['non-isolated wire', { profile: { ...profile, wireCount: 1 } }, nativePort],
    ['extra native page pin', { profile: { ...profile, pagePinCount: 1 } }, nativePort],
    [
      'different native attribute inventory',
      { profile: { ...profile, attributeCount: 46 } },
      nativePort,
    ],
    [
      'unknown attribute digest',
      { profile: { ...profile, attributeFingerprint: 'not-hash' } },
      nativePort,
    ],
    [
      'different valid-length digest',
      { profile: { ...profile, attributeFingerprint: 'b'.repeat(64) } },
      nativePort,
    ],
    [
      'different library UUID',
      {},
      {
        ...nativePort,
        property: { ...nativePort.property, nativeSymbol: { ...inSymbol, libraryUuid: 'wrong' } },
      },
    ],
    ['an OUT port', {}, { ...nativePort, property: { ...nativePort.property, direction: 'OUT' } }],
    ['renamed net', {}, { ...nativePort, property: { ...nativePort.property, net: 'VCC' } }],
    ['rotated port', {}, { ...nativePort, property: { ...nativePort.property, rotation: 90 } }],
    ['missing scope', {}, { ...nativePort, nativeContext: undefined }],
    ['ordinary production default', { optIn: false }, nativePort],
  ] as const)(
    'refuses native IN port create for %s without issuing the write',
    async (_, options, port) => {
      const { recreator, callFirst } = subject(options);
      await expect(recreator.create(port)).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
      expect(callFirst).not.toHaveBeenCalledWith(
        ['SCH_PrimitiveComponent.createNetPort', 'sch_PrimitiveComponent.createNetPort'],
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    },
  );
});
