import { describe, expect, it, vi } from 'vitest';
import { defaultGroundAttributeFields } from './fixtures/native-ground-default-attributes.js';
import {
  inspectIsolatedNativeGround,
  inspectReconstructableNativeGround,
  parseNativeGroundIsolation,
} from '../src/schematic-native-ground-isolation.js';

const symbol = {
  name: 'Ground-GND',
  uuid: 'af20086a8911a85a',
  libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
};

type Field = Record<string, unknown>;
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
const primitive = (fields: Field) =>
  Object.fromEntries(
    Object.entries('ParentPrimitiveId' in fields ? { ...attrDefaults, ...fields } : fields).map(
      ([name, value]) => ['getState_' + name, () => value],
    ),
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
    kind: 'verified-disconnected-ground/v2',
    markerId: 'flag-1',
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: 38,
    attributeFingerprint: 'a'.repeat(64),
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
      { ...valid, attributeFingerprint: undefined },
      { ...valid, attributeFingerprint: 'bad-hash' },
      { ...valid, kind: 'verified-disconnected-ground/v1' },
      { ...valid, additionalCapability: true },
    ].slice(1),
  )('refuses malformed or overclaimed native Ground evidence: %j', (candidate) => {
    expect(() => parseNativeGroundIsolation(candidate, 'flag-1', invalid)).toThrow(
      'Invalid native Ground isolation descriptor',
    );
  });
});

describe('strict native reconstructability preflight', () => {
  function makeDefaultFixture() {
    const f = makeFixture();
    const owned = defaultGroundAttributeFields('flag-1');
    f.attributes.splice(1, 4, ...owned.map(primitive));
    return { ...f, owned };
  }

  it('accepts the independently observed default nine owned attributes', async () => {
    const f = makeDefaultFixture();
    await expect(inspectReconstructableNativeGround(f.opts)).resolves.toMatchObject({
      attributeCount: 10,
      attributeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    ['custom content', 'Name', { Value: 'custom' }],
    ['custom visibility', 'Global Net Name', { ValueVisible: false }],
    ['custom geometry', 'Pin Name', { Y: 241 }],
    ['custom font', 'Pin Number', { FontName: 'Arial' }],
    ['unexpected reference', 'Relevance', { Value: '[1]' }],
  ])('refuses %s before earning reconstruction evidence', async (_, key, change) => {
    const f = makeDefaultFixture();
    const index = f.owned.findIndex((row) => row.Key === key);
    f.attributes[index + 1] = primitive({ ...f.owned[index], ...change });
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeDefined();
    await expect(inspectReconstructableNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('refuses unknown, duplicate and missing native owned attributes', async () => {
    const f = makeDefaultFixture();
    f.attributes.push(primitive({ ...f.owned[0], PrimitiveId: 'another-owned-attr' }));
    await expect(inspectReconstructableNativeGround(f.opts)).resolves.toBeUndefined();
    f.attributes.pop();
    f.attributes[1] = primitive({ ...f.owned[0], Key: 'Unexpected' });
    await expect(inspectReconstructableNativeGround(f.opts)).resolves.toBeUndefined();
    f.attributes.splice(1, 1);
    await expect(inspectReconstructableNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('does not mistake a readable but non-default Ground for a reconstructable one', async () => {
    const f = makeFixture();
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeDefined();
    await expect(inspectReconstructableNativeGround(f.opts)).resolves.toBeUndefined();
  });
});

describe('native disconnected Ground topology inspection', () => {
  it('distinguishes stable inventories with equal counts but different attribute contents', async () => {
    const f = makeFixture();
    const original = await inspectIsolatedNativeGround(f.opts);
    f.attributes[1] = primitive({
      PrimitiveId: 'a-2',
      ParentPrimitiveId: 'flag-1',
      Key: 'Description',
      Value: 'changed',
    });
    const changed = await inspectIsolatedNativeGround(f.opts);
    expect(original?.attributeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(changed?.attributeCount).toBe(original?.attributeCount);
    expect(changed?.attributeFingerprint).not.toBe(original?.attributeFingerprint);
  });

  it('normalizes only unset visibility in empty native marker Relevance metadata', async () => {
    const f = makeFixture();
    const base = { PrimitiveId: 'a-2', ParentPrimitiveId: 'flag-1', Key: 'Relevance', Value: '[]' };
    f.attributes[1] = primitive({ ...base, KeyVisible: undefined, ValueVisible: undefined });
    const before = await inspectIsolatedNativeGround(f.opts);
    expect(before?.attributeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    f.attributes[1] = primitive({ ...base, KeyVisible: null, ValueVisible: null });
    const restored = await inspectIsolatedNativeGround(f.opts);
    expect(restored?.attributeFingerprint).toBe(before?.attributeFingerprint);
    f.attributes[1] = primitive({ ...base, KeyVisible: false, ValueVisible: null });
    const actualVisibilityChanged = await inspectIsolatedNativeGround(f.opts);
    expect(actualVisibilityChanged?.attributeFingerprint).not.toBe(before?.attributeFingerprint);
    f.attributes[1] = primitive({ ...base, Value: '[1]', KeyVisible: undefined });
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
    f.attributes[1] = primitive({ ...base, Key: 'Name', Value: 'GND', ValueVisible: undefined });
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('detects an attribute geometry change without a count or content change', async () => {
    const f = makeFixture();
    const before = await inspectIsolatedNativeGround(f.opts);
    f.attributes[1] = primitive({
      PrimitiveId: 'a-2',
      ParentPrimitiveId: 'flag-1',
      Value: 'GND',
      X: 123,
    });
    const after = await inspectIsolatedNativeGround(f.opts);
    expect(after?.attributeCount).toBe(before?.attributeCount);
    expect(after?.attributeFingerprint).not.toBe(before?.attributeFingerprint);
  });

  it('refuses a stale exact attribute read even when the inventory and counts match', async () => {
    const f = makeFixture();
    const original = f.owners.SCH_PrimitiveAttribute.get.getMockImplementation();
    f.owners.SCH_PrimitiveAttribute.get.mockImplementation(async (id: string) =>
      id === 'a-2'
        ? primitive({ PrimitiveId: id, ParentPrimitiveId: 'flag-1', Value: 'changed' })
        : original?.(id),
    );
    await expect(inspectIsolatedNativeGround(f.opts)).resolves.toBeUndefined();
  });

  it('accepts two independent, exact-ID native inventories with sheet-owned attributes', async () => {
    const { opts, owners } = makeFixture();
    await expect(inspectIsolatedNativeGround(opts)).resolves.toMatchObject({
      kind: 'verified-disconnected-ground/v2',
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
