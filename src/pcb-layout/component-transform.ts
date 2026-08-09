export type PcbComponentSide = 'top' | 'bottom';
export type PcbComponentLayer = 1 | 2;

export interface PcbComponentTransformState {
  primitiveId: string;
  designator?: string;
  side: PcbComponentSide;
  layer: PcbComponentLayer;
  xMil: number;
  yMil: number;
  rotationDeg: number;
  locked: boolean;
}

export interface PcbComponentTransformRequest {
  side?: PcbComponentSide;
  xMil?: number;
  yMil?: number;
  rotationDeg?: number;
}

export interface PcbComponentTransformChange {
  field: 'side' | 'xMil' | 'yMil' | 'rotationDeg';
  before: string | number;
  after: string | number;
}

export interface PcbComponentTransformPlan {
  before: PcbComponentTransformState;
  planned: PcbComponentTransformState;
  changes: PcbComponentTransformChange[];
  nativeProperty: Record<string, number>;
}

export function normalizePcbRotation(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function pcbSideToLayer(side: PcbComponentSide): PcbComponentLayer {
  return side === 'top' ? 1 : 2;
}

export function pcbLayerToSide(layer: number): PcbComponentSide | undefined {
  if (layer === 1) return 'top';
  if (layer === 2) return 'bottom';
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parsePcbComponentTransformState(
  value: unknown,
): PcbComponentTransformState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const primitiveId = typeof item.primitiveId === 'string' ? item.primitiveId : undefined;
  const layer = finiteNumber(item.layer);
  const side = layer === undefined ? undefined : pcbLayerToSide(layer);
  const xMil = finiteNumber(item.x);
  const yMil = finiteNumber(item.y);
  const rotationDeg = finiteNumber(item.rotation);
  const locked = typeof item.locked === 'boolean' ? item.locked : undefined;
  if (
    !primitiveId ||
    !side ||
    xMil === undefined ||
    yMil === undefined ||
    rotationDeg === undefined ||
    locked === undefined
  ) {
    return undefined;
  }
  return {
    primitiveId,
    ...(typeof item.designator === 'string' ? { designator: item.designator } : {}),
    side,
    layer: layer as PcbComponentLayer,
    xMil,
    yMil,
    rotationDeg: normalizePcbRotation(rotationDeg),
    locked,
  };
}

function numbersEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

export function planPcbComponentTransform(
  before: PcbComponentTransformState,
  request: PcbComponentTransformRequest,
): PcbComponentTransformPlan {
  const planned: PcbComponentTransformState = {
    ...before,
    ...(request.side ? { side: request.side, layer: pcbSideToLayer(request.side) } : {}),
    ...(request.xMil !== undefined ? { xMil: request.xMil } : {}),
    ...(request.yMil !== undefined ? { yMil: request.yMil } : {}),
    ...(request.rotationDeg !== undefined
      ? { rotationDeg: normalizePcbRotation(request.rotationDeg) }
      : {}),
  };
  const changes: PcbComponentTransformChange[] = [];
  if (before.side !== planned.side) {
    changes.push({ field: 'side', before: before.side, after: planned.side });
  }
  if (!numbersEqual(before.xMil, planned.xMil)) {
    changes.push({ field: 'xMil', before: before.xMil, after: planned.xMil });
  }
  if (!numbersEqual(before.yMil, planned.yMil)) {
    changes.push({ field: 'yMil', before: before.yMil, after: planned.yMil });
  }
  if (!numbersEqual(before.rotationDeg, planned.rotationDeg)) {
    changes.push({
      field: 'rotationDeg',
      before: before.rotationDeg,
      after: planned.rotationDeg,
    });
  }

  const nativeProperty: Record<string, number> = {};
  if (changes.some((change) => change.field === 'side')) nativeProperty.layer = planned.layer;
  if (changes.some((change) => change.field === 'xMil')) nativeProperty.x = planned.xMil;
  if (changes.some((change) => change.field === 'yMil')) nativeProperty.y = planned.yMil;
  if (changes.some((change) => change.field === 'rotationDeg')) {
    nativeProperty.rotation = planned.rotationDeg;
  }

  return { before, planned, changes, nativeProperty };
}

export function pcbComponentStateMatches(
  actual: PcbComponentTransformState,
  expected: PcbComponentTransformState,
): boolean {
  return (
    actual.primitiveId === expected.primitiveId &&
    actual.side === expected.side &&
    actual.layer === expected.layer &&
    numbersEqual(actual.xMil, expected.xMil) &&
    numbersEqual(actual.yMil, expected.yMil) &&
    numbersEqual(
      normalizePcbRotation(actual.rotationDeg),
      normalizePcbRotation(expected.rotationDeg),
    ) &&
    actual.locked === expected.locked
  );
}

export function nativePcbComponentRestoreProperty(
  snapshot: PcbComponentTransformState,
): Record<string, number | boolean> {
  return {
    layer: snapshot.layer,
    x: snapshot.xMil,
    y: snapshot.yMil,
    rotation: normalizePcbRotation(snapshot.rotationDeg),
    primitiveLock: snapshot.locked,
  };
}
