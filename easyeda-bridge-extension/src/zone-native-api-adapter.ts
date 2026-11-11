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

function nativeMethod(
  target: unknown,
  method: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const value = (target as Record<string, unknown>)[method];
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : undefined;
}

async function nativeInvoke(target: unknown, method: string, ...args: unknown[]): Promise<unknown> {
  const fn = nativeMethod(target, method);
  if (!fn) throw new Error('Required native zone method is unavailable: ' + method);
  return fn.apply(target, args);
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
  const source = readFirstPath<unknown>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
  const derived = readFirstPath<unknown>(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']);
  const polygon = readFirstPath<unknown>(['PCB_MathPolygon', 'pcb_MathPolygon']);
  const doc = readFirstPath<unknown>(['PCB_Document', 'pcb_Document']);
  return (
    ['create', 'get', 'getAll', 'delete', 'getAllPrimitiveId'].every((m) =>
      nativeMethod(source, m),
    ) &&
    Boolean(nativeMethod(derived, 'getAll')) &&
    Boolean(nativeMethod(polygon, 'createPolygon')) &&
    Boolean(nativeMethod(doc, 'save'))
  );
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
    const env = readFirstPath<unknown>(['SYS_Environment', 'sys_Environment']);
    const nets = readFirstPath<unknown>(['PCB_Net', 'pcb_Net']);
    const layers = readFirstPath<unknown>(['PCB_Layer', 'pcb_Layer']);
    try {
      // Only the 3.2.209 disposable PCB's exact settings have been verified.
      // No beta capability inference from neighboring EasyEDA versions.
      const [version, names, count] = await Promise.all([
        nativeInvoke(env, 'getEditorCurrentVersion'),
        nativeInvoke(nets, 'getAllNetName'),
        nativeInvoke(layers, 'getTheNumberOfCopperLayers'),
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
    const polygon = readFirstPath<unknown>(['PCB_MathPolygon', 'pcb_MathPolygon']);
    const pour = readFirstPath<unknown>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const nativePolygon = await nativeInvoke(polygon, 'createPolygon', parsed.source);
    if (!nativePolygon) throw new Error('Native polygon builder returned no polygon.');
    return nativeInvoke(
      pour,
      'create',
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
    const pour = readFirstPath<unknown>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const primitive = await nativeInvoke(pour, 'get', sourceId);
    if ((await nativeInvoke(primitive, 'getState_PrimitiveId')) !== sourceId)
      throw new Error('New native Pour source lookup disagreed with its exact ID.');
    return nativeInvoke(primitive, 'rebuildCopperRegion');
  }

  async function save(): Promise<boolean> {
    const doc = readFirstPath<unknown>(['PCB_Document', 'pcb_Document']);
    return (await nativeInvoke(doc, 'save')) === true;
  }

  async function deleteSource(sourceId: string): Promise<boolean> {
    if (typeof sourceId !== 'string' || sourceId.length === 0) return false;
    const pour = readFirstPath<unknown>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const ids = await nativeInvoke(pour, 'getAllPrimitiveId');
    if (!Array.isArray(ids) || ids.filter((id) => id === sourceId).length !== 1) return false;
    return (await nativeInvoke(pour, 'delete', [sourceId])) === true;
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
