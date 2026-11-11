import type { ApiRuntime } from './api-runtime.js';
import { readNativeZoneInventory } from './pcb-mutation-operations.js';
import { createNativeZoneCandidateOperation } from './zone-create-operation.js';
import type { ExpectedZoneSource } from './zone-create-evidence.js';
import {
  documentIdentity,
  evaluateZoneOutlineEvidence,
  type ZoneRectangle,
} from './zone-outline-evidence.js';

type NativeReader = ApiRuntime['readFirstPath'];
type StateReader = (value: unknown, key: string) => unknown;

interface NativeZoneAdapterDependencies {
  readFirstPath: NativeReader;
  readState: StateReader;
}

type NativeFn = (...args: unknown[]) => unknown;

interface NativeZoneSurface {
  create?: NativeFn;
  get?: NativeFn;
  getAll?: NativeFn;
  getAllPrimitiveId?: NativeFn;
  delete?: NativeFn;
  getEditorCurrentVersion?: NativeFn;
  getAllNetName?: NativeFn;
  getTheNumberOfCopperLayers?: NativeFn;
  createPolygon?: NativeFn;
  save?: NativeFn;
  getState_PrimitiveId?: NativeFn;
  rebuildCopperRegion?: NativeFn;
}

/** Only explicitly named native members are called; no dynamic property indexing. */
async function nativeInvoke(
  target: unknown,
  member: unknown,
  ...args: unknown[]
): Promise<unknown> {
  if (typeof member !== 'function') throw new Error('Required native zone method is unavailable.');
  return (member as NativeFn).apply(target, args);
}

function nativeRectangleBounds(value: unknown[]): ZoneRectangle | undefined {
  const [, x, y, width, height] = value;
  if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v)))
    return undefined;
  const rectangle = {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
  };
  if (
    rectangle.width <= 0 ||
    rectangle.height <= 0 ||
    rectangle.x < -1_000_000 ||
    rectangle.y > 1_000_000 ||
    rectangle.x + rectangle.width > 1_000_000 ||
    rectangle.y - rectangle.height < -1_000_000
  )
    return undefined;
  return rectangle;
}

function exactNativeRectangle(
  signature: string,
): { source: unknown[]; rectangle: ZoneRectangle } | undefined {
  let source: unknown;
  try {
    source = JSON.parse(signature) as unknown;
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(source) ||
    source.length !== 7 ||
    source[0] !== 'R' ||
    source[5] !== 0 ||
    source[6] !== 0
  )
    return undefined;
  const rectangle = nativeRectangleBounds(source);
  return rectangle ? { source, rectangle } : undefined;
}

function hasNativeZoneCapabilities(readFirstPath: NativeReader): boolean {
  const source = readFirstPath<NativeZoneSurface>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
  const derived = readFirstPath<NativeZoneSurface>(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']);
  const polygon = readFirstPath<NativeZoneSurface>(['PCB_MathPolygon', 'pcb_MathPolygon']);
  const doc = readFirstPath<NativeZoneSurface>(['PCB_Document', 'pcb_Document']);
  return [
    source?.create,
    source?.get,
    source?.getAll,
    source?.delete,
    source?.getAllPrimitiveId,
    derived?.getAll,
    polygon?.createPolygon,
    doc?.save,
  ].every((member) => typeof member === 'function');
}

function measuredZoneRuntime(
  version: unknown,
  names: unknown,
  count: unknown,
  net: string,
): boolean {
  return (
    version === '3.2.209' &&
    Array.isArray(names) &&
    names.includes(net) &&
    typeof count === 'number' &&
    Number.isInteger(count) &&
    count >= 2
  );
}

/**
 * Bridge-native adapter for the isolated candidate engine, NOT a public
 * dispatcher route. The candidate remains inaccessible from pcb.addZone
 * until end-to-end remote authorization, topology/DRC, durable recovery
 * and public MCP apply acceptance are separately verified.
 */
export function createNativeZoneApiAdapter({
  readFirstPath,
  readState,
}: NativeZoneAdapterDependencies) {
  const focus = () => documentIdentity(readFirstPath);

  async function preflight(expected: ExpectedZoneSource): Promise<boolean> {
    const parsed = exactNativeRectangle(expected.polygonSignature);
    const initialFocus = await focus();
    if (!parsed || !initialFocus || !expected.pourName || expected.pourName.length > 128)
      return false;
    if (!hasNativeZoneCapabilities(readFirstPath)) return false;
    const env = readFirstPath<NativeZoneSurface>(['SYS_Environment', 'sys_Environment']);
    const nets = readFirstPath<NativeZoneSurface>(['PCB_Net', 'pcb_Net']);
    const layers = readFirstPath<NativeZoneSurface>(['PCB_Layer', 'pcb_Layer']);
    try {
      // Only the 3.2.209 disposable PCB's exact settings have been verified.
      // No beta capability inference from neighboring EasyEDA versions.
      const [version, names, count] = await Promise.all([
        nativeInvoke(env, env?.getEditorCurrentVersion),
        nativeInvoke(nets, nets?.getAllNetName),
        nativeInvoke(layers, layers?.getTheNumberOfCopperLayers),
      ]);
      if (!measuredZoneRuntime(version, names, count, expected.net)) return false;
      const outline = await evaluateZoneOutlineEvidence(parsed.rectangle, readFirstPath, readState);
      return (
        outline.containmentVerified === true &&
        outline.intersection === 'inside' &&
        (await focus()) === initialFocus
      );
    } catch {
      return false;
    }
  }

  async function create(expected: ExpectedZoneSource): Promise<unknown> {
    const parsed = exactNativeRectangle(expected.polygonSignature);
    if (!parsed) throw new Error('Invalid native rectangle; no Pour was created.');
    const polygon = readFirstPath<NativeZoneSurface>(['PCB_MathPolygon', 'pcb_MathPolygon']);
    const pour = readFirstPath<NativeZoneSurface>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const nativePolygon = await nativeInvoke(polygon, polygon?.createPolygon, parsed.source);
    if (!nativePolygon) throw new Error('Native polygon builder returned no polygon.');
    return nativeInvoke(
      pour,
      pour?.create,
      expected.net,
      expected.layer,
      nativePolygon,
      expected.fillMethod,
      expected.preserveSilos,
      expected.pourName,
      expected.pourPriority,
      expected.lineWidth,
      expected.locked,
    );
  }

  async function rebuild(sourceId: string): Promise<unknown> {
    const pour = readFirstPath<NativeZoneSurface>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const primitive = (await nativeInvoke(pour, pour?.get, sourceId)) as
      NativeZoneSurface | undefined;
    if ((await nativeInvoke(primitive, primitive?.getState_PrimitiveId)) !== sourceId)
      throw new Error('New native Pour source lookup disagreed with its exact ID.');
    return nativeInvoke(primitive, primitive?.rebuildCopperRegion);
  }

  async function save(): Promise<boolean> {
    const doc = readFirstPath<NativeZoneSurface>(['PCB_Document', 'pcb_Document']);
    return (await nativeInvoke(doc, doc?.save)) === true;
  }

  async function deleteSource(sourceId: string): Promise<boolean> {
    if (typeof sourceId !== 'string' || sourceId.length === 0) return false;
    const pour = readFirstPath<NativeZoneSurface>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const ids = await nativeInvoke(pour, pour?.getAllPrimitiveId);
    if (!Array.isArray(ids) || ids.filter((id) => id === sourceId).length !== 1) return false;
    return (await nativeInvoke(pour, pour?.delete, [sourceId])) === true;
  }

  return createNativeZoneCandidateOperation({
    focus,
    preflight,
    readInventory: () => readNativeZoneInventory(readFirstPath),
    create,
    rebuild,
    save,
    deleteSource,
  });
}
