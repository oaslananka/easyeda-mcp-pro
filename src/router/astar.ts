import {
  manhattanDistance,
  oppositeDirection,
  pointKey,
  pointsEqual,
  type Segment,
} from './geometry.js';
import { gridNeighbors, type RoutingGrid } from './grid.js';
import { checkSegmentCollisions, type RoutingEnvironment } from './obstacles.js';
import { calculateStepCost, createRouteCostContext, type RouteCostContext } from './route-cost.js';
import type { CardinalDirection, Point } from './types.js';

interface SearchNode {
  point: Point;
  direction: CardinalDirection | null;
  bends: number;
  g: number;
  h: number;
  f: number;
  stateKey: string;
  parentKey?: string;
  sequence: number;
}

export interface AStarSearchInput {
  start: Point;
  goal: Point;
  grid: RoutingGrid;
  environment: RoutingEnvironment;
  maxBends: number;
  initialDirection?: CardinalDirection | null;
  reservedSegments?: readonly Segment[];
  costTerminals: readonly Point[];
}

export interface AStarSearchResult {
  found: boolean;
  points: readonly Point[];
  cost: number;
  bends: number;
  exploredNodes: number;
  reason?: 'search-limit' | 'no-path';
}

const DIRECTION_RANK: Readonly<Record<CardinalDirection, number>> = {
  east: 0,
  south: 1,
  west: 2,
  north: 3,
};

function stateKey(point: Point, direction: CardinalDirection | null, bends: number): string {
  return `${pointKey(point)}|${direction ?? 'start'}|${bends}`;
}

function compareNodes(a: SearchNode, b: SearchNode): number {
  return (
    a.f - b.f ||
    a.h - b.h ||
    a.bends - b.bends ||
    a.point.y - b.point.y ||
    a.point.x - b.point.x ||
    (a.direction ? DIRECTION_RANK[a.direction] : -1) -
      (b.direction ? DIRECTION_RANK[b.direction] : -1) ||
    a.sequence - b.sequence
  );
}

class MinHeap {
  private readonly values: SearchNode[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: SearchNode): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.values[parentIndex];
      if (!parent || compareNodes(parent, value) <= 0) break;
      this.values[index] = parent;
      index = parentIndex;
    }
    this.values[index] = value;
  }

  pop(): SearchNode | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      const left = this.values[leftIndex];
      const right = this.values[rightIndex];
      if (!left) break;
      const childIndex = right && compareNodes(right, left) < 0 ? rightIndex : leftIndex;
      const child = this.values[childIndex];
      if (!child || compareNodes(last, child) <= 0) break;
      this.values[index] = child;
      index = childIndex;
    }
    this.values[index] = last;
    return first;
  }
}

function heuristic(point: Point, goal: Point, context: RouteCostContext): number {
  return manhattanDistance(point, goal) * context.environment.options.costWeights.length * 0.05;
}

function reconstruct(goal: SearchNode, nodes: ReadonlyMap<string, SearchNode>): Point[] {
  const reversed: Point[] = [];
  let current: SearchNode | undefined = goal;
  while (current) {
    reversed.push(current.point);
    current = current.parentKey ? nodes.get(current.parentKey) : undefined;
  }
  return reversed.reverse();
}

export function findOrthogonalPath(input: AStarSearchInput): AStarSearchResult {
  if (pointsEqual(input.start, input.goal)) {
    return { found: true, points: [input.start], cost: 0, bends: 0, exploredNodes: 0 };
  }
  const costContext = createRouteCostContext(input.environment, input.costTerminals);
  const open = new MinHeap();
  const bestCosts = new Map<string, number>();
  const nodes = new Map<string, SearchNode>();
  let sequence = 0;
  const startDirection = input.initialDirection ?? null;
  const startKey = stateKey(input.start, startDirection, 0);
  const startNode: SearchNode = {
    point: input.start,
    direction: startDirection,
    bends: 0,
    g: 0,
    h: heuristic(input.start, input.goal, costContext),
    f: heuristic(input.start, input.goal, costContext),
    stateKey: startKey,
    sequence: sequence++,
  };
  open.push(startNode);
  bestCosts.set(startKey, 0);
  nodes.set(startKey, startNode);
  let exploredNodes = 0;

  while (open.size > 0) {
    const current = open.pop();
    if (!current) break;
    const knownCost = bestCosts.get(current.stateKey);
    if (knownCost === undefined || current.g > knownCost + 1e-9) continue;
    exploredNodes += 1;
    if (exploredNodes > input.environment.options.maxSearchNodes) {
      return {
        found: false,
        points: [],
        cost: Number.POSITIVE_INFINITY,
        bends: 0,
        exploredNodes,
        reason: 'search-limit',
      };
    }
    if (pointsEqual(current.point, input.goal)) {
      return {
        found: true,
        points: reconstruct(current, nodes),
        cost: Number(current.g.toFixed(6)),
        bends: current.bends,
        exploredNodes,
      };
    }

    for (const neighbor of gridNeighbors(current.point, input.grid)) {
      if (current.direction && neighbor.direction === oppositeDirection(current.direction)) {
        continue;
      }
      const nextBends =
        current.direction && current.direction !== neighbor.direction
          ? current.bends + 1
          : current.bends;
      if (nextBends > input.maxBends) continue;
      const collisionCheck = checkSegmentCollisions(
        current.point,
        neighbor.point,
        input.environment,
        {
          reservedSegments: input.reservedSegments,
          allowReservedStartPoint: pointsEqual(current.point, input.start),
        },
      );
      if (collisionCheck.collisions.some((collision) => collision.severity === 'error')) continue;

      const stepCost = calculateStepCost(
        current.point,
        neighbor.point,
        current.direction,
        neighbor.direction,
        costContext,
      );
      const nextG = current.g + stepCost;
      const nextKey = stateKey(neighbor.point, neighbor.direction, nextBends);
      const previousBest = bestCosts.get(nextKey);
      if (previousBest !== undefined && nextG >= previousBest - 1e-9) continue;
      const nextH = heuristic(neighbor.point, input.goal, costContext);
      const nextNode: SearchNode = {
        point: neighbor.point,
        direction: neighbor.direction,
        bends: nextBends,
        g: nextG,
        h: nextH,
        f: nextG + nextH,
        stateKey: nextKey,
        parentKey: current.stateKey,
        sequence: sequence++,
      };
      bestCosts.set(nextKey, nextG);
      nodes.set(nextKey, nextNode);
      open.push(nextNode);
    }
  }

  return {
    found: false,
    points: [],
    cost: Number.POSITIVE_INFINITY,
    bends: 0,
    exploredNodes,
    reason: 'no-path',
  };
}
