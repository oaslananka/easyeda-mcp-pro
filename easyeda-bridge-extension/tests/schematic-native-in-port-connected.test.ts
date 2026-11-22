import { describe, expect, it, vi } from 'vitest';
import { recreateVerifiedPrivateInPort } from '../src/schematic-native-in-port-recreation.js';
import type { SchematicPrimitiveSnapshot } from '../src/schematic-transaction-operations.js';

const connectedAttributesSha = '45fca1b2e12f2e095ad3855d25a3f8bbe1366a91f3b69a4fdeca9c2a642b0c9d';
const expectedWire = {
  primitiveId: 'wire-connected',
  net: 'QA_PORT_A',
  line: [750, 350, 650, 350],
};

const preDeletePort: SchematicPrimitiveSnapshot = {
  schemaVersion: 'schematic-primitive-snapshot/v1',
  primitiveId: 'port-original',
  primitiveKind: 'netport',
  componentType: 'netport',
  nativeContext: { editorVersion: '4.1.105', projectId: 'project-qa', documentId: 'page-qa' },
  property: {
    direction: 'IN',
    nativeSymbol: {
      name: 'Netport-IN',
      uuid: '21c0c70348655df0',
      libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
    },
    net: 'QA_PORT_A',
    x: 650,
    y: 350,
    rotation: 0,
    mirror: false,
  },
};

const connectedProfile = {
  projectId: 'project-qa',
  documentId: 'page-qa',
  originalPrimitiveId: 'port-original',
  net: 'QA_PORT_A',
  x: 650,
  y: 350,
  wireCount: 1,
  pagePinCount: 0,
  embeddedPinCount: 1,
  componentCount: 3,
  attributeCount: 49,
  attributeFingerprint: connectedAttributesSha,
  connectedWire: expectedWire,
};

function nativeWire(wire = expectedWire) {
  return {
    getState_PrimitiveId: () => wire.primitiveId,
    getState_Net: () => wire.net,
    getState_Line: () => wire.line,
  };
}

function setup(
  options: {
    profile?: typeof connectedProfile | null;
    wire?: ReturnType<typeof nativeWire> | null;
    wires?: number;
    remainingComponents?: number;
    remainingAttributes?: number;
    pagePins?: number;
    failRead?: boolean;
    changedProjectAfterRead?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const callFirst = vi.fn(async (paths: readonly string[]) => {
    const path = paths[0];
    calls.push(path);
    if (path === 'DMT_Project.getCurrentProjectInfo') {
      const changed =
        options.changedProjectAfterRead &&
        calls.filter((v) => v === 'DMT_Project.getCurrentProjectInfo').length > 1;
      return { uuid: changed ? 'other-project' : 'project-qa' };
    }
    if (path === 'DMT_SelectControl.getCurrentDocumentInfo') {
      return { uuid: 'page-qa', parentProjectUuid: 'project-qa', documentType: 1 };
    }
    if (path === 'SCH_PrimitiveWire.getAll') {
      if (options.failRead) throw new Error('native bridge unavailable');
      return Array.from({ length: options.wires ?? 1 }, () =>
        options.wire === null ? undefined : (options.wire ?? nativeWire()),
      );
    }
    if (path === 'SCH_PrimitiveComponent.get') {
      return options.oldPortStillPresent
        ? { getState_PrimitiveId: () => 'port-original' }
        : undefined;
    }
    if (path === 'SCH_PrimitiveComponent.getAll') {
      const known = [
        { getState_ComponentType: () => 'sheet' },
        { getState_ComponentType: () => 'netflag', getState_Net: () => options.groundNet ?? 'GND' },
      ];
      return Array.from({ length: options.remainingComponents ?? 2 }, (_, i) => known[i] ?? {});
    }
    if (path === 'SCH_PrimitiveAttribute.getAll') {
      return Array.from({ length: options.remainingAttributes ?? 40 }, () => ({}));
    }
    if (path === 'SCH_PrimitivePin.getAll') {
      return Array.from({ length: options.pagePins ?? 0 }, () => ({}));
    }
    if (path === 'SCH_PrimitiveComponent.createNetPort') {
      return { primitiveId: 'port-new' };
    }
    throw new Error('Unexpected native method ' + path);
  });
  const make = (snapshot: SchematicPrimitiveSnapshot = preDeletePort) =>
    recreateVerifiedPrivateInPort(
      {
        callFirst,
        createBridgeError: (code, message) => Object.assign(new Error(message), { code }),
        getEasyedaVersion: () => '4.1.105',
        allowExperimentalInPortRecreation: () => true,
        privateInPortProfile:
          options.profile === null ? undefined : (options.profile ?? connectedProfile),
      },
      snapshot,
    );
  return { make, callFirst };
}

describe('opt-in connected IN-port private reconstruction (real V4 QA geometry)', () => {
  const nativeCreate = [
    'SCH_PrimitiveComponent.createNetPort',
    'sch_PrimitiveComponent.createNetPort',
  ];

  it('accepts only a matching read-only native wire and exact after-delete inventory', async () => {
    const { callFirst, make } = setup();
    await expect(make()).resolves.toEqual({ primitiveId: 'port-new' });
    expect(callFirst).toHaveBeenCalledWith([
      'SCH_PrimitiveWire.getAll',
      'sch_PrimitiveWire.getAll',
    ]);
    expect(callFirst).toHaveBeenCalledWith([
      'SCH_PrimitiveComponent.getAll',
      'sch_PrimitiveComponent.getAll',
    ]);
    expect(callFirst).toHaveBeenCalledWith([
      'SCH_PrimitiveAttribute.getAll',
      'sch_PrimitiveAttribute.getAll',
    ]);
    expect(callFirst).toHaveBeenCalledWith(nativeCreate, 'IN', 'QA_PORT_A', 650, 350, 0, false);
  });

  it.each([
    ['no live native wire', { wires: 0 }],
    ['two native wires', { wires: 2 }],
    ['failed native inventory read', { failRead: true }],
    ['missing wire getter', { wire: null }],
    ['wrong number of remaining components', { remainingComponents: 3 }],
    ['wrong number of remaining attributes', { remainingAttributes: 39 }],
    ['unexpected page pin', { pagePins: 1 }],
    ['port was not actually deleted', { oldPortStillPresent: true }],
    ['other surviving Ground net changed', { groundNet: 'VCC' }],
    ['changed native project during final verification', { changedProjectAfterRead: true }],
  ] as const)('denies %s without creating a port', async (_, options) => {
    const { callFirst, make } = setup(options);
    await expect(make()).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    expect(callFirst).not.toHaveBeenCalledWith(
      nativeCreate,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ['wrong wire ID', { primitiveId: 'another-wire' }],
    ['changed net name', { net: 'VCC' }],
    ['changed wire endpoint', { line: [751, 350, 650, 350] }],
    ['lost port contact', { line: [750, 350, 700, 350] }],
  ] as const)('denies %s on the live native wire', async (_, alteration) => {
    const wrongWire = { ...expectedWire, ...alteration };
    const { callFirst, make } = setup({ wire: nativeWire(wrongWire) });
    await expect(make()).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    expect(callFirst).not.toHaveBeenCalledWith(
      nativeCreate,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ['unproven attribute digest', { attributeFingerprint: 'b'.repeat(64) }],
    ['an additional wire inventory', { wireCount: 2 }],
    ['mismatched wire net in witness', { connectedWire: { ...expectedWire, net: 'VCC' } }],
    [
      'missing exact pin coordinate',
      { connectedWire: { ...expectedWire, line: [750, 350, 710, 350] } },
    ],
  ] as const)('denies an untrusted %s profile', async (_, update) => {
    const { callFirst, make } = setup({ profile: { ...connectedProfile, ...update } });
    await expect(make()).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    expect(callFirst).not.toHaveBeenCalledWith(
      nativeCreate,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
