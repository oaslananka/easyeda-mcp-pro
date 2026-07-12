import {
  boundingRect,
  directionBetween,
  distancePointToRect,
  expandRect,
  manhattanDistance,
  pointInRect,
  rectBottom,
  rectRight,
} from './geometry.js';
import {
  minimumForeignWireDistance,
  minimumObstacleDistance,
  type RoutingEnvironment,
} from './obstacles.js';
import type {
  CardinalDirection,
  Point,
  Rect,
  ResolvedRouteOptions,
  RouteCostWeights,
  RoutingObstacleKind,
} from './types.js';

export const DEFAULT_ROUTE_COST_WEIGHTS: RouteCostWeights = {
  length: 1,
  bend: 18,
  obstacleProximity: 4,
  foreignNetProximity: 10,
  textProximity: 7,
  componentEdgeProximity: 6,
  sheetEdgeProximity: 2,
  preferredChannel: 3,
  compactness: 0.15,
};

const TEXT_KINDS: ReadonlySet<RoutingObstacleKind> = new Set([
  'pin-text',
  'text',
  'net-label',
]);
const COMPONENT_KINDS: ReadonlySet<RoutingObstacleKind> = new Set(['component']);

export interface RouteCostContext {
  environment: RoutingEnvironment;
  compactBounds: Rect;
}

function proximityPenalty(distance: number, range: number, weight: number): number {
  if (!Number.isFinite(distance) || distance >= range || range <= 0) return 0;
  return ((range - distance) / range) * weight;
}

function distanceToSheetEdge(point: Point, bounds: Rect): number {
  return Math.min(
    point.x - bounds.x,
    rectRight(bounds) - point.x,
    point.y - bounds.y,
    rectBottom(bounds) - point.y,
  );
}

function channelReward(
  point: Point,
  direction: CardinalDirection,
  options: ResolvedRouteOptions,
): number {
  let reward = 0;
  for (const channel of options.preferredChannels) {
    if (!pointInRect(point, channel.bounds)) continue;
    const matchesOrientation =
      channel.orientation === undefined ||
      channel.orientation === 'both' ||
      (channel.orientation === 'horizontal' && (direction === 'east' || direction === 'west')) ||
      (channel.orientation === 'vertical' && (direction === 'north' || direction === 'south'));
    if (matchesOrientation) {
      reward = Math.max(reward, channel.reward ?? options.costWeights.preferredChannel);
    }
  }
  return reward;
}

function compactnessPenalty(point: Point, compactBounds: Rect, weight: number): number {
  return pointInRect(point, compactBounds)
    ? 0
    : distancePointToRect(point, compactBounds) * weight;
}

export function createRouteCostContext(
  environment: RoutingEnvironment,
  terminals: readonly Point[],
): RouteCostContext {
  return {
    environment,
    compactBounds: expandRect(boundingRect(terminals), environment.options.compactnessMargin),
  };
}

export function calculateStepCost(
  from: Point,
  to: Point,
  previousDirection: CardinalDirection | null,
  direction: CardinalDirection,
  context: RouteCostContext,
): number {
  const { environment, compactBounds } = context;
  const { options } = environment;
  const weights = options.costWeights;
  const length = manhattanDistance(from, to);
  let cost = length * weights.length;
  if (previousDirection && previousDirection !== direction) cost += weights.bend;

  const proximityRange = Math.max(options.gridSize * 3, options.clearance * 3);
  cost += proximityPenalty(
    minimumObstacleDistance(to, environment),
    proximityRange,
    weights.obstacleProximity,
  );
  cost += proximityPenalty(
    minimumObstacleDistance(to, environment, COMPONENT_KINDS),
    proximityRange,
    weights.componentEdgeProximity,
  );
  cost += proximityPenalty(
    minimumObstacleDistance(to, environment, TEXT_KINDS),
    proximityRange,
    weights.textProximity,
  );
  cost += proximityPenalty(
    minimumForeignWireDistance(to, environment),
    Math.max(options.foreignWireClearance * 3, options.gridSize * 2),
    weights.foreignNetProximity,
  );
  cost += proximityPenalty(
    distanceToSheetEdge(to, environment.sheetBounds),
    options.gridSize * 2,
    weights.sheetEdgeProximity,
  );
  cost += compactnessPenalty(to, compactBounds, weights.compactness);

  const reward = channelReward(to, direction, options);
  return Math.max(length * 0.05, cost - Math.min(reward, cost * 0.8));
}

export function calculatePathCost(
  points: readonly Point[],
  context: RouteCostContext,
): number {
  let cost = 0;
  let previousDirection: CardinalDirection | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const direction = directionBetween(previous, current);
    if (!direction) continue;
    cost += calculateStepCost(previous, current, previousDirection, direction, context);
    previousDirection = direction;
  }
  return Number(cost.toFixed(6));
}

