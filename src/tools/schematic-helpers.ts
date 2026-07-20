import { type ToolContext } from './types.js';

export interface BridgeSchematicPin {
  pinNumber: string;
  pinName: string;
  x: number;
  y: number;
  rotation: number;
  pinLength: number;
  /** Raw native EasyEDA pin-type string (e.g. "IN", "OUT", "Undefined") when
   *  present. Unreliably authored across the library — see pin-classifier.ts
   *  for why callers should not trust this alone. */
  pinType?: string;
}

/** Stringify only real primitives — avoids `String()` silently producing
 *  "[object Object]" for a bridge value that turns out not to be one. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

/**
 * Fetch a component's pins via the bridge's generic api.call passthrough to
 * SCH_PrimitiveComponent.getAllPinsByPrimitiveId, normalizing EasyEDA's
 * flat-or-nested (top-level x vs state.X) result shape. Shared by
 * easyeda_schematic_component_pins and the semantic-ERC auto-extractor.
 */
export async function fetchComponentPins(
  ctx: ToolContext,
  primitiveId: string,
  opts?: { timeoutMs?: number },
): Promise<BridgeSchematicPin[]> {
  const params = {
    path: 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
    args: [primitiveId],
  };
  const result = opts
    ? await ctx.bridge.call<{ path: string; args: unknown[] }, unknown>('api.call', params, opts)
    : await ctx.bridge.call<{ path: string; args: unknown[] }, unknown>('api.call', params);
  const resultObj = result as { result?: Array<Record<string, unknown>> } | undefined;
  const pins = Array.isArray(resultObj?.result) ? resultObj.result : [];
  return pins.map((p: Record<string, unknown>) => {
    const state = p.state as Record<string, unknown> | undefined;
    const pinType = p.pinType ?? state?.pinType ?? state?.PinType;
    return {
      pinNumber: asString(p.pinNumber) ?? asString(state?.PinNumber) ?? '',
      pinName: asString(p.pinName) ?? asString(state?.PinName) ?? '',
      x: p.x !== undefined ? Number(p.x) : Number(state?.X ?? 0),
      y: p.y !== undefined ? Number(p.y) : Number(state?.Y ?? 0),
      rotation: p.rotation !== undefined ? Number(p.rotation) : Number(state?.Rotation ?? 0),
      pinLength: p.pinLength !== undefined ? Number(p.pinLength) : Number(state?.PinLength ?? 0),
      pinType: asString(pinType),
    };
  });
}
