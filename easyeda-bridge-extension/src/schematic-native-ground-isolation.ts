import {
  verifiedNativeGroundDescriptor,
  type PrivateGroundProfile,
} from './schematic-native-ground-identity.js';
import { isRecord } from './utils.js';
import {
  fingerprintGroundAttributes,
  matchesDefaultGroundAttributes,
  readGroundAttributeState,
  type GroundAttributeState,
} from './schematic-native-ground-attributes.js';

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
  kind: 'verified-disconnected-ground/v2';
  markerId: string;
  componentCount: 1 | 2;
  wireCount: 0;
  pagePinCount: 0;
  embeddedPinCount: 1;
  attributeCount: number;
  attributeFingerprint: string;
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
    'attributeFingerprint',
  ];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function matchesIsolationTopology(
  input: Record<string, unknown>,
  profile?: PrivateGroundProfile,
): boolean {
  return (
    input.componentCount === (profile?.sheetCount === 0 ? 1 : 2) &&
    input.wireCount === 0 &&
    input.pagePinCount === 0 &&
    input.embeddedPinCount === 1 &&
    isBoundedAttributeCount(input.attributeCount)
  );
}

/** Parse a caller-visible snapshot descriptor by exact shape.
 * This is a consistency check, NOT independent native evidence or a write grant.
 */
export function parseNativeGroundIsolation(
  input: unknown,
  primitiveId: string,
  invalid: (message: string) => Error,
  profile?: PrivateGroundProfile,
): NativeGroundIsolationEvidence | undefined {
  if (input === undefined) return undefined;
  if (
    !isRecord(input) ||
    !hasExactIsolationKeys(input) ||
    input.kind !== 'verified-disconnected-ground/v2' ||
    typeof primitiveId !== 'string' ||
    !primitiveId ||
    input.markerId !== primitiveId ||
    !matchesIsolationTopology(input, profile) ||
    typeof input.attributeFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.attributeFingerprint)
  ) {
    throw invalid('Invalid native Ground isolation descriptor');
  }
  return {
    kind: 'verified-disconnected-ground/v2',
    markerId: primitiveId,
    componentCount: profile?.sheetCount === 0 ? 1 : 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: Number(input.attributeCount),
    attributeFingerprint: input.attributeFingerprint,
  };
}

interface GroundIsolationDependencies {
  markerId: string;
  readFirstPath(paths: string[]): unknown;
  readState(primitive: unknown, key: string): unknown;
  extractPrimitiveId(primitive: unknown): string;
  settle?(): Promise<void>;
  privateGroundProfile?: PrivateGroundProfile;
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
    ((kind === 'Component' || kind === 'Pin' || kind === 'Attribute') &&
      typeof reader.get !== 'function')
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
    !verifiedNativeGroundDescriptor(
      get('Component'),
      '4.1.105',
      get('Net'),
      deps.privateGroundProfile,
    ) ||
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

function attributeRole(
  owner: unknown,
  sheetId: string,
  markerId: string,
  pinId: string,
): 'sheet' | 'marker' | 'pin' | undefined {
  if (sheetId && owner === sheetId) return 'sheet';
  if (owner === markerId) return 'marker';
  if (owner === pinId) return 'pin';
  return undefined;
}

async function readVerifiedGroundAttributes(
  deps: GroundIsolationDependencies,
  reader: NativeReader,
  attributes: NativeInventory,
  sheetId: string,
  pinId: string,
): Promise<{ exact: unknown[][]; states: GroundAttributeState[] }> {
  const allowedPinKeys = new Map([
    ['Pin Name', 'Pin1'],
    ['Pin Number', '1'],
    ['Pin Type', 'IN'],
  ]);
  const seen = new Set<string>();
  const exact: unknown[][] = [];
  const states: GroundAttributeState[] = [];
  for (const { id, primitive } of attributes.items) {
    const owner = deps.readState(primitive, 'ParentPrimitiveId');
    const role = attributeRole(owner, sheetId, deps.markerId, pinId);
    if (!role) throw new Error('Attribute ownership not safely readable');
    const state = readGroundAttributeState(deps.readState, primitive, role);
    if (role === 'pin') {
      if (seen.has(state.key) || allowedPinKeys.get(state.key) !== state.value) {
        throw new Error('Ground embedded pin attributes do not match native pin');
      }
      seen.add(state.key);
    }
    const direct = await reader.get?.(id);
    if (
      !direct ||
      deps.extractPrimitiveId(direct) !== id ||
      deps.readState(direct, 'ParentPrimitiveId') !== owner ||
      JSON.stringify(readGroundAttributeState(deps.readState, direct, role)) !==
        JSON.stringify(state)
    ) {
      throw new Error('Native exact-ID attribute read differs from inventory');
    }
    exact.push([id, owner, state]);
    states.push(state);
  }
  if (seen.size !== allowedPinKeys.size) {
    throw new Error('Native Ground embedded pin attributes incomplete');
  }
  return { exact, states };
}

function isolatedComponentScope(
  deps: GroundIsolationDependencies,
  wires: NativeInventory,
  pins: NativeInventory,
  components: NativeInventory,
) {
  if (
    wires.items.length !== 0 ||
    pins.items.length !== 0 ||
    components.items.length !== (deps.privateGroundProfile?.sheetCount === 0 ? 1 : 2)
  ) {
    throw new Error('Page has wires, pins, or other components');
  }
  const marker = components.byId.get(deps.markerId)?.primitive;
  const sheet = components.items.find(
    ({ id, primitive }) =>
      id !== deps.markerId && deps.readState(primitive, 'ComponentType') === 'sheet',
  );
  if (!marker || (deps.privateGroundProfile?.sheetCount !== 0 && !sheet))
    throw new Error('Target marker or unique sheet missing');
  const sheetId = sheet?.id ?? '';

  return { marker, sheetId };
}

async function capture(deps: GroundIsolationDependencies): Promise<{
  canonical: string;
  count: number;
  sheetId: string;
  states: GroundAttributeState[];
  markerX: unknown;
  markerY: unknown;
}> {
  const wireReader = requiredReader(deps, 'Wire');
  const pinReader = requiredReader(deps, 'Pin');
  const componentReader = requiredReader(deps, 'Component');
  const attributeReader = requiredReader(deps, 'Attribute');

  const wires = await readInventory(deps, wireReader, 'Wire');
  const pins = await readInventory(deps, pinReader, 'Pin');
  const components = await readInventory(deps, componentReader, 'Component');
  const attributes = await readInventory(deps, attributeReader, 'Attribute');

  const { marker, sheetId } = isolatedComponentScope(deps, wires, pins, components);

  const markerSignature = groundSignature(deps, marker);
  const direct = await componentReader.get?.(deps.markerId);
  if (!direct || deps.extractPrimitiveId(direct) !== deps.markerId) {
    throw new Error('Exact-ID native Ground read unavailable');
  }
  if (groundSignature(deps, direct) !== markerSignature) {
    throw new Error('Exact-ID Ground differs from native component inventory');
  }

  const pin = await readVerifiedEmbeddedGroundPin(deps, marker, direct, pinReader);
  const attributeEntries = await readVerifiedGroundAttributes(
    deps,
    attributeReader,
    attributes,
    sheetId,
    pin.id,
  );
  return {
    canonical: JSON.stringify([
      sheetId,
      deps.markerId,
      markerSignature,
      pin.id,
      pin.signature,
      attributeEntries.exact,
    ]),
    count: attributeEntries.exact.length,
    sheetId,
    states: attributeEntries.states,
    markerX: deps.readState(marker, 'X'),
    markerY: deps.readState(marker, 'Y'),
  };
}

/**
 * Recognizes only one completely isolated native V4 Ground marker. Unknown
 * labels, components, unowned attributes, pins, wires, stale inventories or
 * missing APIs are NOT proof of disconnection. This read-only preflight is
 * intentionally not an authorization to enable production netflag deletion.
 */
async function inspectGround(
  deps: GroundIsolationDependencies,
  requireDefaultProfile: boolean,
): Promise<NativeGroundIsolationEvidence | undefined> {
  try {
    if (!deps.markerId) return undefined;
    const first = await capture(deps);
    await (deps.settle?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 80)));
    const second = await capture(deps);
    if (first.canonical !== second.canonical) return undefined;
    if (
      requireDefaultProfile &&
      !matchesDefaultGroundAttributes(
        second.states,
        second.markerX,
        second.markerY,
        deps.privateGroundProfile,
      )
    )
      return undefined;
    return {
      kind: 'verified-disconnected-ground/v2',
      markerId: deps.markerId,
      componentCount: deps.privateGroundProfile?.sheetCount === 0 ? 1 : 2,
      wireCount: 0,
      pagePinCount: 0,
      embeddedPinCount: 1,
      attributeCount: second.count,
      attributeFingerprint: await fingerprintGroundAttributes(second.sheetId, second.states),
    };
  } catch {
    return undefined;
  }
}

/** Read-only isolation diagnostics, not evidence that custom attributes can be recreated. */
export function inspectIsolatedNativeGround(
  deps: GroundIsolationDependencies,
): Promise<NativeGroundIsolationEvidence | undefined> {
  return inspectGround(deps, false);
}

/** A typed marker snapshot may earn a witness only for the known default profile. */
export function inspectReconstructableNativeGround(
  deps: GroundIsolationDependencies,
): Promise<NativeGroundIsolationEvidence | undefined> {
  return inspectGround(deps, true);
}
