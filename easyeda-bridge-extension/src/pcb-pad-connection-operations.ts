import type { PcbReadOperationDependencies, PrimitiveStateReader } from './pcb-read-operations.js';

const MAX_COMPONENTS = 200;
const MAX_PADS = 128;
const MAX_CONNECTED = 128;
const MAX_ID_LENGTH = 128;

type NativeReadClass = {
  getAll?: () => Promise<unknown>;
  getAllPinsByPrimitiveId?: (id: string) => Promise<unknown>;
};

type NativePad = Record<string, unknown>;
type ReadState = PrimitiveStateReader;

type NativeConnected = {
  primitiveId: string;
  nativeType: number | string;
  net: string;
  layer?: number;
};

function token(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value
  );
}

function unavailable(reason: string) {
  return { evidence: 'unavailable' as const, reason };
}

function nativeReadClass(
  readFirstPath: PcbReadOperationDependencies['readFirstPath'],
): NativeReadClass | undefined {
  return readFirstPath<NativeReadClass>(['PCB_PrimitiveComponent', 'pcb_PrimitiveComponent']);
}

async function uniqueNativePad(
  native: NativeReadClass,
  componentPrimitiveId: string,
  padNumber: string,
  readState: ReadState,
): Promise<NativePad | undefined> {
  const components: unknown = await native.getAll?.();
  if (!Array.isArray(components) || components.length > MAX_COMPONENTS) return undefined;
  const owners = components.filter(
    (item) => readState(item, 'PrimitiveId') === componentPrimitiveId,
  );
  if (owners.length !== 1) return undefined;
  const pads: unknown = await native.getAllPinsByPrimitiveId?.(componentPrimitiveId);
  if (!Array.isArray(pads) || pads.length === 0 || pads.length > MAX_PADS) return undefined;
  const matched = pads.filter((p) => readState(p, 'PadNumber') === padNumber);
  if (
    matched.length !== 1 ||
    readState(matched[0], 'ParentComponentPrimitiveId') !== componentPrimitiveId
  )
    return undefined;
  return matched[0] as NativePad;
}

function nativeConnected(
  item: unknown,
  net: string,
  readState: ReadState,
): NativeConnected | undefined {
  const primitiveId = readState(item, 'PrimitiveId');
  const nativeType = readState(item, 'PrimitiveType');
  const connectedNet = readState(item, 'Net');
  const layer = readState(item, 'Layer');
  if (
    !token(primitiveId) ||
    !token(connectedNet) ||
    connectedNet !== net ||
    !(typeof nativeType === 'string' || typeof nativeType === 'number') ||
    (layer !== undefined && (typeof layer !== 'number' || !Number.isSafeInteger(layer)))
  )
    return undefined;
  return {
    primitiveId,
    nativeType,
    net: connectedNet,
    ...(typeof layer === 'number' ? { layer } : {}),
  };
}

function serializeNativeConnections(
  raw: unknown,
  net: string,
  readState: ReadState,
): NativeConnected[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_CONNECTED) return undefined;
  const items = raw.map((item) => nativeConnected(item, net, readState));
  if (items.some((item) => item === undefined)) return undefined;
  const connected = items as NativeConnected[];
  return new Set(connected.map((p) => p.primitiveId)).size === connected.length
    ? connected
    : undefined;
}

/**
 * A beta native getConnectedPrimitives(false) association is NOT evidence of
 * actual copper/plane continuity, PCB DRC, plated hole span or current return.
 * The dispatch router also binds this call to the exact focused PCB project.
 */
export function createComponentPadConnectionReader({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies) {
  return async (componentPrimitiveId: string, padNumber: string): Promise<unknown> => {
    await requireActivePcbContext();
    if (!token(componentPrimitiveId) || !token(padNumber)) {
      throw new Error('Native component/pad identity is required and bounded');
    }
    const native = nativeReadClass(readFirstPath);
    if (!native?.getAll || !native.getAllPinsByPrimitiveId) {
      return unavailable('native-component-pad-getter-unavailable');
    }
    const pad = await uniqueNativePad(native, componentPrimitiveId, padNumber, readState);
    if (!pad) return unavailable('component-or-pad-inventory-unverified');
    const padPrimitiveId = readState(pad, 'PrimitiveId');
    const net = readState(pad, 'Net');
    if (!token(padPrimitiveId) || !token(net) || typeof pad.getConnectedPrimitives !== 'function') {
      return unavailable('native-pad-net-or-connection-getter-unavailable');
    }
    const getter = pad.getConnectedPrimitives as (centerOnly: boolean) => Promise<unknown>;
    const raw: unknown = await getter.call(pad, false);
    const connected = serializeNativeConnections(raw, net, readState);
    if (!connected) return unavailable('native-connected-primitives-unverified');
    return {
      evidence: 'native_reported',
      componentPrimitiveId,
      padPrimitiveId,
      padNumber,
      net,
      connected,
      interpretation: 'native-api-association-only; electrical-continuity-UNKNOWN',
    };
  };
}
