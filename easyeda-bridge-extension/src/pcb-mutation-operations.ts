import type { ApiRuntime } from './api-runtime.js';

export interface PcbMutationOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  readFirstPath: ApiRuntime['readFirstPath'];
  requireActivePcbContext(): Promise<unknown>;
  deletePrimitives(ids: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
}

const PCB_COMPONENT_TRANSFORM_FIELDS = new Set(['layer', 'x', 'y', 'rotation', 'primitiveLock']);

function validatedComponentTransformProperty(value: unknown): Record<string, number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PCB component transform property must be an object');
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, number | boolean> = {};
  for (const [key, fieldValue] of Object.entries(input)) {
    if (!PCB_COMPONENT_TRANSFORM_FIELDS.has(key)) {
      throw new TypeError(`Unsupported PCB component transform field: ${key}`);
    }
    if (key === 'primitiveLock') {
      if (typeof fieldValue !== 'boolean') {
        throw new TypeError('PCB component primitiveLock must be a boolean');
      }
      output[key] = fieldValue;
      continue;
    }
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
      throw new TypeError(`PCB component ${key} must be a finite number`);
    }
    if (key === 'layer' && fieldValue !== 1 && fieldValue !== 2) {
      throw new TypeError('PCB component layer must be 1 (top) or 2 (bottom)');
    }
    output[key] = fieldValue;
  }
  if (Object.keys(output).length === 0) {
    throw new TypeError('PCB component transform must change at least one supported field');
  }
  return output;
}

type NativeMethod = (...args: unknown[]) => unknown;
type CopperRebuildStatus =
  'rebuilt' | 'no-copper' | 'error' | 'readback-missing' | 'readback-mismatch';

interface CopperRebuildItem {
  pourId: string;
  pouredId: string | null;
  status: CopperRebuildStatus;
  verified: boolean;
  error?: string;
}

interface CopperRebuildResult {
  success: boolean;
  matchedCount: number;
  attemptedCount: number;
  rebuiltCount: number;
  noCopperCount: number;
  transactionCovered: false;
  planeZonesSupported: false;
  results: CopperRebuildItem[];
  error?: string;
}

function nativeMethod(target: unknown, name: string): NativeMethod | undefined {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const candidate = (target as Record<string, unknown>)[name];
  return typeof candidate === 'function' ? (candidate as NativeMethod) : undefined;
}

async function invokeNative(target: unknown, name: string, ...args: unknown[]): Promise<unknown> {
  const method = nativeMethod(target, name);
  if (!method) {
    throw new Error(`EasyEDA runtime does not expose ${name}().`);
  }
  return await method.apply(target, args);
}

function nativeStateString(target: unknown, getter: string): string | undefined {
  const method = nativeMethod(target, getter);
  if (!method) return undefined;
  const value = method.call(target);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function nativeStateNumber(target: unknown, getter: string): number | undefined {
  const method = nativeMethod(target, getter);
  if (!method) return undefined;
  const value = method.call(target);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nativeItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined);
  return value === null || value === undefined ? [] : [value];
}

function copperLayer(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !(value === 1 || value === 2 || (value >= 15 && value <= 44))
  ) {
    throw new TypeError(
      'PCB copper rebuild layer must be TOP=1, BOTTOM=2, or INNER_1..INNER_30=15..44.',
    );
  }
  return value;
}

function requestedPourIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((id) => typeof id !== 'string' || id.trim().length === 0)
  ) {
    throw new TypeError('PCB copper rebuild pourIds must be a non-empty array of primitive ids.');
  }
  const ids = value.map((id) => (id as string).trim());
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('PCB copper rebuild pourIds must not contain duplicates.');
  }
  return ids;
}

async function resolvePours(
  pourClass: unknown,
  params: Record<string, unknown>,
): Promise<Array<{ pourId: string; primitive: unknown }>> {
  const ids = requestedPourIds(params.pourIds);
  const net =
    params.net === undefined
      ? undefined
      : typeof params.net === 'string' && params.net.trim().length > 0
        ? params.net.trim()
        : (() => {
            throw new TypeError('PCB copper rebuild net must be a non-empty string.');
          })();
  const layer = copperLayer(params.layer);

  let pours: unknown[];
  if (ids) {
    const resolved: unknown[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const value = await invokeNative(pourClass, 'get', id);
      const candidates = nativeItems(value);
      const exact = candidates.find(
        (candidate) => nativeStateString(candidate, 'getState_PrimitiveId') === id,
      );
      const selected = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!selected) missing.push(id);
      else resolved.push(selected);
    }
    if (missing.length > 0) {
      throw new Error(
        `PCB pour primitive id(s) not found on the active PCB: ${missing.join(', ')}. No copper was rebuilt.`,
      );
    }
    pours = resolved;
  } else {
    const value = await invokeNative(pourClass, 'getAll', net, layer);
    pours = nativeItems(value);
  }

  const selected: Array<{ pourId: string; primitive: unknown }> = [];
  for (const primitive of pours) {
    const pourId = nativeStateString(primitive, 'getState_PrimitiveId');
    if (!pourId) {
      throw new Error(
        'EasyEDA PCB_PrimitivePour returned an item without getState_PrimitiveId(). No copper was rebuilt.',
      );
    }
    if (net !== undefined) {
      const actualNet = nativeStateString(primitive, 'getState_Net');
      if (actualNet === undefined) {
        throw new Error(
          `PCB pour ${pourId} does not expose getState_Net(); the requested net filter cannot be verified. No copper was rebuilt.`,
        );
      }
      if (actualNet !== net) continue;
    }
    if (layer !== undefined) {
      const actualLayer = nativeStateNumber(primitive, 'getState_Layer');
      if (actualLayer === undefined) {
        throw new Error(
          `PCB pour ${pourId} does not expose getState_Layer(); the requested layer filter cannot be verified. No copper was rebuilt.`,
        );
      }
      if (actualLayer !== layer) continue;
    }
    if (!nativeMethod(primitive, 'rebuildCopperRegion')) {
      throw new Error(
        `PCB pour ${pourId} does not expose rebuildCopperRegion(); no copper was rebuilt.`,
      );
    }
    selected.push({ pourId, primitive });
  }

  if (selected.length === 0) {
    throw new Error('No existing PCB pours matched the requested filters. No copper was rebuilt.');
  }
  if (new Set(selected.map((item) => item.pourId)).size !== selected.length) {
    throw new Error('EasyEDA returned duplicate PCB pour primitive ids. No copper was rebuilt.');
  }
  return selected;
}

function pouredReadbackMap(items: unknown[]): Map<string, string[]> {
  const byPourId = new Map<string, string[]>();
  for (const item of items) {
    const pourId = nativeStateString(item, 'getState_PourPrimitiveId');
    const pouredId = nativeStateString(item, 'getState_PrimitiveId');
    if (!pourId || !pouredId) continue;
    const current = byPourId.get(pourId) ?? [];
    current.push(pouredId);
    byPourId.set(pourId, current);
  }
  return byPourId;
}

export interface PcbMutationOperations {
  addZone(params: Record<string, unknown>): Promise<unknown>;
  rebuildCopper(params: Record<string, unknown>): Promise<CopperRebuildResult>;
  modifyComponent(params: Record<string, unknown>): Promise<unknown>;
  deleteComponents(params: Record<string, unknown>): Promise<{
    success: boolean;
    deletedCount: number;
    deleted: string[];
    notFound: string[];
  }>;
}

async function rejectUnverifiedZoneCreation(_params: Record<string, unknown>): Promise<unknown> {
  throw new Error(
    'PCB copper-zone creation is unavailable until the complete native contract is verified.',
  );
}

export function createPcbMutationOperations({
  callFirst,
  readFirstPath,
  requireActivePcbContext,
  deletePrimitives,
}: PcbMutationOperationDependencies): PcbMutationOperations {
  async function rebuildCopper(params: Record<string, unknown>): Promise<CopperRebuildResult> {
    await requireActivePcbContext();

    const pourClass = readFirstPath<unknown>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const pouredClass = readFirstPath<unknown>(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']);
    if (!pourClass || !nativeMethod(pourClass, 'getAll') || !nativeMethod(pourClass, 'get')) {
      throw new Error(
        'EasyEDA runtime does not expose PCB_PrimitivePour.get()/getAll(); no copper was rebuilt.',
      );
    }
    if (!pouredClass || !nativeMethod(pouredClass, 'getAll')) {
      throw new Error(
        'EasyEDA runtime does not expose PCB_PrimitivePoured.getAll(); read-back cannot be verified, so no copper was rebuilt.',
      );
    }

    const targets = await resolvePours(pourClass, params);

    // Prove that the read-back surface is callable before any mutation begins.
    const preflightReadback = await invokeNative(pouredClass, 'getAll');
    if (!Array.isArray(preflightReadback)) {
      throw new Error(
        'PCB_PrimitivePoured.getAll() did not return an array; read-back cannot be verified, so no copper was rebuilt.',
      );
    }

    const attempts: Array<{
      pourId: string;
      nativeResult?: unknown;
      error?: string;
    }> = [];
    for (const target of targets) {
      try {
        attempts.push({
          pourId: target.pourId,
          nativeResult: await invokeNative(target.primitive, 'rebuildCopperRegion'),
        });
      } catch (error) {
        attempts.push({
          pourId: target.pourId,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    let postReadback: unknown[];
    try {
      const value = await invokeNative(pouredClass, 'getAll');
      if (!Array.isArray(value)) throw new Error('getAll() did not return an array');
      postReadback = value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const results = attempts.map<CopperRebuildItem>((attempt) => {
        if (attempt.error) {
          return {
            pourId: attempt.pourId,
            pouredId: null,
            status: 'error',
            verified: false,
            error: attempt.error,
          };
        }
        if (attempt.nativeResult === undefined) {
          return {
            pourId: attempt.pourId,
            pouredId: null,
            status: 'no-copper',
            verified: false,
            error: `Native rebuild returned no copper, but PCB_PrimitivePoured read-back failed: ${message}`,
          };
        }
        return {
          pourId: attempt.pourId,
          pouredId: null,
          status: 'readback-missing',
          verified: false,
          error: `Copper rebuild returned, but PCB_PrimitivePoured read-back failed: ${message}`,
        };
      });
      return {
        success: false,
        matchedCount: targets.length,
        attemptedCount: attempts.length,
        rebuiltCount: 0,
        noCopperCount: results.filter((item) => item.status === 'no-copper').length,
        transactionCovered: false,
        planeZonesSupported: false,
        results,
        error:
          'PCB copper rebuild completed or partially completed, but persisted read-back could not be verified.',
      };
    }

    const byPourId = pouredReadbackMap(postReadback);
    const results = attempts.map<CopperRebuildItem>((attempt) => {
      if (attempt.error) {
        return {
          pourId: attempt.pourId,
          pouredId: null,
          status: 'error',
          verified: false,
          error: attempt.error,
        };
      }

      const readbackIds = byPourId.get(attempt.pourId) ?? [];
      if (attempt.nativeResult === undefined) {
        if (readbackIds.length === 0) {
          return {
            pourId: attempt.pourId,
            pouredId: null,
            status: 'no-copper',
            verified: true,
          };
        }
        return {
          pourId: attempt.pourId,
          pouredId: readbackIds[0] ?? null,
          status: 'readback-mismatch',
          verified: false,
          error:
            'Native rebuild returned undefined (no copper), but PCB_PrimitivePoured still reports derived copper for this pour.',
        };
      }

      if (readbackIds.length === 0) {
        return {
          pourId: attempt.pourId,
          pouredId: null,
          status: 'readback-missing',
          verified: false,
          error:
            'Native rebuild returned a poured result, but PCB_PrimitivePoured.getAll() did not confirm it.',
        };
      }
      if (readbackIds.length !== 1) {
        return {
          pourId: attempt.pourId,
          pouredId: readbackIds[0] ?? null,
          status: 'readback-mismatch',
          verified: false,
          error: `PCB_PrimitivePoured read-back is ambiguous for this pour (found ${readbackIds.length} derived primitives).`,
        };
      }

      const nativePouredId = nativeStateString(attempt.nativeResult, 'getState_PrimitiveId');
      if (nativePouredId !== undefined && nativePouredId !== readbackIds[0]) {
        return {
          pourId: attempt.pourId,
          pouredId: readbackIds[0],
          status: 'readback-mismatch',
          verified: false,
          error: `Native rebuild returned poured id ${nativePouredId}, but persisted read-back reported ${readbackIds[0]}.`,
        };
      }

      return {
        pourId: attempt.pourId,
        pouredId: readbackIds[0],
        status: 'rebuilt',
        verified: true,
      };
    });

    const rebuiltCount = results.filter((item) => item.status === 'rebuilt').length;
    const noCopperCount = results.filter((item) => item.status === 'no-copper').length;
    const success =
      attempts.length === targets.length &&
      results.length === targets.length &&
      rebuiltCount === targets.length;
    const firstFailure = results.find((item) => item.status !== 'rebuilt');

    return {
      success,
      matchedCount: targets.length,
      attemptedCount: attempts.length,
      rebuiltCount,
      noCopperCount,
      transactionCovered: false,
      planeZonesSupported: false,
      results,
      ...(success
        ? {}
        : {
            error:
              firstFailure?.error ??
              (noCopperCount > 0
                ? 'One or more pours produced no copper and were not counted as successful rebuilds.'
                : 'One or more pours could not be rebuilt and verified.'),
          }),
    };
  }

  async function modifyComponent(params: Record<string, unknown>): Promise<unknown> {
    return callFirst(
      ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
      params.primitiveId,
      validatedComponentTransformProperty(params.property),
    );
  }

  async function deleteComponents(params: Record<string, unknown>): Promise<{
    success: boolean;
    deletedCount: number;
    deleted: string[];
    notFound: string[];
  }> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    const result = await deletePrimitives(ids);
    return {
      success: result.notFound.length === 0,
      deletedCount: result.deleted.length,
      deleted: result.deleted,
      notFound: result.notFound,
    };
  }

  return {
    addZone: rejectUnverifiedZoneCreation,
    rebuildCopper,
    modifyComponent,
    deleteComponents,
  };
}
