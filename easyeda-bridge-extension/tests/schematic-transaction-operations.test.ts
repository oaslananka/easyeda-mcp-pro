import { describe, expect, it, vi } from 'vitest';
import { createSchematicTransactionOperations } from '../src/schematic-transaction-operations.js';
import { defaultGroundAttributeFields } from './fixtures/native-ground-default-attributes.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function readState(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const getter = record[`getState_${key}`];
  if (typeof getter === 'function') return getter.call(source);
  if (typeof record.getState === 'function') {
    const value = record.getState.call(source) as Record<string, unknown> | undefined;
    if (value && key in value) return value[key];
  }
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  return record[key] ?? record[lower];
}

function scalarId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const raw = record.primitiveId ?? record.uuid ?? readState(value, 'PrimitiveId');
  return typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean' ||
    typeof raw === 'bigint'
    ? String(raw)
    : '';
}

function createSubject(
  classes: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof createSchematicTransactionOperations>[0]> = {},
) {
  const textAlignCache = new Map<string, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9>();
  const callFirst = vi.fn();
  const logRecoverableError = vi.fn();
  const rawWire = classes.SCH_PrimitiveWire as
    { getAll?: () => Promise<unknown[]>; getAllPrimitiveId?: () => Promise<string[]> } | undefined;
  const fixtureClasses =
    rawWire?.getAll && !rawWire.getAllPrimitiveId
      ? {
          ...classes,
          SCH_PrimitiveWire: {
            ...rawWire,
            getAllPrimitiveId: async () => ((await rawWire.getAll?.()) ?? []).map(scalarId),
          },
        }
      : classes;
  const operations = createSchematicTransactionOperations({
    callFirst,
    readFirstPath: (paths) => paths.map((path) => fixtureClasses[path]).find(Boolean),
    readState,
    extractPrimitiveId: scalarId,
    readComponentType: (value) => String(readState(value, 'ComponentType') ?? '').toLowerCase(),
    readPinPoint: (value) => ({
      x: readState(value, 'X') as number | undefined,
      y: readState(value, 'Y') as number | undefined,
      rotation: readState(value, 'Rotation') as number | undefined,
    }),
    createBridgeError: bridgeError,
    logRecoverableError,
    asPublicTextAlignMode: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
        ? (value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9)
        : undefined,
    requirePublicTextAlignMode: (value, field = 'alignMode') => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9) {
        throw bridgeError(
          'INVALID_PARAMS',
          `${field} must be an integer from 1 through 9`,
          'Use the documented ESCH_PrimitiveTextAlignMode values: LEFT_TOP=1 through RIGHT_BOTTOM=9.',
        );
      }
      return value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    },
    getCachedTextAlignMode: (primitiveId) => textAlignCache.get(primitiveId),
    setCachedTextAlignMode: (primitiveId, alignMode) => textAlignCache.set(primitiveId, alignMode),
    deleteCachedTextAlignMode: (primitiveId) => textAlignCache.delete(primitiveId),
    ...overrides,
  });
  return { operations, callFirst, logRecoverableError, textAlignCache };
}

describe('untrusted native Ground reconstruction descriptor', () => {
  const scope = { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' };
  const property = {
    identification: 'Ground',
    net: 'GND',
    nativeSymbol: {
      name: 'Ground-GND',
      libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
      uuid: 'af20086a8911a85a',
    },
    x: 240,
    y: 250,
    rotation: 0,
    mirror: false,
  };
  const evidence = {
    kind: 'verified-disconnected-ground/v2',
    markerId: 'flag-1',
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: 38,
    attributeFingerprint: 'a'.repeat(64),
  };

  it.each([
    ['different native marker ID', { ...evidence, markerId: 'other' }],
    ['wire in connected graph', { ...evidence, wireCount: 1 }],
    ['invalid inventory size', { ...evidence, attributeCount: 300 }],
    ['unknown evidence capability', { ...evidence, writePermission: true }],
  ])('rejects %s before native snapshot recreation', async (_, nativeIsolation) => {
    const { operations, callFirst } = createSubject();
    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'flag-1',
        primitiveKind: 'netflag',
        componentType: 'netflag',
        property,
        nativeContext: scope,
        nativeIsolation,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('keeps production reconstruction disabled despite a complete caller-provided Ground witness', async () => {
    const { operations, callFirst } = createSubject({}, { getEasyedaVersion: () => '4.1.105' });
    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'flag-1',
        primitiveKind: 'netflag',
        componentType: 'netflag',
        property,
        nativeContext: scope,
        nativeIsolation: evidence,
        allowExperimentalPowerNetFlagRecreation: true,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('recreates a typed isolated Ground only in an explicitly opted-in unit fixture', async () => {
    let created = false;
    const ground = {
      getState_PrimitiveId: () => 'flag-new',
      getState_ComponentType: () => 'netflag',
      getState_Net: () => 'GND',
      getState_Name: () => 'GND',
      getState_Component: () => property.nativeSymbol,
      getState_X: () => 240,
      getState_Y: () => 250,
      getState_Rotation: () => 0,
      getState_Mirror: () => false,
    };
    const nativeClass = {
      getAll: vi.fn(async () => (created ? [ground] : [])),
      getAllPrimitiveId: vi.fn(async () => (created ? ['flag-new'] : [])),
      get: vi.fn(async (id: string) => (created && id === 'flag-new' ? ground : undefined)),
    };
    const { operations, callFirst } = createSubject(
      { SCH_PrimitiveComponent: nativeClass },
      {
        getEasyedaVersion: () => '4.1.105',
        allowExperimentalPowerNetFlagRecreation: () => true,
      },
    );
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: 'project-1' };
      if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo')) {
        return { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 };
      }
      if (paths.includes('SCH_PrimitiveComponent.createNetFlag')) {
        created = true;
        return { primitiveId: 'flag-new' };
      }
      throw new Error('Unexpected native method');
    });

    const restored = await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'flag-1',
      primitiveKind: 'netflag',
      componentType: 'netflag',
      property,
      nativeContext: scope,
      nativeIsolation: evidence,
    });

    expect(restored).toMatchObject({
      primitiveId: 'flag-new',
      snapshot: {
        primitiveId: 'flag-new',
        primitiveKind: 'netflag',
        componentType: 'netflag',
        property: { net: 'GND', identification: 'Ground' },
      },
    });
    expect(callFirst).toHaveBeenCalledWith(
      ['SCH_PrimitiveComponent.createNetFlag', 'sch_PrimitiveComponent.createNetFlag'],
      'Ground',
      'GND',
      240,
      250,
      0,
      false,
    );
    expect(nativeClass.get).toHaveBeenCalledWith('flag-new');
  });

  it('rejects unscoped isolation and isolation attached to a netport', async () => {
    const { operations, callFirst } = createSubject();
    const snapshot = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'flag-1',
      primitiveKind: 'netflag',
      componentType: 'netflag',
      property,
      nativeIsolation: evidence,
    };
    await expect(operations.recreatePrimitiveSnapshot(snapshot)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      operations.recreatePrimitiveSnapshot({
        ...snapshot,
        primitiveKind: 'netport',
        componentType: 'netport',
        nativeContext: scope,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(callFirst).not.toHaveBeenCalled();
  });
});

describe('schematic transaction operations', () => {
  it('captures a scalar-safe component snapshot', async () => {
    const component = {
      getState_PrimitiveId: () => 'cmp-1',
      getState_ComponentType: () => 'component',
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Designator: () => 'U1',
      getState_OtherProperty: () => ({ value: 'MCU' }),
    };
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(component) },
    });

    await expect(operations.getPrimitiveSnapshot('cmp-1')).resolves.toMatchObject({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'cmp-1',
      primitiveKind: 'component',
      property: { x: 10, y: 20, designator: 'U1', otherProperty: { value: 'MCU' } },
    });
  });

  it.each([
    { kind: 'netflag', identity: 'Identification', value: 'Ground' },
    { kind: 'netport', identity: 'Direction', value: 'IN' },
  ] as const)(
    'captures the native $kind creation identity for typed rollback preflight',
    async ({ kind, identity, value }) => {
      const component = {
        getState_PrimitiveId: () => 'marker-1',
        getState_ComponentType: () => kind,
        getState_X: () => 11,
        getState_Y: () => 22,
        getState_Rotation: () => 90,
        getState_Mirror: () => false,
        getState_Net: () => 'GND',
        ['getState_' + identity]: () => value,
      };
      const { operations } = createSubject({
        SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(component) },
      });
      await expect(operations.getPrimitiveSnapshot('marker-1')).resolves.toMatchObject({
        primitiveKind: kind,
        componentType: kind,
        property: {
          x: 11,
          y: 22,
          rotation: 90,
          mirror: false,
          net: 'GND',
          [identity.charAt(0).toLowerCase() + identity.slice(1)]: value,
        },
      });
    },
  );

  it.each([
    ['netflag', 'identification'],
    ['netport', 'direction'],
  ] as const)(
    'does not invent an undocumented native %s creation discriminator when the getter is absent',
    async (kind, missing) => {
      const { operations } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_PrimitiveId: () => 'marker-1',
            getState_ComponentType: () => kind,
            getState_X: () => 20,
            getState_Y: () => 30,
            getState_Rotation: () => 0,
            getState_Mirror: () => false,
            getState_Net: () => 'SIGNAL',
          }),
        },
      });
      const result = await operations.getPrimitiveSnapshot('marker-1');
      expect(result.primitiveKind).toBe(kind);
      expect(result.property).toMatchObject({ net: 'SIGNAL', x: 20, y: 30 });
      expect(result.property).not.toHaveProperty(missing);
    },
  );

  it('derives the Ground discriminator only from the exact native V4 Ground-GND symbol', async () => {
    const component = {
      getState_PrimitiveId: () => 'flag-1',
      getState_ComponentType: () => 'netflag',
      getState_Component: () => ({
        libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
        uuid: 'af20086a8911a85a',
        name: 'Ground-GND',
      }),
      getState_Name: () => 'GND',
      getState_Net: () => 'GND',
      getState_X: () => 240,
      getState_Y: () => 250,
      getState_Rotation: () => 0,
      getState_Mirror: () => false,
    };
    const { operations } = createSubject(
      { SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(component) } },
      { getEasyedaVersion: () => '4.1.105' },
    );
    await expect(operations.getPrimitiveSnapshot('flag-1', 'netflag')).resolves.toMatchObject({
      primitiveKind: 'netflag',
      componentType: 'netflag',
      property: {
        identification: 'Ground',
        net: 'GND',
        x: 240,
        y: 250,
        rotation: 0,
        mirror: false,
        nativeSymbol: {
          libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
          uuid: 'af20086a8911a85a',
          name: 'Ground-GND',
        },
      },
    });
  });

  it.each([
    {
      name: 'lookalike label',
      symbol: { name: 'Ground-GND', libraryUuid: 'other', uuid: 'af20086a8911a85a' },
    },
    {
      name: 'different symbol UUID',
      symbol: {
        name: 'Ground-GND',
        libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
        uuid: 'other',
      },
    },
    {
      name: 'different display name',
      symbol: {
        name: 'Other-GND',
        libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
        uuid: 'af20086a8911a85a',
      },
    },
    { name: 'incomplete symbol identity', symbol: { name: 'Ground-GND' } },
  ])('does not authorize unidentified native $name as a Ground flag', async ({ symbol }) => {
    const { operations } = createSubject(
      {
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => 'netflag',
            getState_Component: () => symbol,
            getState_Net: () => 'GND',
            getState_Name: () => 'GND',
          }),
        },
      },
      { getEasyedaVersion: () => '4.1.105' },
    );
    const read = await operations.getPrimitiveSnapshot('flag-1', 'netflag');
    expect(read.property).not.toHaveProperty('identification');
    expect(read.property).not.toHaveProperty('nativeSymbol');
  });

  describe('verified native V4 IN netport identity', () => {
    function portFixture(
      options: {
        symbol?: Record<string, unknown>;
        version?: string;
        directPinType?: string;
        pinId?: string;
        runtimeDirection?: string;
        net?: string;
        name?: string;
        rotation?: number;
        mirror?: boolean;
        focusSwitch?: boolean;
        staleComponent?: boolean;
        omitPinReader?: boolean;
      } = {},
    ) {
      const fields = (values: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => ['getState_' + key, () => value]),
        );
      const symbol = options.symbol ?? {
        libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
        uuid: '21c0c70348655df0',
        name: 'Netport-IN',
      };
      const pin = fields({
        PrimitiveId: 'port-1-e11',
        PinName: 'IN',
        PinNumber: '1',
        pinType: 'IN',
        X: 650,
        Y: 350,
        Rotation: 0,
        NoConnected: false,
      });
      const direct = {
        ...pin,
        ...fields({
          PrimitiveId: options.pinId ?? 'port-1-e11',
          pinType: options.directPinType ?? 'IN',
        }),
      };
      const port = {
        ...fields({
          PrimitiveId: 'port-1',
          ComponentType: 'netport',
          Component: symbol,
          Net: options.net ?? 'QA_PORT_A',
          Name: options.name ?? 'QA_PORT_A',
          X: 650,
          Y: 350,
          Rotation: options.rotation ?? 0,
          Mirror: options.mirror ?? false,
          Direction: options.runtimeDirection,
        }),
        getAllPins: vi.fn(async () => [pin]),
      };
      const get = vi.fn(async () => port);
      if (options.staleComponent) {
        get
          .mockImplementationOnce(async () => port)
          .mockImplementation(async () => ({
            ...port,
            ...fields({ PrimitiveId: 'wrong-id' }),
          }));
      }
      let focusedReads = 0;
      const pinGet = vi.fn(async () => direct);
      const subject = createSubject(
        {
          SCH_PrimitiveComponent: { get },
          ...(options.omitPinReader ? {} : { SCH_PrimitivePin: { get: pinGet } }),
        },
        {
          getEasyedaVersion: () => options.version ?? '4.1.105',
          callFirst: vi.fn(async (paths: string[]) => {
            if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: 'p1' };
            if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo')) {
              focusedReads += 1;
              return {
                uuid: options.focusSwitch && focusedReads > 1 ? 'page2' : 'page1',
                parentProjectUuid: 'p1',
                documentType: 1,
              };
            }
            return undefined;
          }) as any,
        },
      );
      return { ...subject, symbol, pinGet };
    }

    it('captures exact symbol and IN direction using independently read embedded native pins', async () => {
      const { operations, symbol, pinGet } = portFixture();
      const snapshot = await operations.getPrimitiveSnapshot('port-1', 'netport');
      expect(snapshot).toMatchObject({
        primitiveKind: 'netport',
        property: { direction: 'IN', nativeSymbol: symbol, net: 'QA_PORT_A' },
        nativeContext: { projectId: 'p1', documentId: 'page1', editorVersion: '4.1.105' },
      });
      expect(pinGet).toHaveBeenCalledWith('port-1-e11');
      // Direction provenance is not a rollback authorization or an isolation witness.
      expect(snapshot).not.toHaveProperty('nativeIsolation');
    });

    it.each([
      ['lookalike name', { symbol: { name: 'Netport-IN' } }],
      [
        'wrong library',
        { symbol: { name: 'Netport-IN', libraryUuid: 'other', uuid: '21c0c70348655df0' } },
      ],
      ['different editor', { version: '4.1.106' }],
      ['conflicting native direction', { runtimeDirection: 'OUT' }],
      ['wrong direct pin type', { directPinType: 'OUT' }],
      ['wrong direct pin identity', { pinId: 'other-e11' }],
      ['different name', { name: 'OTHER' }],
      ['wrong rotation', { rotation: 90 }],
      ['mirrored', { mirror: true }],
      ['page switched during read', { focusSwitch: true }],
      ['stale component ID', { staleComponent: true }],
      ['no independent pin reader', { omitPinReader: true }],
    ] as const)('does not grant verified IN identity for %s', async (_, options) => {
      const { operations } = portFixture(options);
      const snapshot = await operations.getPrimitiveSnapshot('port-1', 'netport');
      expect(snapshot.property).not.toHaveProperty('nativeSymbol');
      expect(snapshot).not.toHaveProperty('nativeIsolation');
      if (options !== undefined && !('runtimeDirection' in options)) {
        expect(snapshot.property).not.toHaveProperty('direction');
      }
    });

    it('never infers the native marker identity from an untyped read', async () => {
      const { operations, pinGet } = portFixture();
      const snapshot = await operations.getPrimitiveSnapshot('port-1');
      expect(snapshot.property).not.toHaveProperty('nativeSymbol');
      expect(snapshot.property).not.toHaveProperty('direction');
      expect(pinGet).not.toHaveBeenCalled();
    });
  });

  it('binds a marker snapshot only to a verified native schematic project and document', async () => {
    const { operations } = createSubject(
      {
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_PrimitiveId: () => 'flag-1',
            getState_ComponentType: () => 'netflag',
            getState_Identification: () => 'Power',
            getState_Net: () => 'VCC',
            getState_X: () => 40,
            getState_Y: () => 50,
            getState_Rotation: () => 0,
            getState_Mirror: () => false,
          }),
        },
      },
      {
        getEasyedaVersion: () => '4.1.105',
        callFirst: vi.fn(async (paths: string[]) => {
          if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: 'project-1' };
          if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo'))
            return { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 };
          return undefined;
        }) as any,
      },
    );
    await expect(operations.getPrimitiveSnapshot('flag-1', 'netflag')).resolves.toMatchObject({
      primitiveKind: 'netflag',
      property: { identification: 'Power', net: 'VCC' },
      nativeContext: {
        projectId: 'project-1',
        documentId: 'page-1',
        editorVersion: '4.1.105',
      },
    });
  });

  it('attaches read-only isolation evidence only after complete native inventories and stable focus', async () => {
    const attrDefaults = {
      PrimitiveType: 'Attribute',
      Key: 'Description',
      X: null,
      Y: 0,
      Rotation: null,
      Color: null,
      FontName: null,
      FontSize: null,
      Bold: null,
      Italic: null,
      UnderLine: null,
      AlignMode: null,
      FillColor: null,
      KeyVisible: null,
      ValueVisible: null,
    };
    const primitive = (fields: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries('ParentPrimitiveId' in fields ? { ...attrDefaults, ...fields } : fields).map(
          ([key, value]) => ['getState_' + key, () => value],
        ),
      );
    const sheet = primitive({ PrimitiveId: 'sheet-1', ComponentType: 'sheet' });
    const pin = primitive({
      PrimitiveId: 'flag-1-e15',
      PinName: 'Pin1',
      PinNumber: '1',
      pinType: 'IN',
      X: 240,
      Y: 250,
      Rotation: 90,
      NoConnected: false,
    });
    const flag = {
      ...primitive({
        PrimitiveId: 'flag-1',
        ComponentType: 'netflag',
        Name: 'GND',
        Net: 'GND',
        X: 240,
        Y: 250,
        Rotation: 0,
        Mirror: false,
        Component: {
          name: 'Ground-GND',
          libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
          uuid: 'af20086a8911a85a',
        },
      }),
      getAllPins: vi.fn(async () => [pin]),
    };
    const attribute = primitive({
      PrimitiveId: 'a-1',
      ParentPrimitiveId: 'sheet-1',
      Value: 'title',
    });
    const pinAttrs = defaultGroundAttributeFields('flag-1').map(primitive);
    const owner = (values: unknown[]) => ({
      getAll: vi.fn(async () => values),
      getAllPrimitiveId: vi.fn(async () => values.map((v) => readState(v, 'PrimitiveId'))),
      get: vi.fn(async (id: string) => values.find((v) => readState(v, 'PrimitiveId') === id)),
    });
    const { operations } = createSubject(
      {
        SCH_PrimitiveWire: owner([]),
        SCH_PrimitivePin: {
          ...owner([]),
          get: vi.fn(async (id: string) => (id === 'flag-1-e15' ? pin : undefined)),
        },
        SCH_PrimitiveComponent: owner([sheet, flag]),
        SCH_PrimitiveAttribute: owner([attribute, ...pinAttrs]),
      },
      {
        getEasyedaVersion: () => '4.1.105',
        callFirst: vi.fn(async (paths: string[]) =>
          paths.includes('DMT_Project.getCurrentProjectInfo')
            ? { uuid: 'project-1' }
            : { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 },
        ),
      },
    );
    const result = await operations.getPrimitiveSnapshot('flag-1', 'netflag');
    expect(result).toMatchObject({
      nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
      nativeIsolation: {
        kind: 'verified-disconnected-ground/v2',
        markerId: 'flag-1',
        componentCount: 2,
        pagePinCount: 0,
        embeddedPinCount: 1,
        wireCount: 0,
        attributeCount: 10,
      },
    });
    expect(result.primitiveKind).toBe('netflag');
  });

  it('does not turn a generic marker read into a rollback-authorized native snapshot', async () => {
    const callFirst = vi.fn(async (paths: string[]) => {
      if (paths.includes('DMT_Project.getCurrentProjectInfo')) return { uuid: 'project-a' };
      if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo')) {
        return { uuid: 'page-a', parentProjectUuid: 'project-a', documentType: 1 };
      }
      return undefined;
    });
    const { operations } = createSubject(
      {
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_PrimitiveId: () => 'flag-a',
            getState_ComponentType: () => 'netflag',
            getState_Identification: () => 'Ground',
            getState_Net: () => 'GND',
          }),
        },
      },
      { getEasyedaVersion: () => '4.1.105', callFirst },
    );
    const read = await operations.getPrimitiveSnapshot('flag-a');
    expect(read).toMatchObject({
      primitiveId: 'flag-a',
      primitiveKind: 'netflag',
      property: { identification: 'Ground', net: 'GND' },
    });
    expect(read).not.toHaveProperty('nativeContext');
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('does not bind a typed marker snapshot when the focused native page changes during the read', async () => {
    let projectCall = 0;
    let documentCall = 0;
    const callFirst = vi.fn(async (paths: string[]) => {
      if (paths.includes('DMT_Project.getCurrentProjectInfo')) {
        return { uuid: ++projectCall === 1 ? 'project-a' : 'project-b' };
      }
      if (paths.includes('DMT_SelectControl.getCurrentDocumentInfo')) {
        const page = ++documentCall === 1 ? 'a' : 'b';
        return {
          uuid: 'page-' + page,
          parentProjectUuid: 'project-' + page,
          documentType: 1,
        };
      }
      return undefined;
    });
    const { operations } = createSubject(
      {
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_PrimitiveId: () => 'flag-a',
            getState_ComponentType: () => 'netflag',
            getState_Identification: () => 'Ground',
            getState_Net: () => 'GND',
          }),
        },
      },
      { getEasyedaVersion: () => '4.1.105', callFirst },
    );
    const read = await operations.getPrimitiveSnapshot('flag-a', 'netflag');
    expect(read).toMatchObject({
      primitiveId: 'flag-a',
      primitiveKind: 'netflag',
      property: { identification: 'Ground', net: 'GND' },
    });
    expect(read).not.toHaveProperty('nativeContext');
    expect(projectCall).toBe(2);
    expect(documentCall).toBe(2);
  });

  it('rejects malformed restore input before mutation', async () => {
    const { operations, callFirst } = createSubject();

    await expect(
      operations.restorePrimitiveSnapshot({ schemaVersion: 'wrong' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'snapshot does not match schematic-primitive-snapshot/v1',
    });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('does not stringify object-valued primitive IDs', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([{ primitiveId: { unsafe: true } }]),
      },
    });

    await expect(operations.listPrimitiveIds('wire')).resolves.toEqual({
      primitiveKind: 'wire',
      primitiveIds: [],
    });
  });

  it.each(['netflag', 'netport', 'sheet'] as const)(
    'rejects standalone deletion of native %s in a mixed batch before touching any wire',
    async (kind) => {
      const componentDelete = vi.fn().mockResolvedValue(true);
      const wireDelete = vi.fn().mockResolvedValue(true);
      const { operations } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn(async (id: string) =>
            id === 'marker-1' ? { primitiveId: id, getState_ComponentType: () => kind } : undefined,
          ),
          delete: componentDelete,
        },
        SCH_PrimitiveWire: {
          get: vi.fn(async (id: string) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
          delete: wireDelete,
        },
      });

      await expect(operations.deletePrimitives(['wire-1', 'marker-1'])).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
      expect(wireDelete).not.toHaveBeenCalled();
      expect(componentDelete).not.toHaveBeenCalled();
    },
  );

  it('refuses a component whose native type is unavailable instead of guessing it is safe to delete', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ primitiveId: 'untyped-1' }),
        delete: componentDelete,
      },
    });
    await expect(operations.deletePrimitives(['untyped-1'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(componentDelete).not.toHaveBeenCalled();
  });

  it('refuses a stale native component lookup before deleting any primitive', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          primitiveId: 'different-native-id',
          getState_ComponentType: () => 'component',
        }),
        delete: componentDelete,
      },
    });
    await expect(operations.deletePrimitives(['requested-id'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(componentDelete).not.toHaveBeenCalled();
  });

  it('refuses component deletion when only a native ID inventory is readable', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        getAllPrimitiveId: vi.fn().mockResolvedValue(['marker-id-only']),
        delete: componentDelete,
      },
    });
    await expect(operations.deletePrimitives(['marker-id-only'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(componentDelete).not.toHaveBeenCalled();
  });

  it('rejects a component changed to a net flag after initial type preflight before deleting an earlier wire', async () => {
    let markerReads = 0;
    const wireDelete = vi.fn().mockResolvedValue(true);
    const componentDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id: string) => {
          if (id !== 'marker-1') return undefined;
          markerReads += 1;
          return {
            primitiveId: id,
            getState_ComponentType: () => (markerReads === 1 ? 'component' : 'netflag'),
          };
        }),
        delete: componentDelete,
      },
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
        delete: wireDelete,
      },
    });
    await expect(operations.deletePrimitives(['wire-1', 'marker-1'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(wireDelete).not.toHaveBeenCalled();
    expect(componentDelete).not.toHaveBeenCalled();
  });

  it('rejects an initially missing component if it appears as a net flag during batch resolution', async () => {
    let markerReads = 0;
    const wireDelete = vi.fn().mockResolvedValue(true);
    const componentDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id: string) => {
          if (id !== 'marker-1') return undefined;
          markerReads += 1;
          return markerReads === 1
            ? undefined
            : { primitiveId: id, getState_ComponentType: () => 'netflag' };
        }),
        delete: componentDelete,
      },
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
        delete: wireDelete,
      },
    });
    await expect(operations.deletePrimitives(['wire-1', 'marker-1'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(wireDelete).not.toHaveBeenCalled();
    expect(componentDelete).not.toHaveBeenCalled();
  });

  it('refuses a transactional wire whose native net changed after server snapshot verification', async () => {
    let nativeNet = 'N1';
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) =>
          id === 'wire-1'
            ? {
                primitiveId: 'wire-1',
                getState_Line: () => [0, 0, 10, 0],
                getState_Net: () => nativeNet,
              }
            : undefined,
        ),
        delete: nativeDelete,
      },
    });
    const expected = await operations.getPrimitiveSnapshot('wire-1');
    expect(expected.property.net).toBe('N1');
    nativeNet = 'N2';
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths[0] === 'DMT_Project.getCurrentProjectInfo') return { uuid: 'project-1' };
      if (paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo') {
        return { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 };
      }
      throw new Error('Unexpected native getter');
    });

    await expect(
      operations.deletePrimitives(['wire-1'], expected, {
        projectId: 'project-1',
        documentId: 'page-1',
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_DELETE_PRECONDITION_CHANGED' });
    expect(nativeDelete).not.toHaveBeenCalled();
  });

  it('refuses a scoped transactional delete when the native project/page differs at final pre-write boundary', async () => {
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) =>
          id === 'wire-1'
            ? {
                primitiveId: 'wire-1',
                getState_Line: () => [0, 0, 10, 0],
                getState_Net: () => 'N1',
              }
            : undefined,
        ),
        delete: nativeDelete,
      },
    });
    const expected = await operations.getPrimitiveSnapshot('wire-1');
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths[0] === 'DMT_Project.getCurrentProjectInfo') return { uuid: 'project-1' };
      if (paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo') {
        return { uuid: 'different-page', parentProjectUuid: 'project-1', documentType: 1 };
      }
      throw new Error('Unexpected native getter');
    });
    await expect(
      operations.deletePrimitives(['wire-1'], expected, {
        projectId: 'project-1',
        documentId: 'page-1',
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_DELETE_PRECONDITION_CHANGED' });
    expect(nativeDelete).not.toHaveBeenCalled();
  });

  it('deletes only when a transactional native witness and project/page match exactly', async () => {
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) =>
          id === 'wire-1'
            ? {
                primitiveId: 'wire-1',
                getState_Line: () => [0, 0, 10, 0],
                getState_Net: () => 'N1',
              }
            : undefined,
        ),
        delete: nativeDelete,
      },
    });
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths[0] === 'DMT_Project.getCurrentProjectInfo') return { uuid: 'project-1' };
      if (paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo') {
        return { uuid: 'page-1', parentProjectUuid: 'project-1', documentType: 1 };
      }
      throw new Error('Unexpected native getter');
    });
    const expected = await operations.getPrimitiveSnapshot('wire-1');
    // JSON transport can reorder keys without changing primitive semantics.
    const reordered = {
      property: { net: 'N1', line: [0, 0, 10, 0] },
      primitiveKind: expected.primitiveKind,
      primitiveId: expected.primitiveId,
      schemaVersion: expected.schemaVersion,
    };
    await expect(
      operations.deletePrimitives(['wire-1'], reordered, {
        projectId: 'project-1',
        documentId: 'page-1',
      }),
    ).resolves.toMatchObject({ deleted: ['wire-1'], notFound: [] });
    expect(nativeDelete).toHaveBeenCalledExactlyOnceWith(['wire-1']);
    expect(callFirst).toHaveBeenCalledWith(['DMT_SelectControl.getCurrentDocumentInfo']);
  });

  it('refuses a focused-page switch during the native snapshot read even with matching wire properties', async () => {
    let focusedPageReads = 0;
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) =>
          id === 'wire-1'
            ? {
                primitiveId: 'wire-1',
                getState_Line: () => [0, 0, 10, 0],
                getState_Net: () => 'N1',
              }
            : undefined,
        ),
        delete: nativeDelete,
      },
    });
    const expected = await operations.getPrimitiveSnapshot('wire-1');
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths[0] === 'DMT_Project.getCurrentProjectInfo') return { uuid: 'project-1' };
      if (paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo') {
        focusedPageReads += 1;
        return {
          uuid: focusedPageReads === 1 ? 'page-1' : 'page-2',
          parentProjectUuid: 'project-1',
          documentType: 1,
        };
      }
      throw new Error('Unexpected native getter');
    });
    await expect(
      operations.deletePrimitives(['wire-1'], expected, {
        projectId: 'project-1',
        documentId: 'page-1',
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_DELETE_PRECONDITION_CHANGED' });
    expect(focusedPageReads).toBeGreaterThanOrEqual(2);
    expect(nativeDelete).not.toHaveBeenCalled();
  });

  it('refuses caller-claimed netflag witnesses without enabling marker deletion', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id: string) =>
          id === 'flag-1'
            ? {
                primitiveId: 'flag-1',
                getState_ComponentType: () => 'netflag',
              }
            : undefined,
        ),
        delete: componentDelete,
      },
    });
    await expect(
      operations.deletePrimitives(
        ['flag-1'],
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'flag-1',
          primitiveKind: 'netflag',
          componentType: 'netflag',
          property: { net: 'GND', identification: 'Ground' },
        },
        { projectId: 'project-1', documentId: 'page-1' },
      ),
    ).rejects.toMatchObject({
      code: 'NATIVE_DELETE_PRECONDITION_CHANGED',
    });
    expect(componentDelete).not.toHaveBeenCalled();
  });

  it('does not delete even a matching wire with missing native page scope', async () => {
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) =>
          id === 'wire-1'
            ? {
                primitiveId: 'wire-1',
                getState_Line: () => [0, 0, 10, 0],
                getState_Net: () => 'N1',
              }
            : undefined,
        ),
        delete: nativeDelete,
      },
    });
    const expected = await operations.getPrimitiveSnapshot('wire-1');
    await expect(operations.deletePrimitives(['wire-1'], expected)).rejects.toMatchObject({
      code: 'NATIVE_DELETE_PRECONDITION_CHANGED',
    });
    expect(nativeDelete).not.toHaveBeenCalled();
  });

  it('does not turn a validated drawing witness into a multi-target delete', async () => {
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveWire: { delete: nativeDelete },
    });
    await expect(
      operations.deletePrimitives(
        ['wire-1', 'wire-2'],
        {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveKind: 'wire',
          primitiveId: 'wire-1',
          property: { net: 'N1', line: [0, 0, 10, 0] },
        },
        { projectId: 'project-1', documentId: 'page-1' },
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_DELETE_PRECONDITION_CHANGED' });
    expect(nativeDelete).not.toHaveBeenCalled();
  });

  it('rejects repeated standalone IDs without deleting a primitive twice', async () => {
    const wireDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn(async (id: string) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
        delete: wireDelete,
      },
    });
    await expect(operations.deletePrimitives(['wire-1', 'wire-1'])).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(wireDelete).not.toHaveBeenCalled();
  });

  it('routes deletion to the owning class and reports missing IDs', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const wireDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id) =>
          id === 'cmp-1'
            ? { primitiveId: id, getState_ComponentType: () => 'component' }
            : undefined,
        ),
        delete: componentDelete,
      },
      SCH_PrimitiveWire: {
        get: vi.fn(async (id) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
        delete: wireDelete,
      },
    });

    await expect(operations.deletePrimitives(['cmp-1', 'wire-1', 'missing'])).resolves.toEqual({
      success: false,
      deleted: ['cmp-1', 'wire-1'],
      notFound: ['missing'],
    });
    expect(componentDelete).toHaveBeenCalledWith(['cmp-1']);
    expect(wireDelete).toHaveBeenCalledWith(['wire-1']);
  });

  it('refuses beta schematic text deletion before any other mutation in a mixed batch', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const textDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id) => (id === 'cmp-1' ? { primitiveId: id } : undefined)),
        delete: componentDelete,
      },
      SCH_PrimitiveText: {
        get: vi.fn(async (id) => (id === 'text-1' ? { primitiveId: id } : undefined)),
        delete: textDelete,
      },
    });
    await expect(operations.deletePrimitives(['cmp-1', 'text-1'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(componentDelete).not.toHaveBeenCalled();
    expect(textDelete).not.toHaveBeenCalled();
  });

  it('permits one exact text ID on verified V4.1.105 with scalar native delete and fresh readback', async () => {
    const text = { getState_PrimitiveId: () => 'text-1' };
    let present = true;
    const nativeDelete = vi.fn(async (id: string) => {
      if (id !== 'text-1') return false;
      present = false;
      return true;
    });
    const { operations, textAlignCache } = createSubject(
      {
        SCH_PrimitiveText: {
          get: vi.fn(async (id: string) => (id === 'text-1' && present ? text : undefined)),
          getAll: vi.fn(async () => (present ? [text] : [])),
          delete: nativeDelete,
        },
      },
      { getEasyedaVersion: () => '4.1.105' },
    );
    textAlignCache.set('text-1', 7);

    await expect(operations.deletePrimitives(['text-1'])).resolves.toEqual({
      success: true,
      deleted: ['text-1'],
      notFound: [],
    });
    expect(nativeDelete).toHaveBeenCalledExactlyOnceWith('text-1');
    expect(textAlignCache.has('text-1')).toBe(false);
  });

  it.each(['3.2.209', '4.1.104', '4.1.106', '', undefined])(
    'refuses beta deletion on any unaccepted native runtime %s before a write',
    async (version) => {
      const nativeDelete = vi.fn().mockResolvedValue(true);
      const { operations } = createSubject(
        {
          SCH_PrimitiveText: {
            get: vi.fn().mockResolvedValue({ primitiveId: 'text-1' }),
            getAll: vi.fn().mockResolvedValue([{ primitiveId: 'text-1' }]),
            delete: nativeDelete,
          },
        },
        { getEasyedaVersion: () => version },
      );
      await expect(operations.deletePrimitives(['text-1'])).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
      expect(nativeDelete).not.toHaveBeenCalled();
    },
  );

  it('refuses mixed V4 text/component batch before the component is touched', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const textDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject(
      {
        SCH_PrimitiveComponent: {
          get: vi.fn(async (id: string) => (id === 'cmp-1' ? { primitiveId: id } : undefined)),
          delete: componentDelete,
        },
        SCH_PrimitiveText: {
          get: vi.fn(async (id: string) => (id === 'text-1' ? { primitiveId: id } : undefined)),
          getAll: vi.fn().mockResolvedValue([{ primitiveId: 'text-1' }]),
          delete: textDelete,
        },
      },
      { getEasyedaVersion: () => '4.1.105' },
    );
    await expect(operations.deletePrimitives(['cmp-1', 'text-1'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
    expect(componentDelete).not.toHaveBeenCalled();
    expect(textDelete).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'native deletion false', acknowledged: false, remaining: [] },
    {
      label: 'text remains in fresh native inventory',
      acknowledged: true,
      remaining: [{ primitiveId: 'text-1' }],
    },
    { label: 'native inventory unavailable', acknowledged: true, remaining: null },
  ])('fails closed if V4 beta $label', async ({ acknowledged, remaining }) => {
    const nativeDelete = vi.fn().mockResolvedValue(acknowledged);
    const { operations } = createSubject(
      {
        SCH_PrimitiveText: {
          get: vi.fn().mockResolvedValue({ primitiveId: 'text-1' }),
          getAll: vi.fn().mockResolvedValue(remaining),
          delete: nativeDelete,
        },
      },
      { getEasyedaVersion: () => '4.1.105' },
    );
    await expect(operations.deletePrimitives(['text-1'])).rejects.toMatchObject({
      code: 'NATIVE_DELETE_UNVERIFIED',
    });
    expect(nativeDelete).toHaveBeenCalledExactlyOnceWith('text-1');
  });

  it('refuses V4 beta deletion when a fresh native text inventory cannot be read', async () => {
    const nativeDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject(
      {
        SCH_PrimitiveText: {
          get: vi.fn().mockResolvedValue({ primitiveId: 'text-1' }),
          delete: nativeDelete,
        },
      },
      { getEasyedaVersion: () => '4.1.105' },
    );
    await expect(operations.deletePrimitives(['text-1'])).rejects.toMatchObject({
      code: 'NATIVE_DELETE_UNVERIFIED',
    });
    expect(nativeDelete).not.toHaveBeenCalled();
  });

  it('rejects component recreation without a complete creation descriptor', async () => {
    const { operations } = createSubject();

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'cmp-1',
        primitiveKind: 'component',
        property: {},
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
  });
  it.each([
    ['netflag', { x: 12 }],
    ['netflag', { y: 21 }],
    ['netflag', { rotation: 90 }],
    ['netflag', { mirror: true }],
    ['netport', { x: 12 }],
    ['netport', { y: 21 }],
    ['netport', { rotation: 90 }],
    ['netport', { mirror: true }],
  ] as const)(
    'rejects #945 %s connection-marker topology mutation %j before any setter or done',
    async (kind, property) => {
      const setX = vi.fn(),
        setY = vi.fn(),
        setRotation = vi.fn(),
        setMirror = vi.fn();
      const setNet = vi.fn(),
        done = vi.fn().mockResolvedValue(undefined);
      const modify = vi.fn();
      const { operations } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => kind,
            getState_X: () => 10,
            getState_Y: () => 20,
            getState_Rotation: () => 0,
            getState_Mirror: () => false,
            setState_X: setX,
            setState_Y: setY,
            setState_Rotation: setRotation,
            setState_Mirror: setMirror,
            setState_Net: setNet,
            done,
          }),
          modify,
        },
      });
      await expect(operations.modifyPrimitive('marker-1', property)).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      for (const setter of [setX, setY, setRotation, setMirror, setNet, done, modify])
        expect(setter).not.toHaveBeenCalled();
    },
  );

  it('keeps intentional net-name updates allowed on an unmoved net flag', async () => {
    const setNet = vi.fn();
    const done = vi.fn().mockResolvedValue(undefined);
    const current = {
      getState_ComponentType: () => 'netflag',
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Rotation: () => 0,
      getState_Mirror: () => false,
      setState_Net: setNet,
      done,
    };
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(current), modify: vi.fn() },
    });

    await expect(operations.modifyPrimitive('flag-1', { net: 'GND' })).resolves.toEqual({
      primitiveId: 'flag-1',
      componentType: 'netflag',
      applied: { net: 'GND' },
    });
    expect(setNet).toHaveBeenCalledWith('GND');
    expect(done).toHaveBeenCalledOnce();
  });

  it('allows same-valued net-port positioning without changing electrical placement', async () => {
    const setX = vi.fn(),
      setY = vi.fn(),
      setRotation = vi.fn(),
      setMirror = vi.fn();
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'netport',
          getState_X: () => 10,
          getState_Y: () => 20,
          getState_Rotation: () => 0,
          getState_Mirror: () => false,
          setState_X: setX,
          setState_Y: setY,
          setState_Rotation: setRotation,
          setState_Mirror: setMirror,
        }),
        modify: vi.fn(),
      },
    });
    await expect(
      operations.modifyPrimitive('port-1', { x: 10, y: 20, rotation: 0, mirror: false }),
    ).resolves.toMatchObject({
      primitiveId: 'port-1',
      componentType: 'netport',
    });
    for (const setter of [setX, setY, setRotation, setMirror]) {
      expect(setter).not.toHaveBeenCalled();
    }
  });

  it('rejects missing native net-marker coordinates before a setter even when requested', async () => {
    const setter = vi.fn();
    const done = vi.fn();
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'netflag',
          setState_X: setter,
          done,
        }),
        modify: vi.fn(),
      },
    });
    await expect(operations.modifyPrimitive('flag-1', { x: 10 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(setter).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('continues to a class alias when an earlier snapshot getter throws', async () => {
    const failure = new Error('primary getter failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveCircle: { get: vi.fn().mockRejectedValue(failure) },
      sch_PrimitiveCircle: {
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 1,
          getState_CenterY: () => 2,
          getState_Radius: () => 3,
        }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('circle-1', 'circle')).resolves.toMatchObject({
      primitiveKind: 'circle',
      property: { centerX: 1, centerY: 2, radius: 3 },
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveCircle.get(circle-1) failed while creating snapshot',
      failure,
    );
  });

  it('captures polygon and net-flag/net-port snapshots by expected kind', async () => {
    const componentGet = vi.fn(async (id: string) => ({
      primitiveId: id,
      getState_ComponentType: () => (id === 'flag-1' ? 'netflag' : 'netport'),
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Net: () => 'VCC',
    }));
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: componentGet },
      SCH_PrimitivePolygon: {
        get: vi.fn().mockResolvedValue({
          getState_Line: () => [0, 0, 5, 0, 5, 5],
          getState_Color: () => '#111111',
        }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('flag-1', 'netflag')).resolves.toMatchObject({
      primitiveKind: 'netflag',
      property: { x: 10, y: 20, net: 'VCC' },
    });
    await expect(operations.getPrimitiveSnapshot('port-1', 'netport')).resolves.toMatchObject({
      primitiveKind: 'netport',
    });
    await expect(operations.getPrimitiveSnapshot('poly-1', 'polygon')).resolves.toMatchObject({
      primitiveKind: 'polygon',
      property: { line: [0, 0, 5, 0, 5, 5], color: '#111111' },
    });
  });

  it('rejects missing IDs and distinguishes expected-kind misses', async () => {
    const { operations } = createSubject();

    await expect(operations.getPrimitiveSnapshot('')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'primitiveId is required',
    });
    await expect(operations.getPrimitiveSnapshot('missing', 'rectangle')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
      message: 'Primitive missing was not found as expected kind rectangle',
    });
    await expect(operations.getPrimitiveSnapshot('missing')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
      message: 'Primitive missing was not found in a transaction-safe schematic class',
    });
  });

  it('rejects a component snapshot when its runtime kind differs from the expected kind', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_ComponentType: () => 'netflag' }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('flag-1', 'component')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
    });
  });

  it('uses persistent text inventory to validate a lossy public wrapper', async () => {
    const persistent = {
      primitiveId: 'text-1',
      x: 5,
      y: 6,
      content: 'persistent',
      color: '#222222',
    };
    const publicText = {
      getState_AlignMode: () => 4,
      getState_Content: () => undefined,
    };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([persistent]),
        get: vi.fn().mockResolvedValue(publicText),
      },
    });

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).resolves.toMatchObject({
      primitiveKind: 'text',
      property: { x: 5, y: 6, content: 'persistent', color: '#222222', alignMode: 4 },
    });
  });

  it('rejects text rollback when an addressable text has no public alignment', async () => {
    const sameId = { primitiveId: 'text-1', content: 'hello' };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([sameId]),
        get: vi.fn().mockResolvedValue(sameId),
      },
    });

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
      message: 'Text text-1 did not expose a public alignMode',
    });
  });

  it('contains text read failures and ignores unrelated wrappers', async () => {
    const getError = new Error('get failed');
    const getAllError = new Error('getAll failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockRejectedValue(getAllError),
        get: vi.fn().mockRejectedValue(getError),
      },
      sch_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue({ not: 'an array' }),
        get: vi.fn().mockResolvedValue({ primitiveId: 'other-id', getState_AlignMode: () => 3 }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveText.getAll() failed while reading text fallback state',
      getAllError,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveText.get(text-1) failed while reading text',
      getError,
    );
  });

  it('rejects non-object snapshots and unsupported primitive kinds', async () => {
    const { operations } = createSubject();

    await expect(operations.restorePrimitiveSnapshot(null)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'snapshot must be an object',
    });
    await expect(operations.listPrimitiveIds('triangle')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Unsupported schematic primitive kind: triangle',
    });
  });

  it('returns an empty inventory when the requested primitive class is unavailable', async () => {
    const { operations } = createSubject();
    await expect(operations.listPrimitiveIds('circle')).resolves.toEqual({
      primitiveKind: 'circle',
      primitiveIds: [],
    });
  });

  it('falls back to getAllPrimitiveId after getAll fails and de-duplicates IDs', async () => {
    const listError = new Error('inventory failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveRectangle: {
        getAll: vi.fn().mockRejectedValue(listError),
        getAllPrimitiveId: vi.fn().mockResolvedValue(['b', '', 'a', 'b', 3]),
      },
    });

    await expect(operations.listPrimitiveIds('rectangle')).resolves.toEqual({
      primitiveKind: 'rectangle',
      primitiveIds: ['a', 'b'],
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'failed to list rectangle primitives',
      listError,
    );
  });

  it('contains getAllPrimitiveId failures and returns an empty inventory', async () => {
    const idError = new Error('id inventory failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveCircle: { getAllPrimitiveId: vi.fn().mockRejectedValue(idError) },
    });

    await expect(operations.listPrimitiveIds('circle')).resolves.toEqual({
      primitiveKind: 'circle',
      primitiveIds: [],
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'failed to list circle primitive IDs',
      idError,
    );
  });

  it('filters component, net-flag, and net-port inventories by runtime type', async () => {
    const values = [
      { primitiveId: 'component-1', getState_ComponentType: () => 'component' },
      { primitiveId: 'sheet-1', getState_ComponentType: () => 'sheet' },
      { primitiveId: 'flag-1', getState_ComponentType: () => 'netflag' },
      { primitiveId: 'port-1', getState_ComponentType: () => 'netport' },
    ];
    const getAll = vi.fn().mockResolvedValue(values);
    const { operations } = createSubject({ SCH_PrimitiveComponent: { getAll } });

    await expect(operations.listPrimitiveIds('component')).resolves.toMatchObject({
      primitiveIds: ['component-1'],
    });
    await expect(operations.listPrimitiveIds('netflag')).resolves.toMatchObject({
      primitiveIds: ['flag-1'],
    });
    await expect(operations.listPrimitiveIds('netport')).resolves.toMatchObject({
      primitiveIds: ['port-1'],
    });
    expect(getAll).toHaveBeenCalledWith(undefined, true);
  });

  it('classifies component ID fallback by exact native kind rather than treating every ID as the requested marker kind', async () => {
    const kinds: Record<string, string> = {
      'sheet-1': 'sheet',
      'cmp-1': 'component',
      'flag-1': 'netflag',
      'port-1': 'netport',
    };
    const get = vi.fn(async (id: string) =>
      kinds[id]
        ? { getState_PrimitiveId: () => id, getState_ComponentType: () => kinds[id] }
        : undefined,
    );
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        getAll: vi.fn().mockResolvedValue([]),
        getAllPrimitiveId: vi.fn().mockResolvedValue(Object.keys(kinds)),
        get,
      },
    });
    for (const [requested, expected] of [
      ['component', ['cmp-1']],
      ['netflag', ['flag-1']],
      ['netport', ['port-1']],
    ] as const) {
      await expect(operations.listPrimitiveIds(requested)).resolves.toEqual({
        primitiveKind: requested,
        primitiveIds: expected,
      });
    }
    expect(get).toHaveBeenCalledWith('sheet-1');
    expect(get).toHaveBeenCalledWith('flag-1');
    expect(get).toHaveBeenCalledWith('port-1');
  });

  it('fails closed when a component fallback lacks typed native get(id)', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        getAll: vi.fn().mockResolvedValue([]),
        getAllPrimitiveId: vi.fn().mockResolvedValue(['flag-1']),
      },
    });
    await expect(operations.listPrimitiveIds('netport')).rejects.toMatchObject({
      code: 'NATIVE_INVENTORY_UNVERIFIED',
    });
  });

  it.each([
    ['stale exact ID', undefined],
    [
      'wrong exact ID',
      { getState_PrimitiveId: () => 'other', getState_ComponentType: () => 'netflag' },
    ],
    ['missing native kind', { getState_PrimitiveId: () => 'flag-1' }],
  ])('rejects ambiguous typed fallback: %s', async (_, item) => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        getAll: vi.fn().mockResolvedValue([]),
        getAllPrimitiveId: vi.fn().mockResolvedValue(['flag-1']),
        get: vi.fn().mockResolvedValue(item),
      },
    });
    await expect(operations.listPrimitiveIds('netflag')).rejects.toMatchObject({
      code: 'NATIVE_INVENTORY_UNVERIFIED',
    });
  });

  it.each([
    ['null native inventory', null],
    ['non-array native inventory', { id: 'flag-1' }],
    ['mixed scalar primitive IDs', ['flag-1', 42]],
    ['duplicate primitive IDs', ['flag-1', 'flag-1']],
  ])('refuses unverified component fallback: %s', async (_, ids) => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        getAll: vi.fn().mockResolvedValue([]),
        getAllPrimitiveId: vi.fn().mockResolvedValue(ids),
        get: vi.fn(async () => ({
          getState_PrimitiveId: () => 'flag-1',
          getState_ComponentType: () => 'netflag',
        })),
      },
    });
    await expect(operations.listPrimitiveIds('netflag')).rejects.toMatchObject({
      code: 'NATIVE_INVENTORY_UNVERIFIED',
    });
  });

  it('accepts scalar PrimitiveId fallback values but rejects objects', async () => {
    const values = [
      { PrimitiveId: 'string-id' },
      { PrimitiveId: 42 },
      { PrimitiveId: 9n },
      { PrimitiveId: { unsafe: true } },
    ];
    const { operations } = createSubject(
      { SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue(values) } },
      { extractPrimitiveId: () => '' },
    );

    await expect(operations.listPrimitiveIds('wire')).resolves.toEqual({
      primitiveKind: 'wire',
      primitiveIds: ['42', '9', 'string-id'],
    });
  });

  it('handles non-array deletion input without touching native classes', async () => {
    const { operations } = createSubject();
    await expect(operations.deletePrimitives('wire-1')).resolves.toEqual({
      success: true,
      deleted: [],
      notFound: [],
    });
  });

  it('uses getAllPrimitiveId ownership fallback for deletion', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveRectangle: {
        getAllPrimitiveId: vi.fn().mockResolvedValue(['rect-1']),
        delete: remove,
      },
    });

    await expect(operations.deletePrimitives(['', 'rect-1', 7])).resolves.toEqual({
      success: true,
      deleted: ['rect-1'],
      notFound: [],
    });
    expect(remove).toHaveBeenCalledWith(['rect-1']);
  });

  describe('native component lookup errors for other primitive classes', () => {
    const component = { primitiveId: 'component-1' };
    function setup(ids: unknown, rows: unknown, version = '4.1.105', missingRows = false) {
      let present = true;
      const text = { primitiveId: 'text-1' };
      const textDelete = vi.fn(async () => {
        present = false;
        return true;
      });
      const componentDelete = vi.fn();
      const { operations } = createSubject(
        {
          SCH_PrimitiveComponent: {
            get: vi.fn().mockRejectedValue(new Error('Native component lookup failed')),
            getAllPrimitiveId: vi.fn().mockResolvedValue(ids),
            ...(missingRows ? {} : { getAll: vi.fn().mockResolvedValue(rows) }),
            delete: componentDelete,
          },
          SCH_PrimitiveText: {
            get: vi.fn(async (id) => (id === 'text-1' && present ? text : undefined)),
            getAll: vi.fn(async () => (present ? [text] : [])),
            delete: textDelete,
          },
        },
        { getEasyedaVersion: () => version },
      );
      return { operations, textDelete, componentDelete };
    }

    it('permits exact V4 text deletion only after both component inventories prove absence', async () => {
      const { operations, textDelete, componentDelete } = setup(['component-1'], [component]);
      await expect(operations.deletePrimitives(['text-1'])).resolves.toEqual({
        success: true,
        deleted: ['text-1'],
        notFound: [],
      });
      expect(textDelete).toHaveBeenCalledExactlyOnceWith('text-1');
      expect(componentDelete).not.toHaveBeenCalled();
    });

    it('does not extend the fallback to an unverified runtime', async () => {
      const { operations, textDelete, componentDelete } = setup(
        ['component-1'],
        [component],
        '3.2.209',
      );
      await expect(operations.deletePrimitives(['text-1'])).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
      expect(textDelete).not.toHaveBeenCalled();
      expect(componentDelete).not.toHaveBeenCalled();
    });

    it('refuses when the native object inventory getter is absent', async () => {
      const { operations, textDelete, componentDelete } = setup(
        ['component-1'],
        [component],
        '4.1.105',
        true,
      );
      await expect(operations.deletePrimitives(['text-1'])).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
      expect(textDelete).not.toHaveBeenCalled();
      expect(componentDelete).not.toHaveBeenCalled();
    });

    it.each([
      ['target in both inventories', ['text-1'], [{ primitiveId: 'text-1' }]],
      ['disagreement', ['component-1'], [{ primitiveId: 'different' }]],
      ['unequal lengths', ['component-1'], []],
      ['duplicate ids', ['component-1', 'component-1'], [component, component]],
      ['malformed IDs', ['component-1', 42], [component]],
      ['missing row identity', ['component-1'], [{}]],
      ['unavailable inventory', null, [component]],
      ['unavailable rows', ['component-1'], null],
    ])('refuses ambiguous component ownership: %s', async (_name, ids, rows) => {
      const { operations, textDelete, componentDelete } = setup(ids, rows);
      await expect(operations.deletePrimitives(['text-1'])).rejects.toMatchObject({
        code: 'UNSUPPORTED_RUNTIME',
      });
      expect(textDelete).not.toHaveBeenCalled();
      expect(componentDelete).not.toHaveBeenCalled();
    });
  });

  it('refuses a deletion when native component ownership is unreadable', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockRejectedValue(new Error('get failed')),
        delete: vi.fn(),
      },
      SCH_PrimitiveWire: {
        getAllPrimitiveId: vi.fn().mockRejectedValue(new Error('ids failed')),
        delete: vi.fn(),
      },
      SCH_PrimitiveText: { delete: vi.fn() },
    });

    await expect(operations.deletePrimitives(['missing'])).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
  });
  it('recreates text, rectangle, circle, and polygon snapshots with exact explicit arguments', async () => {
    const text = {
      primitiveId: 'text-new',
      getState_AlignMode: () => 7,
      getState_X: () => 1,
      getState_Y: () => -2,
      getState_Content: () => 'note',
    };
    const classes = {
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(text),
      },
      SCH_PrimitiveRectangle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_TopLeftX: () => 3,
          getState_TopLeftY: () => -4,
          getState_Width: () => 5,
          getState_Height: () => 6,
        }),
      },
      SCH_PrimitiveCircle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 7,
          getState_CenterY: () => 8,
          getState_Radius: () => 9,
        }),
      },
      SCH_PrimitivePolygon: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ getState_Line: () => [0, 0, 1, 1] }),
      },
    };
    const { operations, callFirst } = createSubject(classes);
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths[0].includes('Text')) return { primitiveId: 'text-new' };
      if (paths[0].includes('Rectangle')) return { primitiveId: 'rect-new' };
      if (paths[0].includes('Circle')) return { primitiveId: 'circle-new' };
      return { primitiveId: 'poly-new' };
    });

    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'text-old',
      primitiveKind: 'text',
      property: {
        x: 1,
        y: 2,
        content: 'note',
        rotation: 90,
        color: '#123456',
        fontName: 'Inter',
        fontSize: 12,
        bold: true,
        italic: true,
        underline: true,
        alignMode: 7,
      },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'rect-old',
      primitiveKind: 'rectangle',
      property: {
        x: 3,
        y: 4,
        width: 5,
        height: 6,
        cornerRadius: 1,
        rotation: 45,
        color: '#111111',
        fillColor: '#222222',
        lineWidth: 2,
        lineType: 3,
        fillStyle: 'solid',
      },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'circle-old',
      primitiveKind: 'circle',
      property: {
        centerX: 7,
        centerY: 8,
        radius: 9,
        color: '#333333',
        fillColor: '#444444',
        lineWidth: 2,
        lineType: 4,
        fillStyle: 'solid',
      },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'poly-old',
      primitiveKind: 'polygon',
      property: {
        line: [0, 0, 1, 1],
        color: '#555555',
        fillColor: '#666666',
        lineWidth: 3,
        lineType: 5,
      },
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['SCH_PrimitiveText.create', 'sch_PrimitiveText.create'],
      1,
      -2,
      'note',
      90,
      '#123456',
      'Inter',
      12,
      true,
      true,
      true,
      7,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['SCH_PrimitiveRectangle.create', 'sch_PrimitiveRectangle.create'],
      3,
      -4,
      5,
      6,
      1,
      45,
      '#111111',
      '#222222',
      2,
      3,
      'solid',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      3,
      ['SCH_PrimitiveCircle.create', 'sch_PrimitiveCircle.create'],
      7,
      8,
      9,
      '#333333',
      '#444444',
      2,
      4,
      'solid',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      4,
      ['SCH_PrimitivePolygon.create', 'sch_PrimitivePolygon.create'],
      [0, 0, 1, 1],
      '#555555',
      '#666666',
      3,
      5,
    );
  });

  it('uses recreation defaults for rectangle, circle, and polygon optional fields', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveRectangle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_TopLeftX: () => 1,
          getState_TopLeftY: () => -2,
          getState_Width: () => 3,
          getState_Height: () => 4,
        }),
      },
      SCH_PrimitiveCircle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 1,
          getState_CenterY: () => 2,
          getState_Radius: () => 3,
        }),
      },
      SCH_PrimitivePolygon: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ getState_Line: () => [0, 0, 1, 1] }),
      },
    });
    callFirst
      .mockResolvedValueOnce({ primitiveId: 'rect-new' })
      .mockResolvedValueOnce({ primitiveId: 'circle-new' })
      .mockResolvedValueOnce({ primitiveId: 'poly-new' });

    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'rect-old',
      primitiveKind: 'rectangle',
      property: { x: 1, y: 2, width: 3, height: 4 },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'circle-old',
      primitiveKind: 'circle',
      property: { centerX: 1, centerY: 2, radius: 3 },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'poly-old',
      primitiveKind: 'polygon',
      property: { line: [0, 0, 1, 1] },
    });

    expect(callFirst.mock.calls[0].slice(5)).toEqual([0, 0, '#000000', 'none', 1, 0, 'none']);
    expect(callFirst.mock.calls[1].slice(4)).toEqual(['#000000', 'none', 1, 0, 'none']);
    expect(callFirst.mock.calls[2].slice(1)).toEqual([[0, 0, 1, 1], '#000000', 'none', 1, 0]);
  });

  it('rejects non-finite required recreation coordinates', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveCircle: { getAll: vi.fn().mockResolvedValue([]) },
    });

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'circle-old',
        primitiveKind: 'circle',
        property: { centerX: Number.NaN, centerY: 2, radius: 3 },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Snapshot property centerX must be a finite number',
    });
  });

  it.each(['netflag', 'netport'] as const)(
    'rejects %s recreation because no complete creation descriptor exists',
    async (primitiveKind) => {
      const { operations } = createSubject({
        SCH_PrimitiveComponent: { getAll: vi.fn().mockResolvedValue([]) },
      });
      await expect(
        operations.recreatePrimitiveSnapshot({
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'old',
          primitiveKind,
          property: {},
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    },
  );

  it('recovers a recreated ID from an exact one-item inventory diff', async () => {
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([{ primitiveId: 'before' }])
      .mockResolvedValueOnce([{ primitiveId: 'before' }, { primitiveId: 'after' }]);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveWire: {
        getAll,
        get: vi.fn().mockResolvedValue({
          primitiveId: 'after',
          getState_Line: () => [0, 0, 10, 0],
        }),
      },
    });
    callFirst.mockResolvedValue({});

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'old',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'GND' },
      }),
    ).resolves.toMatchObject({ primitiveId: 'after' });
  });

  it('rejects an unconfirmed recreation when inventory diff is ambiguous', async () => {
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ primitiveId: 'a' }, { primitiveId: 'b' }]);
    const { operations, callFirst } = createSubject({ SCH_PrimitiveWire: { getAll } });
    callFirst.mockResolvedValue({});

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'old',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0] },
      }),
    ).rejects.toMatchObject({ code: 'CREATE_UNCONFIRMED' });
  });
  it('captures a wire snapshot through an expected-kind lookup', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn().mockResolvedValue({
          getState_Line: () => [0, 0, 5, 0],
          getState_Net: () => 'GND',
        }),
      },
    });
    await expect(operations.getPrimitiveSnapshot('wire-1', 'wire')).resolves.toMatchObject({
      primitiveKind: 'wire',
      property: { line: [0, 0, 5, 0], net: 'GND' },
    });
  });

  it('merges component state and contains a failed pin-coordinate read', async () => {
    const pinFailure = new Error('pins unavailable');
    const modify = vi.fn().mockResolvedValue({ ok: true });
    const current = {
      getState_ComponentType: () => 'component',
      getState_X: () => 1,
      getState_Y: () => 2,
      getState_OtherProperty: () => ({ existing: 'yes' }),
      getState_Designator: () => 'U1',
    };
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(current), modify },
    });
    callFirst.mockRejectedValue(pinFailure);

    await expect(
      operations.modifyPrimitive('cmp-1', {
        x: 10,
        otherProperty: { incoming: 'yes' },
      }),
    ).rejects.toMatchObject({ code: 'MOVE_CONNECTIVITY_UNVERIFIED' });
    expect(modify).not.toHaveBeenCalled();
    expect(logRecoverableError).toHaveBeenCalledWith('failed to read pins for cmp-1', pinFailure);
  });

  it('rejects malformed native pin or wire inventory before writing', async () => {
    const modifyComponent = vi.fn().mockResolvedValue({ moved: true });
    const modifyWire = vi.fn().mockResolvedValue(true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 0,
          getState_Y: () => 0,
        }),
        modify: modifyComponent,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([{ primitiveId: 'bad', line: [1, 2, 'malformed'] }]),
        modify: modifyWire,
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);
    await expect(operations.modifyPrimitive('cmp-1', { x: 10, y: 20 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(modifyComponent).not.toHaveBeenCalled();
    expect(modifyWire).not.toHaveBeenCalled();
  });

  it('returns a successful component move when no usable wire class exists', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
      SCH_PrimitiveWire: { getAll: vi.fn() },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);

    await expect(operations.modifyPrimitive('cmp-1', { x: 2 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
  });

  it('contains wire inventory failures during component following', async () => {
    const wireReadFailure = new Error('wire inventory failed');
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockRejectedValue(wireReadFailure),
        modify: vi.fn(),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);

    await expect(operations.modifyPrimitive('cmp-1', { y: 3 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'failed to preflight wires before a component move',
      wireReadFailure,
    );
  });

  it.each([
    ['horizontal', { x: 500, y: 400 }],
    ['vertical', { x: 300, y: 300 }],
  ])('blocks #945 %s move of a 2-pin resistor attached to different nets', async (_axis, next) => {
    const componentModify = vi.fn(async () => true);
    const wireModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
        }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([
          { primitiveId: 'stub-a', line: [250, 400, 280, 400], net: 'REPRO_A' },
          { primitiveId: 'stub-b', line: [350, 400, 320, 400], net: 'REPRO_B' },
        ]),
        modify: wireModify,
      },
    });
    callFirst.mockResolvedValue([
      { getState_X: () => 280, getState_Y: () => 400 },
      { getState_X: () => 320, getState_Y: () => 400 },
    ]);
    await expect(operations.modifyPrimitive('R19', next)).rejects.toMatchObject({
      code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
    });
    expect(componentModify).not.toHaveBeenCalled();
    expect(wireModify).not.toHaveBeenCalled();
  });

  it('refuses #945 movement when a just-created wire is missing from the native inventory', async () => {
    const modify = vi.fn(async () => ({ moved: true }));
    const wire = { primitiveId: 'fresh-stub', line: [280, 400, 250, 400] };
    const wireApi = {
      getAll: vi.fn().mockResolvedValue([]), // Real Pro 3.2.209 stale same-session result.
      get: vi.fn().mockResolvedValue(wire), // Exact-ID native read knows the new primitive.
    };
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 300, getState_Y: () => 400 }),
        modify,
      },
      SCH_PrimitiveWire: wireApi,
    });
    callFirst.mockResolvedValue([
      { getState_X: () => 280, getState_Y: () => 400 },
      { getState_X: () => 320, getState_Y: () => 400 },
    ]);
    operations.noteNativeWireMutation('create', ['fresh-stub']);
    await expect(operations.modifyPrimitive('R19', { x: 500 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('rechecks a pending fresh-wire ID and refuses a move when its geometry touches a pin', async () => {
    const modify = vi.fn();
    const wire = { primitiveId: 'fresh-stub', line: [250, 400, 280, 400] };
    const wireApi = {
      getAll: vi.fn().mockResolvedValue([wire]),
      get: vi.fn().mockResolvedValue(wire),
    };
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 300, getState_Y: () => 400 }),
        modify,
      },
      SCH_PrimitiveWire: wireApi,
    });
    callFirst.mockResolvedValue([{ getState_X: () => 280, getState_Y: () => 400 }]);
    operations.noteNativeWireMutation('create', ['fresh-stub']);
    await expect(operations.modifyPrimitive('R19', { x: 500 })).rejects.toMatchObject({
      code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
    });
    expect(wireApi.get).toHaveBeenCalledWith('fresh-stub');
    expect(modify).not.toHaveBeenCalled();
  });

  it('rejects a component move when an edited wire has no exact native get(id) reader', async () => {
    const modify = vi.fn();
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 300, getState_Y: () => 400 }),
        modify,
      },
      SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue([]) },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 280, getState_Y: () => 400 }]);
    operations.noteNativeWireMutation('create', ['new-native-wire']);
    await expect(operations.modifyPrimitive('R19', { x: 500 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      message: expect.stringContaining('Exact native wire read unavailable'),
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('refuses a component move if exact-ID wire read times out after native creation', async () => {
    const modify = vi.fn();
    const failure = new Error('native get wire timed out');
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 300, getState_Y: () => 400 }),
        modify,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockRejectedValue(failure),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 280, getState_Y: () => 400 }]);
    operations.noteNativeWireMutation('create', ['new-native-wire']);
    await expect(operations.modifyPrimitive('R19', { x: 500 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      message: expect.stringContaining('could not be reconciled'),
    });
    expect(logRecoverableError).toHaveBeenCalledWith('native fresh-wire read failed', failure);
    expect(modify).not.toHaveBeenCalled();
  });

  it('keeps ambiguous native wire writes fail-closed until a documented editor reset', async () => {
    const modify = vi.fn();
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 300, getState_Y: () => 400 }),
        modify,
      },
      SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue([]) },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 280, getState_Y: () => 400 }]);
    operations.noteNativeWireMutation('unknown', []);
    await expect(operations.modifyPrimitive('R19', { x: 500 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('allows an isolated component move after complete native pin and unrelated wire read', async () => {
    const componentModify = vi.fn(async () => true);
    const wireModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
        }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([
          {
            primitiveId: 'unrelated',
            line: [
              [900, 900],
              [1000, 1000],
            ],
            net: 'OTHER',
          },
        ]),
        modify: wireModify,
      },
    });
    callFirst.mockResolvedValue([
      { getState_X: () => 280, getState_Y: () => 400 },
      { getState_X: () => 320, getState_Y: () => 400 },
    ]);
    await expect(operations.modifyPrimitive('R19', { x: 500, y: 400 })).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(componentModify).toHaveBeenCalledOnce();
    expect(wireModify).not.toHaveBeenCalled();
  });

  it('refuses an unwired move that would place a pin on another net endpoint', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 0, getState_Y: () => 0 }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValue([{ primitiveId: 'other-net', line: [100, 100, 110, 100] }]),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 0, getState_Y: () => 0 }]);
    await expect(operations.modifyPrimitive('cmp', { x: 100, y: 100 })).rejects.toMatchObject({
      code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
    });
    expect(componentModify).not.toHaveBeenCalled();
  });

  it.each([
    ['source interior', [250, 400, 330, 400], { x: 500, y: 400 }, 280, 400],
    ['destination interior', [450, 400, 530, 400], { x: 500, y: 400 }, 280, 400],
    ['diagonal interior', [250, 370, 310, 430], { x: 500, y: 400 }, 280, 400],
    [
      'polyline interior',
      [
        [100, 100],
        [250, 400],
        [330, 400],
      ],
      { x: 500, y: 400 },
      280,
      400,
    ],
    ['near-contact', [250, 400.0003, 330, 400.0003], { x: 500, y: 400 }, 280, 400],
    ['degenerate wire', [250, 400, 250, 400], { x: 500, y: 400 }, 250, 400],
  ])(
    'refuses #945 move when a pin touches a wire segment at %s',
    async (_scenario, line, next, pinX, pinY) => {
      const componentModify = vi.fn(async () => true);
      const wireModify = vi.fn(async () => true);
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => 'component',
            getState_X: () => 300,
            getState_Y: () => 400,
          }),
          modify: componentModify,
        },
        SCH_PrimitiveWire: {
          getAll: vi.fn().mockResolvedValue([{ primitiveId: 'mid-segment-net', line }]),
          modify: wireModify,
        },
      });
      callFirst.mockResolvedValue([{ getState_X: () => pinX, getState_Y: () => pinY }]);
      await expect(operations.modifyPrimitive('cmp', next)).rejects.toMatchObject({
        code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
      });
      expect(componentModify).not.toHaveBeenCalled();
      expect(wireModify).not.toHaveBeenCalled();
    },
  );

  it('permits a genuinely unwired move despite duplicate distant wire vertices', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 300, getState_Y: () => 400 }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValue([
            { primitiveId: 'real-native-wire', line: [100, 100, 100, 100, 120, 100], net: '' },
          ]),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 280, getState_Y: () => 400 }]);
    await expect(operations.modifyPrimitive('cmp', { x: 301 })).resolves.toMatchObject({
      followedWireIds: [],
    });
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it('permits an unwired move when a pin lies near but outside the wire span', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 0, getState_Y: () => 0 }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValue([{ primitiveId: 'bystander', line: [100, 100, 120, 100] }]),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 130, getState_Y: () => 100 }]);
    await expect(operations.modifyPrimitive('cmp', { x: 5, y: 0 })).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it.each([
    ['rotation', { rotation: 90 }],
    ['mirroring', { mirror: true }],
  ])('refuses #945 unverified component %s without writing', async (_case, property) => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
          getState_Rotation: () => 0,
          getState_Mirror: () => false,
        }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue([]) },
    });
    await expect(operations.modifyPrimitive('cmp', property)).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(callFirst).not.toHaveBeenCalled();
    expect(componentModify).not.toHaveBeenCalled();
  });

  it.each([
    ['rotation', { rotation: 0 }],
    ['mirroring', { mirror: false }],
  ])('permits #945 unchanged component %s metadata', async (_case, property) => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
          getState_Rotation: () => 0,
          getState_Mirror: () => false,
        }),
        modify: componentModify,
      },
    });
    await expect(operations.modifyPrimitive('cmp', property)).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(callFirst).not.toHaveBeenCalled();
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it('does not require pin/wire inventory for a same-coordinate property edit', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 100, getState_Y: () => 200 }),
        modify: componentModify,
      },
    });
    await expect(operations.modifyPrimitive('cmp', { x: 100 })).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(callFirst).not.toHaveBeenCalled();
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it('modifies wire state through the owning class', async () => {
    const modify = vi.fn().mockResolvedValue({ ok: true });
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn().mockResolvedValue({
          getState_Line: () => [0, 0, 1, 1],
          getState_Net: () => 'OLD',
          getState_Color: () => '#000',
          getState_LineWidth: () => 1,
          getState_LineType: () => 0,
        }),
        modify,
      },
    });

    await expect(operations.modifyPrimitive('wire-1', { net: 'NEW' })).resolves.toEqual({
      ok: true,
    });
    expect(modify).toHaveBeenCalledWith('wire-1', {
      line: [0, 0, 1, 1],
      net: 'NEW',
      color: '#000',
      lineWidth: 1,
      lineType: 0,
    });
  });

  it.each([
    ['rotate', { rotation: 90 }],
    ['mirror', { mirror: true }],
  ])(
    'refuses #945 untyped %s when component identity cannot be verified',
    async (_action, property) => {
      const nativeModify = vi.fn(async () => true);
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue(undefined),
          modify: nativeModify,
        },
      });
      callFirst.mockResolvedValue({ fallback: true });

      await expect(operations.modifyPrimitive('cmp-1', property)).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      expect(callFirst).not.toHaveBeenCalled();
      expect(nativeModify).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'throwing'])(
    'refuses a component coordinate update when the native owner getter is %s',
    async (condition) => {
      const componentModify = vi.fn();
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get:
            condition === 'missing'
              ? vi.fn().mockResolvedValue(undefined)
              : vi.fn().mockRejectedValue(new Error('native getter unavailable')),
          modify: componentModify,
        },
      });
      callFirst.mockResolvedValue({ fallback: true });

      await expect(operations.modifyPrimitive('cmp-1', { x: 500, y: 400 })).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      expect(componentModify).not.toHaveBeenCalled();
      expect(callFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['x NaN', { x: Number.NaN }],
    ['x infinity', { x: Number.POSITIVE_INFINITY }],
    ['y negative infinity', { y: Number.NEGATIVE_INFINITY }],
    ['x string', { x: '100' }],
    ['y null', { y: null }],
  ])(
    'refuses #945 invalid target coordinate %s before native mutation',
    async (_case, property) => {
      const componentModify = vi.fn(async () => true);
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => 'component',
            getState_X: () => 300,
            getState_Y: () => 400,
          }),
          modify: componentModify,
        },
      });
      await expect(operations.modifyPrimitive('cmp', property)).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      expect(callFirst).not.toHaveBeenCalled();
      expect(componentModify).not.toHaveBeenCalled();
    },
  );

  it('refuses a coordinate change when a component lacks verified original coordinates', async () => {
    const componentModify = vi.fn();
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
        }),
        modify: componentModify,
      },
    });
    await expect(operations.modifyPrimitive('cmp-1', { x: 500 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(componentModify).not.toHaveBeenCalled();
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('contains owner getter failures and reaches the generic modify fallback', async () => {
    const componentFailure = new Error('component get failed');
    const wireFailure = new Error('wire get failed');
    const circleFailure = new Error('circle get failed');
    const polygonFailure = new Error('polygon get failed');
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockRejectedValue(componentFailure), modify: vi.fn() },
      SCH_PrimitiveWire: { get: vi.fn().mockRejectedValue(wireFailure), modify: vi.fn() },
      SCH_PrimitiveCircle: { get: vi.fn().mockRejectedValue(circleFailure), modify: vi.fn() },
      SCH_PrimitivePolygon: { get: vi.fn().mockRejectedValue(polygonFailure), modify: vi.fn() },
    });
    callFirst.mockResolvedValue({ fallback: true });

    await expect(operations.modifyPrimitive('unknown', { value: 1 })).resolves.toEqual({
      fallback: true,
    });
    expect(callFirst).toHaveBeenCalledWith(
      [
        'SCH_PrimitiveComponent.modify',
        'SCH_PrimitiveWire.modify',
        'sch_PrimitiveComponent.modify',
        'sch_PrimitiveWire.modify',
      ],
      'unknown',
      { value: 1 },
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveComponent.get(unknown) failed',
      componentFailure,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveWire.get(unknown) failed',
      wireFailure,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveCircle.get(unknown) failed',
      circleFailure,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitivePolygon.get(unknown) failed',
      polygonFailure,
    );
  });

  it('rejects text modification when neither public nor cached alignment is available', async () => {
    const sameId = { primitiveId: 'text-1', content: 'hello' };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([sameId]),
        get: vi.fn().mockResolvedValue(sameId),
        modify: vi.fn(),
      },
    });

    await expect(operations.modifyPrimitive('text-1', { content: 'new' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
      message: 'Text text-1 did not expose a public alignMode',
    });
  });

  it('normalizes text aliases and uses cached alignment when public get is lossy', async () => {
    const persistent = { primitiveId: 'text-1', content: 'old', color: '#000' };
    const modify = vi.fn().mockResolvedValue({ getState_AlignMode: () => 8 });
    const { operations, textAlignCache } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([persistent]),
        get: vi.fn().mockResolvedValue({}),
        modify,
      },
    });
    textAlignCache.set('text-1', 3);

    await operations.modifyPrimitive('text-1', {
      content: 'new',
      color: '#fff',
      underline: true,
    });
    expect(modify).toHaveBeenCalledWith(
      'text-1',
      expect.objectContaining({
        content: 'new',
        textColor: '#fff',
        underLine: true,
        alignMode: 3,
      }),
    );
    expect(textAlignCache.get('text-1')).toBe(8);
  });

  it('uses requested text alignment and preserves it when modify returns no public alignment', async () => {
    const persistent = { primitiveId: 'text-1', content: 'old', color: '#000' };
    const modify = vi.fn().mockResolvedValue({});
    const { operations, textAlignCache } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([persistent]),
        get: vi.fn().mockResolvedValue({ primitiveId: 'text-1' }),
        modify,
      },
    });

    await operations.modifyPrimitive('text-1', { content: 'new', alignMode: 6 });
    expect(textAlignCache.get('text-1')).toBe(6);
  });
  it('reads text through persistent inventory only when cached alignment is known', async () => {
    const persistent = { primitiveId: 'text-1', x: 1, y: 2, content: 'cached' };
    const { operations, textAlignCache } = createSubject({
      SCH_PrimitiveText: { getAll: vi.fn().mockResolvedValue([persistent]) },
    });
    textAlignCache.set('text-1', 5);

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).resolves.toMatchObject({
      primitiveKind: 'text',
      property: { content: 'cached', alignMode: 5 },
    });
  });

  it('handles null text inventories without inventing a candidate', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue(null),
        get: vi.fn().mockResolvedValue(undefined),
      },
    });
    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
    });
  });

  it('uses an empty otherProperty object when a component exposes none', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
      },
    });
    await expect(operations.getPrimitiveSnapshot('cmp-1')).resolves.toMatchObject({
      property: { otherProperty: {} },
    });
  });

  it('falls back from TopLeft coordinates to X/Y in rectangle snapshots', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveRectangle: {
        get: vi.fn().mockResolvedValue({
          getState_X: () => 11,
          getState_Y: () => 12,
          getState_Width: () => 3,
          getState_Height: () => 4,
        }),
      },
    });
    await expect(operations.getPrimitiveSnapshot('rect-1', 'rectangle')).resolves.toMatchObject({
      property: { x: 11, y: 12, width: 3, height: 4 },
    });
  });

  it('finds unconstrained circle and polygon snapshots after earlier classes miss', async () => {
    const circleSubject = createSubject({
      SCH_PrimitiveCircle: {
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 1,
          getState_CenterY: () => 2,
          getState_Radius: () => 3,
        }),
      },
    });
    await expect(circleSubject.operations.getPrimitiveSnapshot('shape-1')).resolves.toMatchObject({
      primitiveKind: 'circle',
    });

    const polygonSubject = createSubject({
      SCH_PrimitivePolygon: {
        get: vi.fn().mockResolvedValue({ getState_Line: () => [0, 0, 1, 1] }),
      },
    });
    await expect(polygonSubject.operations.getPrimitiveSnapshot('shape-2')).resolves.toMatchObject({
      primitiveKind: 'polygon',
    });
  });

  it('throws the text alignment error after all unconstrained shape fallbacks miss', async () => {
    const sameId = { primitiveId: 'text-1', content: 'hello' };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([sameId]),
        get: vi.fn().mockResolvedValue(sameId),
      },
    });
    await expect(operations.getPrimitiveSnapshot('text-1')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
  });

  it('normalizes null component and wire inventories to empty lists', async () => {
    const componentSubject = createSubject({
      SCH_PrimitiveComponent: { getAll: vi.fn().mockResolvedValue(null) },
    });
    await expect(componentSubject.operations.listPrimitiveIds('component')).resolves.toMatchObject({
      primitiveIds: [],
    });

    const wireSubject = createSubject({
      SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue(null) },
    });
    await expect(wireSubject.operations.listPrimitiveIds('wire')).resolves.toMatchObject({
      primitiveIds: [],
    });
  });

  it('normalizes null ID inventories in listing and ownership checks', async () => {
    const listSubject = createSubject({
      SCH_PrimitiveCircle: { getAllPrimitiveId: vi.fn().mockResolvedValue(null) },
    });
    await expect(listSubject.operations.listPrimitiveIds('circle')).resolves.toMatchObject({
      primitiveIds: [],
    });

    const deleteSubject = createSubject({
      SCH_PrimitiveRectangle: {
        getAllPrimitiveId: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
      },
    });
    await expect(deleteSubject.operations.deletePrimitives(['missing'])).resolves.toMatchObject({
      notFound: ['missing'],
    });
  });

  it('rejects non-array pin inventories before moving a component', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
    });
    callFirst.mockResolvedValue({ not: 'pins' });
    await expect(operations.modifyPrimitive('cmp-1', { x: 2 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
  });

  it('allows unrelated wire geometry but rejects a missing follow-up wire inventory', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 0,
          getState_Y: () => 0,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValueOnce([{ primitiveId: 'other', line: [9, 9, 8, 8] }])
          .mockResolvedValueOnce([{ primitiveId: 'other', line: [9, 9, 8, 8] }])
          .mockResolvedValueOnce(null),
        getAllPrimitiveId: vi.fn().mockResolvedValue(['other']),
        modify: vi.fn(),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);

    await expect(operations.modifyPrimitive('cmp-1', { x: 1 })).resolves.toMatchObject({
      followedWireIds: [],
    });
    await expect(operations.modifyPrimitive('cmp-1', { y: 1 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
  });

  it('falls through when a qualified text class cannot find the requested text', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveText: {
        get: vi.fn().mockResolvedValue(undefined),
        modify: vi.fn(),
      },
    });
    callFirst.mockResolvedValue({ fallback: true });
    await expect(operations.modifyPrimitive('missing', { content: 'x' })).resolves.toEqual({
      fallback: true,
    });
  });

  it('falls through when the polygon class lacks a modify API', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitivePolygon: { get: vi.fn().mockResolvedValue({}) },
    });
    callFirst.mockResolvedValue({ fallback: true });
    await expect(operations.modifyPrimitive('poly-1', { line: [] })).resolves.toEqual({
      fallback: true,
    });
  });
});
