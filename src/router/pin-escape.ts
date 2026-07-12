import {
  countBends,
  directionBetween,
  isAxisAligned,
  manhattanDistance,
  movePoint,
  pointKey,
  pointsEqual,
} from './geometry.js';
import { snapPointToGrid, type RoutingGrid } from './grid.js';
import {
  checkSegmentCollisions,
  pointIsBlocked,
  type PreparedObstacle,
  type RoutingEnvironment,
} from './obstacles.js';
import type {
  CardinalDirection,
  Point,
  RouteCollision,
  RouteEndpoint,
  RouteTerminal,
} from './types.js';

export interface PinEscapeCandidate {
  terminal: RouteTerminal;
  anchor: Point;
  pointsFromTerminal: readonly Point[];
  direction: CardinalDirection | null;
  ownerObstacleId?: string;
  leadLength: number;
  bends: number;
}

export interface PinEscapeFailure {
  collisions: readonly RouteCollision[];
  message: string;
}

export interface PinEscapeResult {
  candidates: readonly PinEscapeCandidate[];
  failure?: PinEscapeFailure;
}

export function isRouteTerminal(endpoint: RouteEndpoint): endpoint is RouteTerminal {
  return 'point' in endpoint;
}

export function endpointPoint(endpoint: RouteEndpoint): Point {
  return isRouteTerminal(endpoint) ? endpoint.point : endpoint;
}

export function asRouteTerminal(endpoint: RouteEndpoint): RouteTerminal {
  return isRouteTerminal(endpoint) ? endpoint : { point: endpoint };
}

const DIRECTION_ORDER: readonly CardinalDirection[] = ['east', 'south', 'west', 'north'];

function findOwnerObstacle(
  terminal: RouteTerminal,
  environment: RoutingEnvironment,
): PreparedObstacle | undefined {
  const ownerId = terminal.obstacleId ?? terminal.componentId;
  if (!ownerId) return undefined;
  return environment.obstacles.find(
    (obstacle) => obstacle.id === ownerId && obstacle.kind === 'component',
  );
}

function distanceOutsideOwner(
  point: Point,
  direction: CardinalDirection,
  owner: PreparedObstacle | undefined,
  minimum: number,
  gridSize: number,
): number {
  if (!owner) return minimum;
  const bounds = owner.blockedBounds;
  let toEdge = 0;
  switch (direction) {
    case 'north':
      toEdge = point.y - bounds.y;
      break;
    case 'east':
      toEdge = bounds.x + bounds.width - point.x;
      break;
    case 'south':
      toEdge = bounds.y + bounds.height - point.y;
      break;
    case 'west':
      toEdge = point.x - bounds.x;
      break;
  }
  return Math.max(minimum, toEdge + gridSize);
}

function inferredDirections(
  terminal: RouteTerminal,
  owner: PreparedObstacle | undefined,
): readonly CardinalDirection[] {
  if (terminal.direction) return [terminal.direction];
  if (terminal.allowedDirections && terminal.allowedDirections.length > 0) {
    return [...new Set(terminal.allowedDirections)].sort(
      (a, b) => DIRECTION_ORDER.indexOf(a) - DIRECTION_ORDER.indexOf(b),
    );
  }
  if (!owner) return DIRECTION_ORDER;
  const point = terminal.point;
  const bounds = owner.blockedBounds;
  const distances: Readonly<Record<CardinalDirection, number>> = {
    north: Math.abs(point.y - bounds.y),
    east: Math.abs(bounds.x + bounds.width - point.x),
    south: Math.abs(bounds.y + bounds.height - point.y),
    west: Math.abs(point.x - bounds.x),
  };
  return [...DIRECTION_ORDER].sort(
    (a, b) => distances[a] - distances[b] || DIRECTION_ORDER.indexOf(a) - DIRECTION_ORDER.indexOf(b),
  );
}

function compactPoints(points: readonly Point[]): Point[] {
  const compact: Point[] = [];
  for (const point of points) {
    const previous = compact[compact.length - 1];
    if (!previous || !pointsEqual(previous, point)) compact.push(point);
  }
  return compact;
}

function leadVariants(terminalPoint: Point, escaped: Point, anchor: Point): readonly Point[][] {
  const base = pointsEqual(terminalPoint, escaped) ? [terminalPoint] : [terminalPoint, escaped];
  if (pointsEqual(escaped, anchor)) return [compactPoints([...base, anchor])];
  if (isAxisAligned(escaped, anchor)) return [compactPoints([...base, anchor])];
  return [
    compactPoints([...base, { x: anchor.x, y: escaped.y }, anchor]),
    compactPoints([...base, { x: escaped.x, y: anchor.y }, anchor]),
  ];
}

function validateLead(
  points: readonly Point[],
  ownerObstacleId: string | undefined,
  environment: RoutingEnvironment,
): readonly RouteCollision[] {
  const collisions: RouteCollision[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    const ignore =
      index === 1 && ownerObstacleId ? new Set<string>([ownerObstacleId]) : undefined;
    collisions.push(
      ...checkSegmentCollisions(start, end, environment, {
        segmentIndex: index - 1,
        ignoreObstacleIds: ignore,
      }).collisions,
    );
  }
  return collisions;
}

export function buildPinEscapeCandidates(
  endpoint: RouteEndpoint,
  directionOverride: CardinalDirection | undefined,
  grid: RoutingGrid,
  environment: RoutingEnvironment,
): PinEscapeResult {
  const original = asRouteTerminal(endpoint);
  const terminal: RouteTerminal = directionOverride
    ? { ...original, direction: directionOverride }
    : original;
  const owner = findOwnerObstacle(terminal, environment);
  const shouldEscape = isRouteTerminal(endpoint) || directionOverride !== undefined || owner !== undefined;
  const directions = shouldEscape ? inferredDirections(terminal, owner) : [null];
  const candidates = new Map<string, PinEscapeCandidate>();
  const rejected: RouteCollision[] = [];

  for (const direction of directions) {
    const minimumEscape = terminal.escapeLength ?? environment.options.pinEscapeLength;
    const distance = direction
      ? distanceOutsideOwner(
          terminal.point,
          direction,
          owner,
          minimumEscape,
          environment.options.gridSize,
        )
      : 0;
    const escaped = direction ? movePoint(terminal.point, direction, distance) : terminal.point;
    const anchor = snapPointToGrid(escaped, grid);
    if (pointIsBlocked(anchor, environment)) continue;

    for (const points of leadVariants(terminal.point, escaped, anchor)) {
      const collisions = validateLead(points, owner?.id, environment);
      if (collisions.length > 0) {
        rejected.push(...collisions);
        continue;
      }
      const firstDirection =
        points.length >= 2 && points[0] && points[1]
          ? directionBetween(points[0], points[1])
          : direction;
      const candidate: PinEscapeCandidate = {
        terminal,
        anchor,
        pointsFromTerminal: points,
        direction: firstDirection,
        ownerObstacleId: owner?.id,
        leadLength: points.reduce((total, point, index) => {
          const previous = points[index - 1];
          return previous ? total + manhattanDistance(previous, point) : total;
        }, 0),
        bends: countBends(points),
      };
      const key = `${pointKey(anchor)}|${points.map(pointKey).join(';')}`;
      candidates.set(key, candidate);
    }
  }

  const ordered = [...candidates.values()].sort(
    (a, b) =>
      a.leadLength - b.leadLength ||
      a.bends - b.bends ||
      pointKey(a.anchor).localeCompare(pointKey(b.anchor)) ||
      a.pointsFromTerminal.map(pointKey).join(';').localeCompare(b.pointsFromTerminal.map(pointKey).join(';')),
  );
  return ordered.length > 0
    ? { candidates: ordered }
    : {
        candidates: [],
        failure: {
          collisions: rejected,
          message: 'No collision-free orthogonal pin escape reaches the routing grid.',
        },
      };
}

