import type { PcbReadOperationDependencies } from './pcb-read-operations.js';

const missing = (reason: string) => ({ evidence: 'unavailable', reason });
const token = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && v.trim() === v;

function reportedConnections(
  raw: unknown,
  net: unknown,
  state: PcbReadOperationDependencies['readState'],
) {
  if (!Array.isArray(raw) || raw.length > 128) return undefined;
  const items = raw.map((p) => ({
    primitiveId: state(p, 'PrimitiveId'),
    nativeType: state(p, 'PrimitiveType'),
    net: state(p, 'Net'),
    layer: state(p, 'Layer'),
  }));
  if (
    items.some(
      (p) =>
        !token(p.primitiveId) ||
        p.net !== net ||
        !(
          typeof p.nativeType === 'string' ||
          (typeof p.nativeType === 'number' && Number.isFinite(p.nativeType))
        ) ||
        (p.layer !== undefined && (typeof p.layer !== 'number' || !Number.isSafeInteger(p.layer))),
    ) ||
    new Set(items.map((p) => p.primitiveId)).size !== items.length
  )
    return undefined;
  return items;
}

/** Project/focused-PCB scope is enforced by readProjectScoped before/after. */
export function createComponentPadConnectionReader({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies) {
  return async (componentPrimitiveId: string, padNumber: string): Promise<unknown> => {
    await requireActivePcbContext();
    if (!token(componentPrimitiveId) || !token(padNumber))
      throw new Error('Native component/pad identity is required and bounded');
    const native = readFirstPath<any>(['PCB_PrimitiveComponent', 'pcb_PrimitiveComponent']);
    if (typeof native?.getAllPinsByPrimitiveId !== 'function')
      return missing('native-component-pad-getter-unavailable');
    const pads: unknown = await native.getAllPinsByPrimitiveId(componentPrimitiveId);
    if (!Array.isArray(pads) || pads.length < 1 || pads.length > 128)
      return missing('component-pad-inventory-unverified');
    const matches = pads.filter(
      (p) =>
        readState(p, 'PadNumber') === padNumber &&
        readState(p, 'ParentComponentPrimitiveId') === componentPrimitiveId,
    );
    if (matches.length !== 1) return missing('component-pad-identity-unverified');
    const pad = matches[0];
    const padPrimitiveId = readState(pad, 'PrimitiveId');
    const net = readState(pad, 'Net');
    if (!token(padPrimitiveId) || !token(net) || typeof pad?.getConnectedPrimitives !== 'function')
      return missing('native-pad-net-or-connection-getter-unavailable');
    const connected = reportedConnections(await pad.getConnectedPrimitives(false), net, readState);
    if (!connected) return missing('native-connected-primitives-unverified');
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
