export type FunctionalBlockKind =
  | 'power-input'
  | 'regulation'
  | 'mcu'
  | 'memory'
  | 'crystal'
  | 'usb'
  | 'motor-driver'
  | 'led-chain'
  | 'connector'
  | 'debug'
  | 'sensor'
  | 'analog-front-end'
  | 'other';

export type LayoutOrientation = 0 | 90 | 180 | 270;
export type LayoutMode = 'preview' | 'dry-run';
export type LayoutSeverity = 'info' | 'warning' | 'error';
export type PinFlowDirection = 'input' | 'output' | 'bidirectional' | 'passive' | 'power';

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutRect extends LayoutPoint {
  width: number;
  height: number;
  id?: string;
}

export interface LayoutSheet {
  width: number;
  height: number;
  origin?: LayoutPoint;
}

export interface LayoutNetEndpoint {
  componentId: string;
  pinId?: string;
  direction?: PinFlowDirection;
}

export interface LayoutNetInput {
  id: string;
  name: string;
  endpoints: LayoutNetEndpoint[];
  isPower?: boolean;
  isGround?: boolean;
}

export interface LayoutComponentInput {
  id: string;
  reference: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  value?: string;
  deviceName?: string;
  description?: string;
  category?: string;
  tags?: string[];
  orientation?: LayoutOrientation;
  preferredOrientation?: LayoutOrientation;
  locked?: boolean;
  blockId?: string;
  unit?: string;
}

export interface ExplicitFunctionalBlock {
  id: string;
  kind: FunctionalBlockKind;
  componentIds: string[];
  title?: string;
  sectionTitle?: string;
  locked?: boolean;
  repeatedGroupId?: string;
  preferredOrientation?: 'horizontal' | 'vertical';
}

export interface DetectedFunctionalBlock {
  id: string;
  kind: FunctionalBlockKind;
  title: string;
  sectionTitle?: string;
  componentIds: string[];
  source: 'explicit' | 'inferred';
  confidence: number;
  locked: boolean;
  repeatedGroupId?: string;
  preferredOrientation: 'horizontal' | 'vertical';
}

export interface LayoutGraphNode {
  id: string;
  component: LayoutComponentInput;
  incomingNetIds: string[];
  outgoingNetIds: string[];
}

export interface LayoutGraphEdge {
  id: string;
  netId: string;
  sourceComponentId: string;
  targetComponentId: string;
  directed: boolean;
}

export interface SchematicLayoutGraph {
  nodes: LayoutGraphNode[];
  edges: LayoutGraphEdge[];
  adjacency: Readonly<Record<string, readonly string[]>>;
}

export interface FunctionalBlockGraphNode {
  blockId: string;
  kind: FunctionalBlockKind;
  componentIds: string[];
  incomingBlockIds: string[];
  outgoingBlockIds: string[];
  flowRank: number;
}

export interface FunctionalBlockGraphEdge {
  id: string;
  netId: string;
  sourceBlockId: string;
  targetBlockId: string;
  directed: boolean;
}

export interface FunctionalBlockGraph {
  nodes: FunctionalBlockGraphNode[];
  edges: FunctionalBlockGraphEdge[];
}

export interface LayoutMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutSafetyLimits {
  maxComponents: number;
  maxNets: number;
  maxBlocks: number;
  maxIterations: number;
}

export interface LayoutConstraints {
  margins?: number | Partial<LayoutMargins>;
  keepouts?: LayoutRect[];
  titleBlockExclusion?: LayoutRect;
  lockedComponentIds?: string[];
  lockedBlockIds?: string[];
  preferredOrientations?: Readonly<Record<string, LayoutOrientation>>;
  minComponentSpacing?: number;
  blockSpacing?: number;
  rowSpacing?: number;
  columnSpacing?: number;
  labelClearance?: number;
  densePinLabelThreshold?: number;
  excessiveEmptySpaceThreshold?: number;
  limits?: Partial<LayoutSafetyLimits>;
}

export interface LayoutOptions {
  inferBlocks?: boolean;
  compact?: boolean;
  resolveOverlaps?: boolean;
  optimizeLabels?: boolean;
}

export interface LayoutPlanInput {
  sheet: LayoutSheet;
  components: LayoutComponentInput[];
  nets?: LayoutNetInput[];
  explicitBlocks?: ExplicitFunctionalBlock[];
  constraints?: LayoutConstraints;
  options?: LayoutOptions;
  mode?: LayoutMode;
  wires?: LayoutWire[];
  labels?: LayoutLabel[];
  texts?: LayoutText[];
}

export interface LayoutPlacement {
  componentId: string;
  reference: string;
  blockId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: LayoutOrientation;
  locked: boolean;
  bbox: LayoutRect;
  reason: string;
}

export interface FunctionalBlockPlacement {
  blockId: string;
  kind: FunctionalBlockKind;
  title: string;
  sectionTitle?: string;
  componentIds: string[];
  repeatedGroupId?: string;
  locked: boolean;
  bbox: LayoutRect;
}

export interface LayoutMoveOperation {
  operation: 'move-component';
  componentId: string;
  from?: LayoutPoint;
  to: LayoutPoint;
  orientation: LayoutOrientation;
  blockId: string;
}

export type LayoutIssueCode =
  | 'INVALID_INPUT'
  | 'LIMIT_EXCEEDED'
  | 'COMPONENT_OVERLAP'
  | 'COMPONENT_IN_KEEPOUT'
  | 'COMPONENT_OUTSIDE_SHEET'
  | 'TEXT_OVERLAP'
  | 'TEXT_OVER_WIRE'
  | 'WIRE_THROUGH_COMPONENT'
  | 'WIRE_CROSSING'
  | 'SECTION_TITLE_MISMATCH'
  | 'EXCESSIVE_EMPTY_SPACE'
  | 'TITLE_BLOCK_OVERLAP'
  | 'DENSE_PIN_LABEL_REGION'
  | 'LOCKED_COMPONENT_POSITION_MISSING'
  | 'LAYOUT_SPACE_EXHAUSTED';

export interface LayoutIssue {
  code: LayoutIssueCode;
  severity: LayoutSeverity;
  message: string;
  entityIds: string[];
  details?: Readonly<Record<string, unknown>>;
}

export interface LayoutWire {
  id: string;
  netId: string;
  points: LayoutPoint[];
}

export interface LayoutLabel extends LayoutRect {
  id: string;
  text: string;
  kind: 'net' | 'pin' | 'section-title' | 'annotation';
  componentId?: string;
  blockId?: string;
}

export interface LayoutText extends LayoutRect {
  id: string;
  text: string;
  kind?: 'section-title' | 'annotation';
  blockId?: string;
}

export interface LayoutQualityMetrics {
  overlapCount: number;
  wireCrossingCount: number;
  averageWireLength: number;
  bendCount: number;
  blockCompactness: number;
  labelCollisionCount: number;
  sheetUtilization: number;
  visualScore: number;
}

export interface VisualLayoutValidation {
  valid: boolean;
  issues: LayoutIssue[];
  metrics: LayoutQualityMetrics;
}

export interface VisualLayoutInput {
  sheet: LayoutSheet;
  placements: LayoutPlacement[];
  blocks?: FunctionalBlockPlacement[];
  wires?: LayoutWire[];
  labels?: LayoutLabel[];
  texts?: LayoutText[];
  constraints?: LayoutConstraints;
}

export interface LayoutPlan {
  mode: LayoutMode;
  applied: false;
  blocked: boolean;
  deterministic: true;
  layoutHash: string;
  graph: SchematicLayoutGraph;
  blockGraph: FunctionalBlockGraph;
  detectedBlocks: DetectedFunctionalBlock[];
  placements: LayoutPlacement[];
  blocks: FunctionalBlockPlacement[];
  labels: LayoutLabel[];
  operations: LayoutMoveOperation[];
  issues: LayoutIssue[];
  validation: VisualLayoutValidation;
  limits: LayoutSafetyLimits;
}

export interface AlignOptions {
  axis: 'x' | 'y';
  value?: number;
  componentIds?: string[];
}

export interface DistributeOptions {
  axis: 'x' | 'y';
  componentIds?: string[];
  start?: number;
  end?: number;
}

export interface CompactLayoutOptions {
  bounds: LayoutRect;
  spacing?: number;
  columns?: number;
  lockedComponentIds?: string[];
}

export interface ResolveOverlapOptions {
  bounds: LayoutRect;
  keepouts?: LayoutRect[];
  spacing?: number;
  lockedComponentIds?: string[];
  maxIterations?: number;
}

export interface LabelOptimizationOptions {
  bounds: LayoutRect;
  clearance?: number;
  maxAttempts?: number;
}
