import { describe, expect, it, vi } from 'vitest';
import {
  inspectIsolatedNativeGround,
  parseNativeGroundIsolation,
} from '../src/schematic-native-ground-isolation.js';

const symbol = {
  name: 'Ground-GND',
  uuid: 'af20086a8911a85a',
  libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
};

type Field = Record<string, unknown>;
const primitive = (fields: Field) =>
  Object.fromEntries(
    Object.entries(fields).map(([name, value]) => ['getState_' + name, () => value]),
  );

function makeFixture() {
  const sheet = primitive({ PrimitiveId: 'sheet-1', ComponentType: 'sheet', Net: '' });
  const virtualPin = primitive({
    PrimitiveId: 'flag-1-e15',
    PinName: 'Pin1',
    PinNumber: '1',
    pinType: 'IN',
    X: 240,
    Y: 250,
    Rotation: 90,
    NoConnected: false,
  });
  const marker = {
    ...primitive({
      PrimitiveId: 'flag-1',
      ComponentType: 'netflag',
      Name: 'GND',
      Net: 'GND',
      Component: symbol,
      X: 240,
      Y: 250,
      Rotation: 0,
      Mirror: false,
    }),
    getAllPins: vi.fn(async () => [virtualPin]),
  };
  const attrs = [
    primitive({ PrimitiveId: 'a-1', ParentPrimitiveId: 'sheet-1', Value: 'Schematic1' }),
    primitive({ PrimitiveId: 'a-2', ParentPrimitiveId: 'flag-1', Value: 'GND' }),
    primitive({
      PrimitiveId: 'a-3',
      ParentPrimitiveId: 'flag-1-e15',
      Key: 'Pin Name',
      Value: 'Pin1',
    }),
    primitive({
      PrimitiveId: 'a-4',
      ParentPrimitiveId: 'flag-1-e15',
      Key: 'Pin Number',
      Value: '1',
    }),
    primitive({
      PrimitiveId: 'a-5',
      ParentPrimitiveId: 'flag-1-e15',
      Key: 'Pin Type',
      Value: 'IN',
    }),
  ];
  const wires: unknown[] = [];
  const pins: unknown[] = [];
  const components: unknown[] = [sheet, marker];
  const attributes: unknown[] = [...attrs];
  const createOwner = (collection: unknown[]) => ({
    getAll: vi.fn(async () => [...collection]),
    getAllPrimitiveId: vi.fn(async () =>
      collection.map((item) => (item as { getState_PrimitiveId(): string }).getState_PrimitiveId()),
    ),
    get: vi.fn(async (id: string) =>
      collection.find(
        (item) => (item as { getState_PrimitiveId(): string }).getState_PrimitiveId() === id,
      ),
    ),
  });
  const owners = {
    SCH_PrimitiveWire: createOwner(wires),
    SCH_PrimitivePin: {
      ...createOwner(pins),
      get: vi.fn(async (id: string) => (id === 'flag-1-e15' ? virtualPin : undefined)),
    },
    SCH_PrimitiveComponent: createOwner(components),
    SCH_PrimitiveAttribute: createOwner(attributes),
  };
  const opts = {
    readFirstPath: (paths: string[]) => owners[paths[0] as keyof typeof owners],
    markerId: 'flag-1',
    readState: (item: unknown, key: string): unknown =>
      (item as Record<string, () => unknown>)?.['getState_' + key]?.(),
    extractPrimitiveId: (item: unknown): string =>
      (item as { getState_PrimitiveId(): string }).getState_PrimitiveId(),
    settle: vi.fn(async () => {}),
  };
  return { opts, owners, marker, virtualPin, components, attributes, wires, pins, sheet };
}

describe('native Ground isolation descriptor parsing', () => {
  const valid = {
    kind: 'verified-disconnected-ground/v1',
    markerId: 'flag-1',
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: 38,
  };
  const invalid = (message: string) =>
    Object.assign(new Error(message), { code: 'INVALID_PARAMS' });

  it('copies an exact bounded descriptor instead of retaining untrusted object references', () => {
    const parsed = parseNativeGroundIsolation(valid, 'flag-1', invalid);
    expect(parsed).toEqual(valid);
    expect(parsed).not.toBe(valid);
    expect(parseNativeGroundIsolation(undefined, 'flag-1', invalid)).toBeUndefined();
  });

  it.each(
    [
      undefined,
      null,
      {},
      [],
      { ...valid, kind: 'other-evidence' },
      { ...valid, markerId: 'other' },
      { ...valid, componentCount: 3 },
      { ...valid, wireCount: 1 },
      { ...valid, pagePinCount: 1 },
      { ...valid, embeddedPinCount: 0 },
      { ...valid, attributeCount: 0 },
      { ...valid, attributeCount: 257 },
      { ...valid, attributeCount: 1.5 },
      { ...valid, additionalCapability: true },
    ].slice(1),
  )('refuses malformed or overclaimed native Ground evidence: %j', (candidate) => {
    expect(() => parseNativeGroundIsolation(candidate, 'flag-1', invalid)).toThrow(
      'Invalid native Ground isolation descriptor',
    );
  });
});

describe('native disconnected Ground topology inspection', () => {
  it('accepts two independent, exact-ID native inventories with sheet-owned attributes', async () => {
    const { opts, owners } = makeFixture();
    await expect(inspectIsolatedNativeGround(opts)).resolves.toMatchObject({
      kind: 'verified-disconnected-ground/v1',
      markerId: 'flag-1',
      componentCount: 2,
      wireCount: 0,
      pagePinCount: 0,
      embeddedPinCount: 1,
      attributeCount: 5,
    });
    expect(opts.settle).toHaveBeenCalledTimes(1);
    expect(owners.SCH_PrimitiveAttribute.getAll).toHaveBeenCalledTimes(2);
  });

  it.each([
    'wire',
    'pin',
    'unknown component',
    'unknown attribute owner',
    'bad native symbol',
    'missing attribute ID',
  ])('refuses to certify when page includes %s', async (change) => {
    const f = makeFixture();
    if (change === 'wire')
      f.wires.push(primitive({ PrimitiveId: 'wire-1', Line: [240, 250, 280, 250] }));
    if (change === 'pin') f.pins.push(primitive({ PrimitiveId: 'pin-1' }));
    if (change === 'unknown component')
      f.components.push(primitive({ PrimitiveId: 'cmp-2', ComponentType: 'component' }));
    if (change === 'unknown attribute owner')
      f.attributes.push(
        primitive({ PrimitiveId: 'a-3', ParentPrimitiveId: 'other', Value: 'GND' }),
      );
    if (change === 'bad native symbol')
      f.components[1] = primitive({
        PrimitiveId: 'flag-1',
        ComponentType: 'netflag',
        Net: 'GND',
        Name: 'GND',
        Component: { ...symbol, uuid: 'different' },
        X: 240,
        Y: 250,
        Rotation: 0,
        Mirror: false,
      });
    if (change === 'missing attribute ID')
      f.owners.SCH_PrimitiveAttribute.getAllPrimitiveId.mockResolvedValue(['a-1']);
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses to certify an inventory that changes between the two reads', async () => {
    const f = makeFixture();
    f.opts.settle.mockImplementation(async () => {
      f.attributes.push(
        primitive({ PrimitiveId: 'a-6', ParentPrimitiveId: 'flag-1', Value: 'changed' }),
      );
    });
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses a missing exact-addressable embedded pin despite a readable Ground marker', async () => {
    const f = makeFixture();
    f.owners.SCH_PrimitivePin.get.mockResolvedValue(undefined);
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses inconsistent embedded pin attributes, including a forged type', async () => {
    const f = makeFixture();
    f.attributes[4] = primitive({
      PrimitiveId: 'a-5',
      ParentPrimitiveId: 'flag-1-e15',
      Key: 'Pin Type',
      Value: 'OUT',
    });
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses a second or missing embedded native pin', async () => {
    const f = makeFixture();
    f.marker.getAllPins.mockResolvedValue([f.virtualPin, f.virtualPin]);
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses when independent native getAll/getAllPrimitiveId disagrees', async () => {
    const f = makeFixture();
    f.owners.SCH_PrimitiveComponent.getAllPrimitiveId.mockResolvedValue(['sheet-1', 'wrong']);
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses when a required native reader is unavailable', async () => {
    const f = makeFixture();
    f.owners.SCH_PrimitivePin.getAll = undefined as never;
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses when the direct exact-ID marker read disagrees with the inventory', async () => {
    const f = makeFixture();
    f.owners.SCH_PrimitiveComponent.get.mockResolvedValue(undefined);
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });
});
