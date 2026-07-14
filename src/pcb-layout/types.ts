/** High-level PCB layout planning types. */

export type LayoutExecutionMode = 'preview' | 'apply';
export type LayoutSeverity = 'error' | 'warning' | 'info';
export type LayoutIssueCode =
  | 'LAYOUT_COMPONENT_OUTSIDE_BOARD'
  | 'LAYOUT_COMPONENT_IN_KEEPOUT'
  | 'LAYOUT_COMPONENT_COLLISION'
  | 'LAYOUT_COMPONENT_NOT_ON_BOARD'
  | 'LAYOUT_INVALID_COMPONENT'
  | 'LAYOUT_INVALID_BOARD'
  | 'LAYOUT_PATH_TOO_SHORT'
  | 'LAYOUT_PATH_OUTSIDE_BOARD'
  | 'LAYOUT_PATH_IN_KEEPOUT'
  | 'LAYOUT_PATH_TOO_LONG'
  | 'LAYOUT_TRACE_WIDTH_TOO_SMALL';

export interface PointMm {
  x: number;
  y: number;
}

export interface BoardBox {
  widthMm: number;
  heightMm: number;
}

export interface RectMm {
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  name?: string;
}

export interface LayoutIssue {
  code: LayoutIssueCode;
  severity: LayoutSeverity;
  message: string;
  remediationHint: string;
  details?: Record<string, unknown>;
}

export interface ComponentPlacementInput {
  ref: string;
  primitiveId?: string;
  footprint?: string;
  widthMm: number;
  heightMm: number;
  rotation?: number;
  fixed?: boolean;
}

export interface ComponentGroupPlacementInput {
  projectId?: string;
  mode?: LayoutExecutionMode;
  board: BoardBox;
  anchor: PointMm;
  columns?: number;
  spacingMm?: number;
  layer?: number;
  minSpacingMm?: number;
  components: ComponentPlacementInput[];
  keepouts?: RectMm[];
  confirmWrite?: boolean;
}

export interface PlannedComponentPlacement {
  ref: string;
  primitiveId?: string;
  footprint?: string;
  x: number;
  y: number;
  rotation: number;
  layer: number;
  widthMm: number;
  heightMm: number;
  bbox: RectMm;
}

export interface ComponentGroupPlacementPlan {
  transactionId: string;
  projectId: string;
  mode: LayoutExecutionMode;
  applied: boolean;
  blocked: boolean;
  placements: PlannedComponentPlacement[];
  operations: Array<{ method: string; params: Record<string, unknown> }>;
  issues: LayoutIssue[];
  summary: string;
}

export interface RoutePathInput {
  projectId?: string;
  mode?: LayoutExecutionMode;
  board?: BoardBox;
  netName: string;
  layer: number;
  widthMm: number;
  waypoints: PointMm[];
  keepouts?: RectMm[];
  maxLengthMm?: number;
  minWidthMm?: number;
  confirmWrite?: boolean;
}

export interface RoutePathPlan {
  transactionId: string;
  projectId: string;
  mode: LayoutExecutionMode;
  applied: boolean;
  blocked: boolean;
  netName: string;
  layer: number;
  widthMm: number;
  pathLengthMm: number;
  operations: Array<{ method: string; params: Record<string, unknown> }>;
  issues: LayoutIssue[];
  summary: string;
}
