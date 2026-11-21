import { verifiedNativeGroundDescriptor } from './schematic-native-ground-identity.js';
import { isRecord } from './utils.js';

type NativeReader = {
  getAll?: () => Promise<unknown>;
  getAllPrimitiveId?: () => Promise<unknown>;
  get?: (id: string) => Promise<unknown>;
};

interface InventoryRecord {
  id: string;
  primitive: unknown;
}

export interface NativeGroundIsolationEvidence {
  kind: 'verified-disconnected-ground/v1';
  markerId: string;
  componentCount: 2;
  wireCount: 0;
  pagePinCount: 0;
  embeddedPinCount: 1;
  attributeCount: number;
}

function isBoundedAttributeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 256;
}

function hasExactIsolationKeys(value: Record<string, unknown>): boolean {
  const keys = [
    'kind',
    'markerId',
    'componentCount',
    'wireCount',
    'pagePinCount',
    'embeddedPinCount',
    'attributeCount',
  ];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Parse a caller-visible snapshot descriptor by exact shape.
 * This is a consistency check, NOT independent native evidence or a write grant.
 */
export function parseNativeGroundIsolation(
  input: unknown,
  primitiveId: string,
  invalid: (message: string) => Error,
): NativeGroundIsolationEvidence | undefined {
  if (input === undefined) return undefined;
  if (
    !isRecord(input) ||
    !hasExactIsolationKeys(input) ||
    input.kind !== 'verified-disconnected-ground/v1' ||
    typeof primitiveId !== 'string' ||
    !primitiveId ||
    input.markerId !== primitiveId ||
    input.componentCount !== 2 ||
    input.wireCount !== 0 ||
    input.pagePinCount !== 0 ||
    input.embeddedPinCount !== 1 ||
    !isBoundedAttributeCount(input.attributeCount)
  ) {
    throw invalid('Invalid native Ground isolation descriptor');
  }
  return {
    kind: 'verified-disconnected-ground/v1',
    markerId: primitiveId,
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: input.attributeCount,
  };
}

interface GroundIsolationDependencies {
  markerId: string;
  readFirstPath(paths: string[]): unknown;
  readState(primitive: unknown, key: string): unknown;
  extractPrimitiveId(primitive: unknown): string;
  settle?(): Promise<void>;
}

type InventoryKind = 'Wire' | 'Pin' | 'Component' | 'Attribute';

interface NativeInventory {
  items: InventoryRecord[];
  byId: Map<string, InventoryRecord>;
}

function requiredReader(deps: GroundIsolationDependencies, kind: InventoryKind): NativeReader {
  const path = 'SCH_Primitive' + kind;
  const alternate = 'sch_Primitive' + kind;
  const reader = deps.readFirstPath([path, alternate]) as NativeReader | undefined;
  if (
    typeof reader?.getAll !== 'function' ||
    typeof reader.getAllPrimitiveId !== 'function' ||
    ((kind === 'Component' || kind === 'Pin') && typeof reader.get !== 'function')
  ) {
    throw new Error('Native ' + kind + ' inventory readback unavailable');
  }
  return reader;
}

async function readInventory(
  deps: GroundIsolationDependencies,
  reader: NativeReader,
  kind: InventoryKind,
): Promise<NativeInventory> {
  const all = await reader.getAll?.();
  const ids = await reader.getAllPrimitiveId?.();
  if (
    !Array.isArray(all) ||
    !Array.isArray(ids) ||
    all.length > 256 ||
    ids.length !== all.length ||
    ids.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new Error('Native ' + kind + ' inventory incomplete');
  }
  const collection: InventoryRecord[] = all.map((primitive) => ({
    id: deps.extractPrimitiveId(primitive),
    primitive,
  }));
  const nativeIds = new Set<string>(ids);
  const localIds = new Set(collection.map((entry) => entry.id));
  if (
    nativeIds.size !== ids.length ||
    localIds.size !== collection.length ||
    collection.some(({ id }) => !id || !nativeIds.has(id))
  ) {
    throw new Error('Native ' + kind + ' collection and ID inventory mismatch');
  }
  collection.sort((a, b) => a.id.localeCompare(b.id));
  return { items: collection, byId: new Map(collection.map((entry) => [entry.id, entry])) };
}

function groundSignature(deps: GroundIsolationDependencies, primitive: unknown): string {
  const get = (key: string) => deps.readState(primitive, key);
  if (
    get('ComponentType') !== 'netflag' ||
    get('Name') !== 'GND' ||
    !verifiedNativeGroundDescriptor(get('Component'), '4.1.105', get('Net')) ||
    typeof get('X') !== 'number' ||
    !Number.isFinite(get('X')) ||
    typeof get('Y') !== 'number' ||
    !Number.isFinite(get('Y')) ||
    typeof get('Rotation') !== 'number' ||
    !Number.isFinite(get('Rotation')) ||
    typeof get('Mirror') !== 'boolean'
  ) {
    throw new Error('Ground marker is not a verified native identity or pose');
  }
  return JSON.stringify([
    get('Component'),
    get('Name'),
    get('Net'),
    get('X'),
    get('Y'),
    get('Rotation'),
    get('Mirror'),
  ]);
}

function verifiedPinSignature(
  deps: GroundIsolationDependencies,
  marker: unknown,
  pin: unknown,
): string {
  const getPin = (key: string) => deps.readState(pin, key);
  const expected = [
    'Pin1',
    '1',
    'IN',
    deps.readState(marker, 'X'),
    deps.readState(marker, 'Y'),
    90,
    false,
  ];
  const actual = [
    getPin('PinName'),
    getPin('PinNumber'),
    getPin('pinType'),
    getPin('X'),
    getPin('Y'),
    getPin('Rotation'),
    getPin('NoConnected'),
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Native Ground embedded pin descriptor mismatch');
  }
  return JSON.stringify(actual);
}

async function readVerifiedEmbeddedGroundPin(
  deps: GroundIsolationDependencies,
  marker: unknown,
  direct: unknown,
  reader: NativeReader,
): Promise<{ id: string; signature: string }> {
  // The schematic's embedded pin is absent from the symbol-editor getAll(),
  // but is addressable through component.getAllPins() and pin.get(id).
  const withPins = direct as { getAllPins?: () => Promise<unknown> };
  if (typeof withPins.getAllPins !== 'function') {
    throw new Error('Native Ground embedded pin inventory unavailable');
  }
  const embedded = await withPins.getAllPins();
  const id = deps.markerId + '-e15';
  if (
    !Array.isArray(embedded) ||
    embedded.length !== 1 ||
    deps.extractPrimitiveId(embedded[0]) !== id
  ) {
    throw new Error('Native Ground embedded pin identity differs');
  }
  const native = await reader.get?.(id);
  if (!native || deps.extractPrimitiveId(native) !== id) {
    throw new Error('Native Ground exact pin read unavailable');
  }
  if (deps.readState(marker, 'Rotation') !== 0 || deps.readState(marker, 'Mirror') !== false) {
    throw new Error('Native Ground pin orientation not verified');
  }
  const signature = verifiedPinSignature(deps, marker, native);
  if (verifiedPinSignature(deps, marker, embedded[0]) !== signature) {
    throw new Error('Ground embedded pin inventory differs from direct read');
  }
  return { id, signature };
}

function readVerifiedGroundAttributes(
  deps: GroundIsolationDependencies,
  attributes: NativeInventory,
  sheetId: string,
  pinId: string,
): unknown[][] {
  const allowedPinKeys = new Map([
    ['Pin Name', 'Pin1'],
    ['Pin Number', '1'],
    ['Pin Type', 'IN'],
  ]);
  const seen = new Set<string>();
  const entries = attributes.items.map(({ id, primitive }) => {
    const owner = deps.readState(primitive, 'ParentPrimitiveId');
    const value = deps.readState(primitive, 'Value');
    const key = deps.readState(primitive, 'Key');
    if (owner === pinId) {
      if (typeof key !== 'string' || seen.has(key) || allowedPinKeys.get(key) !== value) {
        throw new Error('Ground embedded pin attributes do not match native pin');
      }
      seen.add(key);
    }
    if (
      (owner !== sheetId && owner !== deps.markerId && owner !== pinId) ||
      (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') ||
      (typeof value === 'string' && value.length > 1024) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error('Attribute ownership or value not safely readable');
    }
    return [id, owner, key, value];
  });
  if (seen.size !== allowedPinKeys.size) {
    throw new Error('Native Ground embedded pin attributes incomplete');
  }
  return entries;
}

async function capture(deps: GroundIsolationDependencies): Promise<{
  canonical: string;
  count: number;
}> {
  const wireReader = requiredReader(deps, 'Wire');
  const pinReader = requiredReader(deps, 'Pin');
  const componentReader = requiredReader(deps, 'Component');
  const attributeReader = requiredReader(deps, 'Attribute');

  const wires = await readInventory(deps, wireReader, 'Wire');
  const pins = await readInventory(deps, pinReader, 'Pin');
  const components = await readInventory(deps, componentReader, 'Component');
  const attributes = await readInventory(deps, attributeReader, 'Attribute');

  if (wires.items.length !== 0 || pins.items.length !== 0 || components.items.length !== 2) {
    throw new Error('Page has wires, pins, or other components');
  }
  const marker = components.byId.get(deps.markerId)?.primitive;
  const sheet = components.items.find(
    ({ id, primitive }) =>
      id !== deps.markerId && deps.readState(primitive, 'ComponentType') === 'sheet',
  );
  if (!marker || !sheet) throw new Error('Target marker or unique sheet missing');

  const markerSignature = groundSignature(deps, marker);
  const direct = await componentReader.get?.(deps.markerId);
  if (!direct || deps.extractPrimitiveId(direct) !== deps.markerId) {
    throw new Error('Exact-ID native Ground read unavailable');
  }
  if (groundSignature(deps, direct) !== markerSignature) {
    throw new Error('Exact-ID Ground differs from native component inventory');
  }

  const pin = await readVerifiedEmbeddedGroundPin(deps, marker, direct, pinReader);
  const attributeEntries = readVerifiedGroundAttributes(deps, attributes, sheet.id, pin.id);
  return {
    canonical: JSON.stringify([
      sheet.id,
      deps.markerId,
      markerSignature,
      pin.id,
      pin.signature,
      attributeEntries,
    ]),
    count: attributeEntries.length,
  };
}

/**
 * Recognizes only one completely isolated native V4 Ground marker. Unknown
 * labels, components, unowned attributes, pins, wires, stale inventories or
 * missing APIs are NOT proof of disconnection. This read-only preflight is
 * intentionally not an authorization to enable production netflag deletion.
 */
export async function inspectIsolatedNativeGround(
  deps: GroundIsolationDependencies,
): Promise<NativeGroundIsolationEvidence | undefined> {
  try {
    if (!deps.markerId) return undefined;
    const first = await capture(deps);
    await (deps.settle?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 80)));
    const second = await capture(deps);
    if (first.canonical !== second.canonical) return undefined;
    return {
      kind: 'verified-disconnected-ground/v1',
      markerId: deps.markerId,
      componentCount: 2,
      wireCount: 0,
      pagePinCount: 0,
      embeddedPinCount: 1,
      attributeCount: second.count,
    };
  } catch {
    return undefined;
  }
}
