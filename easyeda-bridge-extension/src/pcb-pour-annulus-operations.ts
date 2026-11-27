import type { PcbReadOperationDependencies } from './pcb-read-operations.js';

const MAX_POURS = 256;
const MAX_COMPONENTS = 1200;
const MAX_PINS = 128;
const MAX_PADS = 8;
const MAX_TOKENS = 8193;
const unavailable = (reason: string) => ({
  evidence: 'unavailable',
  reason,
  electricalContinuity: 'UNKNOWN',
});

type NativeObject = Record<string, unknown>;
interface SelectedPad {
  componentPrimitiveId: string;
  designator: string;
  padNumber: string;
  primitiveId: string;
}
interface PourIdentity {
  pourPrimitiveId: string;
  expectedNet: string;
  expectedLayer: number;
}
interface Declaration extends PourIdentity {
  pads: SelectedPad[];
}

function record(value: unknown): NativeObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as NativeObject) : {};
}

function token(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
  );
}

function selectedPad(value: unknown): SelectedPad | undefined {
  const p = record(value);
  if (
    !token(p.componentPrimitiveId) ||
    !token(p.designator) ||
    !token(p.padNumber) ||
    !token(p.primitiveId)
  )
    return;
  return {
    componentPrimitiveId: p.componentPrimitiveId,
    designator: p.designator,
    padNumber: p.padNumber,
    primitiveId: p.primitiveId,
  };
}

function declaration(value: unknown): Declaration | undefined {
  const d = record(value);
  if (
    !token(d.pourPrimitiveId) ||
    !token(d.expectedNet) ||
    (d.expectedLayer !== 1 && d.expectedLayer !== 2) ||
    !Array.isArray(d.pads) ||
    d.pads.length < 1 ||
    d.pads.length > MAX_PADS
  )
    return;
  const pads = d.pads.map(selectedPad);
  if (pads.some((p) => !p)) return;
  const valid = pads.filter((p): p is SelectedPad => p !== undefined);
  if (
    new Set(valid.map((p) => p.primitiveId)).size !== valid.length ||
    new Set(valid.map((p) => JSON.stringify([p.componentPrimitiveId, p.padNumber]))).size !==
      valid.length
  )
    return;
  return {
    pourPrimitiveId: d.pourPrimitiveId,
    expectedNet: d.expectedNet,
    expectedLayer: d.expectedLayer,
    pads: valid,
  };
}

/** Direct native getters only; normalization can turn missing metadata into null. */
async function invoke(value: unknown, method: string, ...args: unknown[]): Promise<unknown> {
  const member = record(value)[method];
  if (typeof member !== 'function') throw new Error('Required native getter unavailable');
  return member.call(value, ...args);
}

const state = (value: unknown, key: string) => invoke(value, 'getState_' + key);

async function index(raw: unknown, limit: number, key = 'PrimitiveId') {
  if (!Array.isArray(raw) || raw.length > limit) return;
  const result = new Map<string, unknown>();
  for (const item of raw) {
    const id = await state(item, key);
    if (!token(id) || result.has(id)) return;
    result.set(id, item);
  }
  return result;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function lineContour(raw: unknown, maxTokens = MAX_TOKENS): (string | number)[] | undefined {
  const ring = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (
    !Array.isArray(ring) ||
    ring.length < 9 ||
    ring.length > maxTokens ||
    ring.length % 2 !== 1 ||
    ring[2] !== 'L'
  )
    return;
  if (!ring.every((v, i) => (i === 2 ? v === 'L' : finite(v)))) return;
  return ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1]
    ? [...ring]
    : undefined;
}

async function matchesPour(value: unknown, d: PourIdentity) {
  return (
    (await state(value, 'PrimitiveId')) === d.pourPrimitiveId &&
    (await state(value, 'PourPrimitiveId')) === d.pourPrimitiveId &&
    (await state(value, 'Layer')) === d.expectedLayer
  );
}
async function linkedFill(value: unknown, d: Declaration) {
  if (!(await matchesPour(value, d))) return;
  const fills = await state(value, 'PourFills');
  if (!Array.isArray(fills) || fills.length !== 1) return;
  const f = record(fills[0]);
  if (!token(f.id) || f.fill !== true || f.lineWidth !== 0) return;
  const ring = lineContour(await invoke(f.path, 'getSource'));
  if (!ring) return;
  return { id: f.id, fill: true, lineWidth: 0, path: { complexPolygon: [ring] } };
}

async function sourceLinkedPair(pours: unknown, poured: unknown, d: PourIdentity) {
  const source = (await index(await invoke(pours, 'getAll'), MAX_POURS))?.get(d.pourPrimitiveId);
  if (
    !source ||
    (await state(source, 'Net')) !== d.expectedNet ||
    (await state(source, 'Layer')) !== d.expectedLayer
  )
    return;
  const derived = await invoke(poured, 'getAll');
  const byId = await index(derived, MAX_POURS);
  const bySource = await index(derived, MAX_POURS, 'PourPrimitiveId');
  const expected = byId?.get(d.pourPrimitiveId);
  if (!expected || bySource?.get(d.pourPrimitiveId) !== expected) return;
  return { source, expected };
}

async function readFill(pours: unknown, poured: unknown, d: Declaration) {
  const pair = await sourceLinkedPair(pours, poured, d);
  if (!pair) return;
  const a = await linkedFill(pair.expected, d);
  const b = await linkedFill(await invoke(pair.source, 'getCopperRegion'), d);
  return a && b && JSON.stringify(a) === JSON.stringify(b) ? a : undefined;
}

const geometryKeys = [
  'Net',
  'Layer',
  'X',
  'Y',
  'Pad',
  'Hole',
  'Metallization',
  'HeatWelding',
  'HoleOffsetX',
  'HoleOffsetY',
  'SpecialPad',
] as const;

function boundedRoundTuple(value: unknown, kind: string, min: number) {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= 3 &&
    value[0] === kind &&
    value.slice(1).every((v) => finite(v) && v > 0) &&
    (value.length === 2 || value[1] === value[2])
  );
}

function supportedGeometry(g: NativeObject, net: string): boolean {
  return (
    g.Net === net &&
    g.Layer === 12 &&
    finite(g.X) &&
    finite(g.Y) &&
    boundedRoundTuple(g.Pad, 'ELLIPSE', 3) &&
    boundedRoundTuple(g.Hole, 'ROUND', 2) &&
    g.Metallization === true &&
    g.HeatWelding === null &&
    g.HoleOffsetX === 0 &&
    g.HoleOffsetY === 0 &&
    (g.SpecialPad === null || (Array.isArray(g.SpecialPad) && g.SpecialPad.length === 0))
  );
}

async function readPadGeometry(pad: unknown, d: SelectedPad, net: string) {
  const g = Object.fromEntries(
    await Promise.all(geometryKeys.map(async (k) => [k, await state(pad, k)])),
  );
  if (!supportedGeometry(g, net)) return;
  return {
    ...d,
    net: g.Net,
    layer: g.Layer,
    x: g.X,
    y: g.Y,
    pad: g.Pad,
    hole: g.Hole,
    metallization: g.Metallization,
    heatWelding: g.HeatWelding,
    holeOffsetX: g.HoleOffsetX,
    holeOffsetY: g.HoleOffsetY,
    specialPad: g.SpecialPad,
  };
}

async function readPins(native: unknown, componentId: string) {
  const pins = await index(await invoke(native, 'getAllPinsByPrimitiveId', componentId), MAX_PINS);
  if (!pins) return;
  const rows = [];
  for (const [id, pad] of pins) {
    const owner = await state(pad, 'ParentComponentPrimitiveId');
    const number = await state(pad, 'PadNumber');
    if (
      owner !== componentId ||
      typeof number !== 'string' ||
      number.length > 128 ||
      number.trim() !== number
    )
      return;
    rows.push({ id, pad, number });
  }
  return rows;
}

async function componentNames(native: unknown, d: Declaration) {
  const components = await index(await invoke(native, 'getAll'), MAX_COMPONENTS);
  if (!components || components.has(d.pourPrimitiveId)) return;
  const names = new Map<string, string>();
  for (const [id, c] of components) {
    const name = await state(c, 'Designator');
    if (!token(name) || names.has(name)) return;
    names.set(name, id);
  }
  if (d.pads.some((p) => components.has(p.primitiveId) || p.primitiveId === d.pourPrimitiveId))
    return;
  return names;
}

async function readPads(native: unknown, d: Declaration) {
  const names = await componentNames(native, d);
  if (!names) return;
  const cache = new Map<string, NonNullable<Awaited<ReturnType<typeof readPins>>>>();
  const seen = new Set<string>();
  const result = [];
  for (const p of d.pads) {
    if (names.get(p.designator) !== p.componentPrimitiveId) return;
    let pins = cache.get(p.componentPrimitiveId);
    if (!pins) {
      pins = await readPins(native, p.componentPrimitiveId);
      if (!pins || pins.some((row) => seen.has(row.id))) return;
      for (const row of pins) seen.add(row.id);
      cache.set(p.componentPrimitiveId, pins);
    }
    const matches = pins.filter((row) => row.number === p.padNumber);
    if (matches.length !== 1 || matches[0]?.id !== p.primitiveId) return;
    const observed = await readPadGeometry(matches[0].pad, p, d.expectedNet);
    if (!observed) return;
    result.push(observed);
  }
  return result;
}

/** Focus/project checks wrap this reader in readProjectScoped. This is a
 * bounded native observation, not an atomic snapshot or connectivity test. */
export function createPourAnnulusGeometryReader(deps: PcbReadOperationDependencies) {
  const { requireActivePcbContext, readFirstPath } = deps;
  return async (raw: unknown): Promise<unknown> => {
    if (record(raw).kind === 'via') return viaContour(raw, deps);
    const d = declaration(raw);
    if (!d) return unavailable('invalid-annulus-declaration');
    await requireActivePcbContext();
    const pours = readFirstPath(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const poured = readFirstPath(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']);
    const components = readFirstPath(['PCB_PrimitiveComponent', 'pcb_PrimitiveComponent']);
    try {
      const fill = await readFill(pours, poured, d);
      if (!fill) return unavailable('source-linked-filled-region-unverified');
      const pads = await readPads(components, d);
      if (!pads) return unavailable('selected-round-pad-geometry-unverified');
      return {
        evidence: 'native_source_linked_filled_region',
        pourPrimitiveId: d.pourPrimitiveId,
        net: d.expectedNet,
        layer: d.expectedLayer,
        fill,
        pads,
        electricalContinuity: 'UNKNOWN',
      };
    } catch {
      return unavailable('native-annulus-read-failed');
    }
  };
}

type ViaDeclaration = PourIdentity & { fillId: string; viaPrimitiveId: string };

function viaDeclaration(raw: unknown): ViaDeclaration | undefined {
  const d = record(raw);
  if (
    d.kind !== 'via' ||
    'pads' in d ||
    !token(d.pourPrimitiveId) ||
    !token(d.expectedNet) ||
    !token(d.fillId) ||
    !token(d.viaPrimitiveId) ||
    d.viaPrimitiveId === d.pourPrimitiveId
  )
    return;
  const layer = d.expectedLayer;
  if (
    typeof layer !== 'number' ||
    !Number.isInteger(layer) ||
    !(layer === 1 || layer === 2 || (layer >= 15 && layer <= 44))
  )
    return;
  return {
    pourPrimitiveId: d.pourPrimitiveId,
    expectedNet: d.expectedNet,
    expectedLayer: layer,
    fillId: d.fillId,
    viaPrimitiveId: d.viaPrimitiveId,
  };
}

/** Discovery identities only: no claim that their geometry is supported. */
export function boundedFillRecordIds(fills: unknown[]): string[] | undefined {
  if (fills.length < 1 || fills.length > 32) return;
  const ids = fills.map((f) => record(f).id);
  if (!ids.every(token) || new Set(ids).size !== ids.length) return;
  return [...ids].sort();
}

async function selectedFill(value: unknown, d: ViaDeclaration) {
  if (!(await matchesPour(value, d))) return;
  const fills = await state(value, 'PourFills');
  if (!Array.isArray(fills)) return;
  const ids = boundedFillRecordIds(fills);
  if (!ids) return;
  const selected = record(fills.find((f) => record(f).id === d.fillId));
  if (selected.fill !== true || selected.lineWidth !== 0) return;
  const ring = lineContour(await invoke(selected.path, 'getSource'), 16385);
  if (!ring) return;
  return {
    availableFillIds: ids,
    fill: { id: d.fillId, fill: true, lineWidth: 0, path: { complexPolygon: [ring] } },
  };
}

async function selectedVia(native: unknown, d: ViaDeclaration) {
  const via = (await index(await invoke(native, 'getAll'), 600))?.get(d.viaPrimitiveId);
  if (!via || (await state(via, 'Net')) !== d.expectedNet || (await state(via, 'ViaType')) !== 0)
    return;
  const rule = await state(via, 'DesignRuleBlindViaName');
  if (rule !== '' && rule !== null) return;
  const x = await state(via, 'X'),
    y = await state(via, 'Y');
  const diameter = await state(via, 'Diameter'),
    holeDiameter = await state(via, 'HoleDiameter');
  if (
    !finite(x) ||
    !finite(y) ||
    !finite(diameter) ||
    !finite(holeDiameter) ||
    holeDiameter <= 0 ||
    diameter <= holeDiameter
  )
    return;
  return {
    primitiveId: d.viaPrimitiveId,
    net: d.expectedNet,
    x,
    y,
    diameter,
    holeDiameter,
    viaType: 0,
  };
}

async function viaContour(raw: unknown, deps: PcbReadOperationDependencies) {
  const d = viaDeclaration(raw);
  if (!d) return unavailable('invalid-via-contour-declaration');
  await deps.requireActivePcbContext();
  try {
    const pair = await sourceLinkedPair(
      deps.readFirstPath(['PCB_PrimitivePour', 'pcb_PrimitivePour']),
      deps.readFirstPath(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']),
      d,
    );
    if (!pair) return unavailable('source-linked-filled-region-unverified');
    const a = await selectedFill(pair.expected, d);
    const b = await selectedFill(await invoke(pair.source, 'getCopperRegion'), d);
    if (!a || !b || JSON.stringify(a) !== JSON.stringify(b))
      return unavailable('selected-contour-unverified');
    const via = await selectedVia(deps.readFirstPath(['PCB_PrimitiveVia', 'pcb_PrimitiveVia']), d);
    if (!via) return unavailable('selected-via-geometry-unverified');
    return {
      evidence: 'native_source_linked_via_contour',
      pourPrimitiveId: d.pourPrimitiveId,
      net: d.expectedNet,
      layer: d.expectedLayer,
      ...a,
      via,
      electricalContinuity: 'UNKNOWN',
    };
  } catch {
    return unavailable('native-via-contour-read-failed');
  }
}
