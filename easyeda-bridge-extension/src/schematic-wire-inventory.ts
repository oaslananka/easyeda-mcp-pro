/** Native GUI events in EasyEDA Pro 3.2 are beta and not an authoritative
 * change feed. Confirm wire inventories using two supported read APIs before
 * allowing component movement. This reduces stale-read risk, but cannot prove
 * absence of edits that are invisible to BOTH APIs for the full sample window.
 */
interface WireInventoryDependencies {
  wireApi: { getAll?: () => Promise<unknown>; getAllPrimitiveId?: () => Promise<unknown> };
  firstWires: unknown[];
  extractPrimitiveId: (wire: unknown) => string;
  readState: (wire: unknown, key: string) => unknown;
  settle?: () => Promise<void>;
}

function snapshotInventory(
  wires: unknown,
  ids: unknown,
  extractId: WireInventoryDependencies['extractPrimitiveId'],
  readState: WireInventoryDependencies['readState'],
): { wires: unknown[]; fingerprint: string } {
  if (!Array.isArray(wires) || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new Error('Native wire inventory incomplete');
  }
  const unique = new Set(ids as string[]);
  if (unique.size !== ids.length) throw new Error('Native wire inventory has duplicate IDs');
  const entries = wires.map((wire) => {
    const id = extractId(wire);
    const line = readState(wire, 'Line');
    if (!id) throw new Error('Native wire inventory has missing primitive ID');
    if (!Array.isArray(line) || line.length < 2) {
      throw new Error('Native wire geometry unavailable');
    }
    return { id, line, net: readState(wire, 'Net') };
  });
  if (
    entries.length !== ids.length ||
    new Set(entries.map((item) => item.id)).size !== entries.length ||
    entries.some((item) => !unique.has(item.id))
  ) {
    throw new Error('Native wire inventory mismatch between collection and exact IDs');
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { wires, fingerprint: JSON.stringify(entries) };
}

export async function verifyWireInventoryReadback({
  wireApi,
  firstWires,
  extractPrimitiveId,
  readState,
  settle = () => new Promise<void>((resolve) => setTimeout(resolve, 80)),
}: WireInventoryDependencies): Promise<unknown[]> {
  if (typeof wireApi?.getAll !== 'function' || typeof wireApi.getAllPrimitiveId !== 'function') {
    throw new Error('Native wire inventory readback API unavailable');
  }
  // First confirm the collection against the independently addressable IDs.
  const firstIds = await wireApi.getAllPrimitiveId();
  const first = snapshotInventory(firstWires, firstIds, extractPrimitiveId, readState);
  await settle();
  const secondWires = await wireApi.getAll();
  const secondIds = await wireApi.getAllPrimitiveId();
  const second = snapshotInventory(secondWires, secondIds, extractPrimitiveId, readState);
  if (first.fingerprint !== second.fingerprint) {
    throw new Error('Native wire inventory changed during move preflight');
  }
  return second.wires;
}
