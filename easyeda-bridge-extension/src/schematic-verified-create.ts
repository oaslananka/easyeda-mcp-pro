import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import { assertExpectedDocument } from './document-target-guard.js';
import { isRecord } from './utils.js';

const drawingMethods = new Set([
  'schematic.addWire',
  'schematic.addText',
  'schematic.addRectangle',
  'schematic.addCircle',
  'schematic.addPolygon',
]);

export function requireDrawingCreateTarget(
  method: string,
  params: Record<string, unknown>,
  error: BridgeErrorFactory,
): void {
  if (params.verifiedDrawingCreate !== true) return;
  if (
    !drawingMethods.has(method) ||
    typeof params.expectedProjectUuid !== 'string' ||
    !params.expectedProjectUuid.trim() ||
    typeof params.expectedSchematicPageUuid !== 'string' ||
    !params.expectedSchematicPageUuid.trim() ||
    params.expectedPcbUuid !== undefined
  ) {
    throw error(
      'INVALID_PARAMS',
      'Verified drawing creation requires an exact project and schematic page.',
      'Focus the intended schematic page and supply both native identifiers.',
    );
  }
}

/** Never use a generic UUID or a newly visible inventory entry as the native return ID. */
function returnedDrawingId(value: unknown): string | undefined {
  if (!isRecord(value) || Array.isArray(value)) return undefined;
  const ids: unknown[] = [value.primitiveId, value.PrimitiveId];
  try {
    if (typeof value.getState_PrimitiveId === 'function')
      ids.push(value.getState_PrimitiveId.call(value));
    if (typeof value.getState === 'function') {
      const state = value.getState.call(value);
      if (isRecord(state)) ids.push(state.PrimitiveId);
    }
  } catch {
    return undefined;
  }
  const present = ids.filter((id) => id !== undefined);
  if (
    present.length === 0 ||
    present.some((id) => typeof id !== 'string' || !id || id.trim() !== id)
  )
    return undefined;
  return new Set(present).size === 1 ? (present[0] as string) : undefined;
}

export async function acknowledgeDrawingCreate(
  method: string,
  params: Record<string, unknown>,
  result: unknown,
  readFirstPath: ApiRuntime['readFirstPath'],
  error: BridgeErrorFactory,
): Promise<unknown> {
  if (params.verifiedDrawingCreate !== true) return result;
  const primitiveId = returnedDrawingId(result);
  if (!primitiveId) {
    throw error(
      'NATIVE_CREATE_UNVERIFIED',
      'Native drawing create did not return an unambiguous primitive ID. The outcome may be unresolved.',
      'Inspect the intended schematic. Do not retry or delete an unowned primitive.',
    );
  }
  const targetDocument = await assertExpectedDocument(method, params, readFirstPath, error);
  return { primitiveId, verifiedDrawingCreate: true, targetDocument };
}
