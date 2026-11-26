import type { PcbReadOperationDependencies, PrimitiveStateReader } from './pcb-read-operations.js';

const MAX_LINES = 1200;
const MAX_VIAS = 600;
const MAX_ADJACENT_LINES = 16;
const MAX_RECIPROCAL_NEIGHBORS = 128;
const missing = (reason: string) => ({
  evidence: 'unavailable',
  reason,
  electricalContinuity: 'UNKNOWN',
});
const token = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && v.trim() === v;

interface NativePrimitive {
  getAdjacentPrimitives?: () => Promise<unknown>;
}

type NativeInventory = { getAll?: () => Promise<unknown> };

function indexInventory(raw: unknown, limit: number, state: PrimitiveStateReader) {
  if (!Array.isArray(raw) || raw.length > limit) return undefined;
  const index = new Map<string, NativePrimitive>();
  for (const item of raw) {
    const id = state(item, 'PrimitiveId');
    if (!item || typeof item !== 'object' || !token(id) || index.has(id)) return undefined;
    index.set(id, item as NativePrimitive);
  }
  return index;
}

async function neighbors(primitive: NativePrimitive, limit: number, state: PrimitiveStateReader) {
  if (typeof primitive.getAdjacentPrimitives !== 'function') return undefined;
  return indexInventory(await primitive.getAdjacentPrimitives(), limit, state);
}

function copperLayer(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (value === 1 || value === 2 || (value >= 15 && value <= 44))
  );
}

async function reciprocalLine(
  id: string,
  reported: NativePrimitive,
  line: NativePrimitive | undefined,
  viaId: string,
  net: string,
  state: PrimitiveStateReader,
) {
  if (!line || state(line, 'Net') !== net || state(reported, 'Net') !== net) return undefined;
  const layer = state(line, 'Layer');
  if (!copperLayer(layer) || state(reported, 'Layer') !== layer) return undefined;
  const reverse = await neighbors(line, MAX_RECIPROCAL_NEIGHBORS, state);
  const via = reverse?.get(viaId);
  if (!via || state(via, 'Net') !== net) return undefined;
  return { primitiveId: id, layer };
}

async function collectViaAssociations(
  viaId: string,
  expectedNet: string,
  viaIndex: Map<string, NativePrimitive> | undefined,
  lineIndex: Map<string, NativePrimitive> | undefined,
  state: PrimitiveStateReader,
) {
  const via = viaIndex?.get(viaId);
  if (!via || !lineIndex || lineIndex.has(viaId) || state(via, 'Net') !== expectedNet)
    return missing('native-via-or-line-inventory-unverified');
  const adjacent = await neighbors(via, MAX_ADJACENT_LINES, state);
  if (!adjacent) return missing('native-adjacency-unverified');
  const result = [];
  for (const [id, reported] of adjacent) {
    if (viaIndex?.has(id)) return missing('native-primitive-identity-ambiguous');
    const line = await reciprocalLine(id, reported, lineIndex.get(id), viaId, expectedNet, state);
    if (!line) return missing('native-reciprocal-line-association-unverified');
    result.push(line);
  }
  return {
    evidence: 'native_reciprocal_line_associations',
    viaPrimitiveId: viaId,
    net: expectedNet,
    lines: result.sort((a, b) => a.primitiveId.localeCompare(b.primitiveId)),
    electricalContinuity: 'UNKNOWN',
  };
}

/** A bounded beta native association observation, never an electrical connectivity test.
 * The dispatcher applies readProjectScoped before and after the entire observation. */
export function createViaLineAdjacencyReader({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies) {
  return async (viaId: string, expectedNet: string): Promise<unknown> => {
    await requireActivePcbContext();
    if (!token(viaId) || !token(expectedNet)) return missing('invalid-via-or-net-identity');
    const vias = readFirstPath<NativeInventory>(['PCB_PrimitiveVia', 'pcb_PrimitiveVia']);
    const lines = readFirstPath<NativeInventory>(['PCB_PrimitiveLine', 'pcb_PrimitiveLine']);
    if (typeof vias?.getAll !== 'function' || typeof lines?.getAll !== 'function')
      return missing('native-inventory-unavailable');
    try {
      const viaIndex = indexInventory(await vias.getAll(), MAX_VIAS, readState);
      const lineIndex = indexInventory(await lines.getAll(), MAX_LINES, readState);
      return await collectViaAssociations(viaId, expectedNet, viaIndex, lineIndex, readState);
    } catch {
      return missing('native-adjacency-read-failed');
    }
  };
}
