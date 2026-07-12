export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IdentifiedRect extends Rect {
  id: string;
}

export type CardinalDirection = 'north' | 'east' | 'south' | 'west';

export interface RouteTerminal {
  point: Point;
  id?: string;
  pinId?: string;
  componentId?: string;
  /** Obstacle that owns the pin and may be crossed only by the initial escape segment. */
  obstacleId?: string;
  netName?: string;
  direction?: CardinalDirection;
  allowedDirections?: readonly CardinalDirection[];
  escapeLength?: number;
}

export type RouteEndpoint = Point | RouteTerminal;

export type RoutingObstacleKind = 'component' | 'pin-text' | 'text' | 'net-label' | 'keepout';

export interface RoutingObstacle {
  id: string;
  kind: RoutingObstacleKind;
  bounds: Rect;
  /** Additional clearance beyond the route-wide clearance. */
  clearance?: number;
}

export interface ExistingWire {
  id: string;
  netName: string;
  points: readonly Point[];
}

export interface ExistingJunction {
  point: Point;
  netName: string;
  wireIds?: readonly string[];
}

export interface PreferredRoutingChannel {
  id?: string;
  bounds: Rect;
  orientation?: 'horizontal' | 'vertical' | 'both';
  reward?: number;
}

export interface RouteCostWeights {
  length: number;
  bend: number;
  obstacleProximity: number;
  foreignNetProximity: number;
  textProximity: number;
  componentEdgeProximity: number;
  sheetEdgeProximity: number;
  preferredChannel: number;
  compactness: number;
}

export interface SchematicNetClass {
  name?: string;
  gridSize?: number;
  clearance?: number;
  foreignWireClearance?: number;
  maxBends?: number;
  costWeights?: Partial<RouteCostWeights>;
}

export interface RouteConstraints {
  gridSize?: number;
  clearance?: number;
  foreignWireClearance?: number;
  maxBends?: number;
  maxSearchNodes?: number;
  maxGridCells?: number;
  maxObstacles?: number;
  maxExistingWires?: number;
  maxWireSegments?: number;
  maxIntermediateTerminals?: number;
  maxCoordinateMagnitude?: number;
  allowSameNetMerges?: boolean;
  allowedSameNetMergePoints?: readonly Point[];
  allowNetLabelFallback?: boolean;
  preferredChannels?: readonly PreferredRoutingChannel[];
  compactnessMargin?: number;
  pinEscapeLength?: number;
  endpointTolerance?: number;
  costWeights?: Partial<RouteCostWeights>;
}

export interface RouteRequest {
  netName: string;
  source: RouteEndpoint;
  destination: RouteEndpoint;
  intermediateTerminals?: readonly RouteEndpoint[];
  sheetBounds: Rect;
  componentBounds?: readonly IdentifiedRect[];
  pinTextBounds?: readonly IdentifiedRect[];
  textBounds?: readonly IdentifiedRect[];
  netLabelBounds?: readonly IdentifiedRect[];
  keepouts?: readonly IdentifiedRect[];
  obstacles?: readonly RoutingObstacle[];
  existingWires?: readonly ExistingWire[];
  existingJunctions?: readonly ExistingJunction[];
  sourceDirection?: CardinalDirection;
  destinationDirection?: CardinalDirection;
  netClass?: SchematicNetClass;
  constraints?: RouteConstraints;
}

export type RouteCollisionCode =
  | 'INVALID_INPUT'
  | 'OUT_OF_BOUNDS'
  | 'COMPONENT_BODY'
  | 'PIN_TEXT'
  | 'TEXT'
  | 'NET_LABEL'
  | 'KEEPOUT'
  | 'FOREIGN_NET'
  | 'FOREIGN_NET_COORDINATE'
  | 'ACCIDENTAL_JUNCTION'
  | 'SAME_NET_MERGE_NOT_ALLOWED'
  | 'ZERO_LENGTH'
  | 'NON_ORTHOGONAL'
  | 'DUPLICATE_SEGMENT'
  | 'SELF_INTERSECTION'
  | 'LOOP'
  | 'WRONG_TERMINAL'
  | 'MAX_BENDS_EXCEEDED';

export interface RouteCollision {
  code: RouteCollisionCode;
  severity: 'error' | 'warning';
  message: string;
  point?: Point;
  segmentIndex?: number;
  obstacleId?: string;
  wireId?: string;
}

export interface RouteWarning {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface NetLabelFallback {
  type: 'net-label';
  placements: readonly [
    { point: Point; netName: string; terminal: 'source' },
    { point: Point; netName: string; terminal: 'destination' },
  ];
}

export type RouteStatus = 'routed' | 'fallback' | 'not-found' | 'invalid';

export interface RoutePreviewResult {
  status: RouteStatus;
  valid: boolean;
  netName: string;
  proposedPoints: readonly Point[];
  cost: number;
  bends: number;
  pathLength: number;
  collisions: readonly RouteCollision[];
  warnings: readonly RouteWarning[];
  mergePoints: readonly Point[];
  fallbackUsed: false | 'net-label';
  fallback?: NetLabelFallback;
  routeHash: string;
  deterministicRouteHash: string;
  exploredNodes: number;
  gridSize: number;
}

export interface RouteValidationResult {
  valid: boolean;
  collisions: readonly RouteCollision[];
  mergePoints: readonly Point[];
  bends: number;
  pathLength: number;
}

export interface ResolvedRouteOptions {
  gridSize: number;
  clearance: number;
  foreignWireClearance: number;
  maxBends: number;
  maxSearchNodes: number;
  maxGridCells: number;
  maxObstacles: number;
  maxExistingWires: number;
  maxWireSegments: number;
  maxIntermediateTerminals: number;
  maxCoordinateMagnitude: number;
  allowSameNetMerges: boolean;
  allowedSameNetMergePoints: readonly Point[];
  allowNetLabelFallback: boolean;
  preferredChannels: readonly PreferredRoutingChannel[];
  compactnessMargin: number;
  pinEscapeLength: number;
  endpointTolerance: number;
  costWeights: RouteCostWeights;
}
