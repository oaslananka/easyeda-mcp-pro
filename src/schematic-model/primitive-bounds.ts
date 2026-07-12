import {
  combineBounds,
  type SchematicBounds,
  type SchematicCoordinateOrigin,
  type SchematicPoint,
} from '../schematic-engine/geometry.js';

export type PrimitiveRotation = 0 | 90 | 180 | 270;
export type PrimitiveGeometrySource = 'runtime' | 'derived' | 'approximate' | 'not_available';
export type PrimitiveGeometryConfidence = 'exact' | 'conservative' | 'low' | 'not_available';
export type PrimitiveBoundsSpace = 'local' | 'sheet';

export interface PrimitiveBoundsSegmentInput {
  id?: string;
  bounds?: SchematicBounds;
  space?: PrimitiveBoundsSpace;
  text?: string;
  anchor?: SchematicPoint;
  fontSize?: number;
  visible?: boolean;
  geometrySource?: Exclude<PrimitiveGeometrySource, 'not_available'>;
}

export interface PrimitiveBoundsSegment {
  id?: string;
  bounds: SchematicBounds;
  geometrySource: Exclude<PrimitiveGeometrySource, 'not_available'>;
  confidence: Exclude<PrimitiveGeometryConfidence, 'not_available'>;
}

export interface PrimitiveBoundsInput {
  id: string;
  primitiveType: string;
  origin: SchematicPoint;
  rotation?: PrimitiveRotation;
  mirroredX?: boolean;
  mirroredY?: boolean;
  units: string;
  grid: number;
  coordinateOrigin: SchematicCoordinateOrigin;
  body?: PrimitiveBoundsSegmentInput;
  reference?: PrimitiveBoundsSegmentInput;
  value?: PrimitiveBoundsSegmentInput;
  pinTexts?: readonly PrimitiveBoundsSegmentInput[];
  labels?: readonly PrimitiveBoundsSegmentInput[];
  annotations?: readonly PrimitiveBoundsSegmentInput[];
}

export interface PrimitiveBoundsResult {
  id: string;
  primitiveType: string;
  origin: SchematicPoint;
  rotation: PrimitiveRotation;
  mirroredX: boolean;
  mirroredY: boolean;
  units: string;
  grid: number;
  coordinateOrigin: SchematicCoordinateOrigin;
  availability: 'available' | 'not_available';
  geometrySource: PrimitiveGeometrySource;
  confidence: PrimitiveGeometryConfidence;
  body?: PrimitiveBoundsSegment;
  reference?: PrimitiveBoundsSegment;
  value?: PrimitiveBoundsSegment;
  pinTexts: PrimitiveBoundsSegment[];
  labels: PrimitiveBoundsSegment[];
  annotations: PrimitiveBoundsSegment[];
  combinedBounds?: SchematicBounds;
  limitations: string[];
}

export interface PrimitiveBoundsBatchResult {
  items: PrimitiveBoundsResult[];
  availableCount: number;
  notAvailableCount: number;
  units: string | 'mixed';
  coordinateOrigins: SchematicCoordinateOrigin[];
}

const SOURCE_RANK: Record<PrimitiveGeometrySource, number> = {
  runtime: 3,
  derived: 2,
  approximate: 1,
  not_available: 0,
};

function rotateLocalPoint(
  point: SchematicPoint,
  input: Pick<
    PrimitiveBoundsInput,
    'coordinateOrigin' | 'mirroredX' | 'mirroredY' | 'rotation'
  >,
): SchematicPoint {
  const mirrored = {
    x: input.mirroredX ? -point.x : point.x,
    y: input.mirroredY ? -point.y : point.y,
  };
  const visualClockwise = input.coordinateOrigin.yAxis === 'down' ? 1 : -1;
  const quarterTurns = ((input.rotation ?? 0) / 90) * visualClockwise;
  const normalizedTurns = ((quarterTurns % 4) + 4) % 4;
  if (normalizedTurns === 1) return { x: -mirrored.y, y: mirrored.x };
  if (normalizedTurns === 2) return { x: -mirrored.x, y: -mirrored.y };
  if (normalizedTurns === 3) return { x: mirrored.y, y: -mirrored.x };
  return mirrored;
}

function transformLocalBounds(bounds: SchematicBounds, input: PrimitiveBoundsInput): SchematicBounds {
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ].map((point) => rotateLocalPoint(point, input));
  const left = Math.min(...corners.map((point) => point.x)) + input.origin.x;
  const top = Math.min(...corners.map((point) => point.y)) + input.origin.y;
  const right = Math.max(...corners.map((point) => point.x)) + input.origin.x;
  const bottom = Math.max(...corners.map((point) => point.y)) + input.origin.y;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function approximateTextBounds(segment: PrimitiveBoundsSegmentInput): SchematicBounds | undefined {
  if (!segment.text || !segment.anchor) return undefined;
  const fontSize = Math.max(1, segment.fontSize ?? 10);
  const width = Math.max(fontSize, segment.text.length * fontSize * 0.7);
  const height = fontSize * 1.3;
  return {
    x: segment.anchor.x - width / 2,
    y: segment.anchor.y - height / 2,
    width,
    height,
  };
}

function normalizeSegment(
  segment: PrimitiveBoundsSegmentInput | undefined,
  input: PrimitiveBoundsInput,
): PrimitiveBoundsSegment | undefined {
  if (!segment || segment.visible === false) return undefined;
  const approximate = segment.bounds === undefined;
  const sourceBounds = segment.bounds ?? approximateTextBounds(segment);
  if (!sourceBounds) return undefined;
  const geometrySource = approximate ? 'approximate' : (segment.geometrySource ?? 'derived');
  return {
    ...(segment.id ? { id: segment.id } : {}),
    bounds:
      segment.space === 'sheet'
        ? { ...sourceBounds }
        : transformLocalBounds(sourceBounds, input),
    geometrySource,
    confidence:
      geometrySource === 'runtime'
        ? 'exact'
        : geometrySource === 'approximate'
          ? 'conservative'
          : 'conservative',
  };
}

function normalizeSegments(
  segments: readonly PrimitiveBoundsSegmentInput[] | undefined,
  input: PrimitiveBoundsInput,
): PrimitiveBoundsSegment[] {
  return (segments ?? [])
    .map((segment) => normalizeSegment(segment, input))
    .filter((segment): segment is PrimitiveBoundsSegment => segment !== undefined);
}

function weakestSource(segments: readonly PrimitiveBoundsSegment[]): PrimitiveGeometrySource {
  return segments.reduce<PrimitiveGeometrySource>(
    (weakest, segment) =>
      SOURCE_RANK[segment.geometrySource] < SOURCE_RANK[weakest]
        ? segment.geometrySource
        : weakest,
    'runtime',
  );
}

export function computePrimitiveBounds(input: PrimitiveBoundsInput): PrimitiveBoundsResult {
  const normalizedInput: PrimitiveBoundsInput = {
    ...input,
    rotation: input.rotation ?? 0,
    mirroredX: input.mirroredX ?? false,
    mirroredY: input.mirroredY ?? false,
  };
  const body = normalizeSegment(input.body, normalizedInput);
  const reference = normalizeSegment(input.reference, normalizedInput);
  const value = normalizeSegment(input.value, normalizedInput);
  const pinTexts = normalizeSegments(input.pinTexts, normalizedInput);
  const labels = normalizeSegments(input.labels, normalizedInput);
  const annotations = normalizeSegments(input.annotations, normalizedInput);
  const segments = [body, reference, value, ...pinTexts, ...labels, ...annotations].filter(
    (segment): segment is PrimitiveBoundsSegment => segment !== undefined,
  );
  const combined = combineBounds(segments.map((segment) => segment.bounds));
  const limitations: string[] = [];
  if (!body) limitations.push('Symbol/body bounds are not available.');
  if (segments.some((segment) => segment.geometrySource === 'approximate')) {
    limitations.push('One or more text bounds use conservative measurement fallback.');
  }
  if (!combined) limitations.push('No rendered geometry was available for this primitive.');
  const geometrySource = combined ? weakestSource(segments) : 'not_available';
  const confidence: PrimitiveGeometryConfidence =
    geometrySource === 'runtime'
      ? 'exact'
      : geometrySource === 'derived' || geometrySource === 'approximate'
        ? 'conservative'
        : 'not_available';

  return {
    id: input.id,
    primitiveType: input.primitiveType,
    origin: { ...input.origin },
    rotation: normalizedInput.rotation ?? 0,
    mirroredX: normalizedInput.mirroredX ?? false,
    mirroredY: normalizedInput.mirroredY ?? false,
    units: input.units,
    grid: input.grid,
    coordinateOrigin: { ...input.coordinateOrigin },
    availability: combined ? 'available' : 'not_available',
    geometrySource,
    confidence,
    ...(body ? { body } : {}),
    ...(reference ? { reference } : {}),
    ...(value ? { value } : {}),
    pinTexts,
    labels,
    annotations,
    ...(combined ? { combinedBounds: combined } : {}),
    limitations,
  };
}

export function computePrimitiveBoundsBatch(
  inputs: readonly PrimitiveBoundsInput[],
): PrimitiveBoundsBatchResult {
  const items = inputs.map(computePrimitiveBounds);
  const units = [...new Set(items.map((item) => item.units))];
  const originKeys = new Map<string, SchematicCoordinateOrigin>();
  for (const item of items) {
    const origin = item.coordinateOrigin;
    originKeys.set(`${origin.x}:${origin.y}:${origin.yAxis}:${origin.source}`, origin);
  }
  return {
    items,
    availableCount: items.filter((item) => item.availability === 'available').length,
    notAvailableCount: items.filter((item) => item.availability === 'not_available').length,
    units: units.length === 1 ? (units[0] ?? 'mixed') : 'mixed',
    coordinateOrigins: [...originKeys.values()],
  };
}
