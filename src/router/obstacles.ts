import {
  distancePointToRect,
  distancePointToSegment,
  expandRect,
  intersectAxisAlignedSegments,
  pointInRect,
  pointKey,
  pointOnSegment,
  pointsEqual,
  segmentIntersectsRect,
  type Segment,
} from './geometry.js';
import type {
  ExistingWire,
  Point,
  Rect,
  ResolvedRouteOptions,
  RouteCollision,
  RouteRequest,
  RoutingObstacle,
  RoutingObstacleKind,
} from './types.js';

export interface PreparedObstacle extends RoutingObstacle {
  blockedBounds: Rect;
}

export interface PreparedWireSegment extends Segment {
  wireId: string;
  netName: string;
  segmentIndex: number;
}

export interface RoutingEnvironment {
  netName: string;
  sheetBounds: Rect;
  obstacles: readonly PreparedObstacle[];
  wireSegments: readonly PreparedWireSegment[];
  sameNetMergePointKeys: ReadonlySet<string>;
  options: ResolvedRouteOptions;
}

export interface SegmentCollisionCheck {
  collisions: readonly RouteCollision[];
  mergePoints: readonly Point[];
}

export interface SegmentCheckOptions {
  segmentIndex?: number;
  ignoreObstacleIds?: ReadonlySet<string>;
  reservedSegments?: readonly Segment[];
  allowReservedStartPoint?: boolean;
}

function identifiedObstacles(
  kind: RoutingObstacleKind,
  values: RouteRequest['componentBounds'],
): RoutingObstacle[] {
  return (values ?? []).map((value) => ({ id: value.id, kind, bounds: value }));
}

function prepareWireSegments(wires: readonly ExistingWire[]): PreparedWireSegment[] {
  const segments: PreparedWireSegment[] = [];
  for (const wire of wires) {
    for (let index = 1; index < wire.points.length; index += 1) {
      const start = wire.points[index - 1];
      const end = wire.points[index];
      if (!start || !end || pointsEqual(start, end)) continue;
      segments.push({
        start,
        end,
        wireId: wire.id,
        netName: wire.netName,
        segmentIndex: index - 1,
      });
    }
  }
  return segments;
}

export function buildRoutingEnvironment(
  request: RouteRequest,
  options: ResolvedRouteOptions,
): RoutingEnvironment {
  const obstacles: RoutingObstacle[] = [
    ...identifiedObstacles('component', request.componentBounds),
    ...identifiedObstacles('pin-text', request.pinTextBounds),
    ...identifiedObstacles('text', request.textBounds),
    ...identifiedObstacles('net-label', request.netLabelBounds),
    ...identifiedObstacles('keepout', request.keepouts),
    ...(request.obstacles ?? []),
  ];
  const prepared = obstacles.map((obstacle) => ({
    ...obstacle,
    blockedBounds: expandRect(obstacle.bounds, options.clearance + (obstacle.clearance ?? 0)),
  }));
  const explicitMergePoints = options.allowedSameNetMergePoints;
  const junctionMergePoints = (request.existingJunctions ?? [])
    .filter((junction) => junction.netName === request.netName)
    .map((junction) => junction.point);
  return {
    netName: request.netName,
    sheetBounds: request.sheetBounds,
    obstacles: prepared,
    wireSegments: prepareWireSegments(request.existingWires ?? []),
    sameNetMergePointKeys: new Set(
      [...explicitMergePoints, ...junctionMergePoints].map((point) => pointKey(point)),
    ),
    options,
  };
}

function obstacleCollisionCode(kind: RoutingObstacleKind): RouteCollision['code'] {
  switch (kind) {
    case 'component':
      return 'COMPONENT_BODY';
    case 'pin-text':
      return 'PIN_TEXT';
    case 'text':
      return 'TEXT';
    case 'net-label':
      return 'NET_LABEL';
    case 'keepout':
      return 'KEEPOUT';
  }
}

function obstacleMessage(kind: RoutingObstacleKind): string {
  switch (kind) {
    case 'component':
      return 'Route intersects a component body or its required clearance.';
    case 'pin-text':
      return 'Route intersects pin-label text clearance.';
    case 'text':
      return 'Route intersects schematic text clearance.';
    case 'net-label':
      return 'Route intersects a net-label bounding box.';
    case 'keepout':
      return 'Route enters a schematic routing keepout.';
  }
}

function pointFromIntersection(
  intersection: ReturnType<typeof intersectAxisAlignedSegments>,
): Point | undefined {
  if (intersection.kind === 'point') return intersection.point;
  if (intersection.kind === 'overlap') return intersection.start;
  return undefined;
}

function foreignWireCollision(
  start: Point,
  end: Point,
  segment: PreparedWireSegment,
  segmentIndex: number | undefined,
): RouteCollision | null {
  const intersection = intersectAxisAlignedSegments(start, end, segment.start, segment.end);
  if (intersection.kind === 'none') return null;
  const point = pointFromIntersection(intersection);
  if (
    (point && (pointsEqual(point, start) || pointsEqual(point, end))) ||
    pointOnSegment(start, segment.start, segment.end) ||
    pointOnSegment(end, segment.start, segment.end)
  ) {
    return {
      code: 'FOREIGN_NET_COORDINATE',
      severity: 'error',
      message: `Route would share a coordinate with foreign net ${segment.netName}.`,
      point,
      segmentIndex,
      wireId: segment.wireId,
    };
  }
  return {
    code: intersection.kind === 'point' ? 'ACCIDENTAL_JUNCTION' : 'FOREIGN_NET',
    severity: 'error',
    message:
      intersection.kind === 'point'
        ? `Route would cross foreign net ${segment.netName} at an EasyEDA auto-merge coordinate.`
        : `Route would overlap foreign net ${segment.netName}.`,
    point,
    segmentIndex,
    wireId: segment.wireId,
  };
}

function sameNetWireCollision(
  start: Point,
  end: Point,
  segment: PreparedWireSegment,
  environment: RoutingEnvironment,
  segmentIndex: number | undefined,
): { collision?: RouteCollision; mergePoint?: Point } | null {
  const intersection = intersectAxisAlignedSegments(start, end, segment.start, segment.end);
  if (intersection.kind === 'none') return null;
  if (intersection.kind === 'point') {
    const allowed =
      environment.options.allowSameNetMerges &&
      environment.sameNetMergePointKeys.has(pointKey(intersection.point));
    if (allowed) return { mergePoint: intersection.point };
    return {
      collision: {
        code: 'SAME_NET_MERGE_NOT_ALLOWED',
        severity: 'error',
        message: 'Same-net contact is not at an explicitly allowed merge point.',
        point: intersection.point,
        segmentIndex,
        wireId: segment.wireId,
      },
    };
  }
  return {
    collision: {
      code: 'SAME_NET_MERGE_NOT_ALLOWED',
      severity: 'error',
      message: 'Collinear overlap with an existing same-net wire is not a controlled merge.',
      point: intersection.start,
      segmentIndex,
      wireId: segment.wireId,
    },
  };
}

function reservedPathCollision(
  start: Point,
  end: Point,
  segment: Segment,
  allowStartPoint: boolean,
): RouteCollision | null {
  const intersection = intersectAxisAlignedSegments(start, end, segment.start, segment.end);
  if (intersection.kind === 'none') return null;
  if (
    allowStartPoint &&
    intersection.kind === 'point' &&
    pointsEqual(intersection.point, start) &&
    (pointsEqual(intersection.point, segment.start) || pointsEqual(intersection.point, segment.end))
  ) {
    return null;
  }
  return {
    code: 'SELF_INTERSECTION',
    severity: 'error',
    message: 'Route would intersect an earlier leg of the same route.',
    point: pointFromIntersection(intersection),
  };
}

export function checkSegmentCollisions(
  start: Point,
  end: Point,
  environment: RoutingEnvironment,
  checkOptions: SegmentCheckOptions = {},
): SegmentCollisionCheck {
  const collisions: RouteCollision[] = [];
  const mergePoints = new Map<string, Point>();
  if (!pointInRect(start, environment.sheetBounds) || !pointInRect(end, environment.sheetBounds)) {
    collisions.push({
      code: 'OUT_OF_BOUNDS',
      severity: 'error',
      message: 'Route segment leaves the schematic sheet bounds.',
      point: !pointInRect(start, environment.sheetBounds) ? start : end,
      segmentIndex: checkOptions.segmentIndex,
    });
  }
  for (const obstacle of environment.obstacles) {
    if (checkOptions.ignoreObstacleIds?.has(obstacle.id)) continue;
    if (segmentIntersectsRect(start, end, obstacle.blockedBounds)) {
      collisions.push({
        code: obstacleCollisionCode(obstacle.kind),
        severity: 'error',
        message: obstacleMessage(obstacle.kind),
        segmentIndex: checkOptions.segmentIndex,
        obstacleId: obstacle.id,
      });
    }
  }
  for (const segment of environment.wireSegments) {
    if (segment.netName === environment.netName) {
      const result = sameNetWireCollision(
        start,
        end,
        segment,
        environment,
        checkOptions.segmentIndex,
      );
      if (result?.collision) collisions.push(result.collision);
      if (result?.mergePoint) mergePoints.set(pointKey(result.mergePoint), result.mergePoint);
    } else {
      const collision = foreignWireCollision(start, end, segment, checkOptions.segmentIndex);
      if (collision) collisions.push(collision);
    }
  }
  for (const segment of checkOptions.reservedSegments ?? []) {
    const collision = reservedPathCollision(
      start,
      end,
      segment,
      checkOptions.allowReservedStartPoint ?? false,
    );
    if (collision) collisions.push(collision);
  }
  return { collisions, mergePoints: [...mergePoints.values()] };
}

export function pointIsBlocked(
  point: Point,
  environment: RoutingEnvironment,
  ignoreObstacleIds?: ReadonlySet<string>,
): boolean {
  if (!pointInRect(point, environment.sheetBounds)) return true;
  if (
    environment.obstacles.some(
      (obstacle) =>
        !ignoreObstacleIds?.has(obstacle.id) && pointInRect(point, obstacle.blockedBounds),
    )
  ) {
    return true;
  }
  for (const segment of environment.wireSegments) {
    if (!pointOnSegment(point, segment.start, segment.end)) continue;
    if (
      segment.netName === environment.netName &&
      environment.options.allowSameNetMerges &&
      environment.sameNetMergePointKeys.has(pointKey(point))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function minimumObstacleDistance(
  point: Point,
  environment: RoutingEnvironment,
  kinds?: ReadonlySet<RoutingObstacleKind>,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const obstacle of environment.obstacles) {
    if (kinds && !kinds.has(obstacle.kind)) continue;
    minimum = Math.min(minimum, distancePointToRect(point, obstacle.blockedBounds));
  }
  return minimum;
}

export function minimumForeignWireDistance(point: Point, environment: RoutingEnvironment): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const segment of environment.wireSegments) {
    if (segment.netName === environment.netName) continue;
    minimum = Math.min(minimum, distancePointToSegment(point, segment.start, segment.end));
  }
  return minimum;
}

