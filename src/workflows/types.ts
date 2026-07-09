/** Compound schematic workflow planning types. */

export type WorkflowExecutionMode = 'preview' | 'apply';
export type WorkflowSeverity = 'error' | 'warning' | 'info';
export type WorkflowIssueCode =
  | 'WORKFLOW_DUPLICATE_REF'
  | 'WORKFLOW_EMPTY_PIN_CONNECTIONS'
  | 'WORKFLOW_NO_COMPONENTS'
  | 'WORKFLOW_MISSING_ROLE'
  | 'WORKFLOW_DUPLICATE_NET_PORT'
  | 'WORKFLOW_PIN_COLLISION'
  | 'WORKFLOW_SAFE_REGION'
  | 'WORKFLOW_POST_WRITE_QA';

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  severity: WorkflowSeverity;
  message: string;
  remediationHint: string;
  details?: Record<string, unknown>;
}

/** A schematic library device reference, as returned by `schematic.searchDevice`. */
export interface WorkflowDeviceItem {
  libraryUuid: string;
  uuid: string;
}

/** A single pin-to-net connection to apply after a component is placed (or on an existing one). */
export interface WorkflowPinConnection {
  pin: string;
  netName: string;
}

/** One component to place (or reference) as part of a compound workflow. */
export interface WorkflowComponentInput {
  /** Reference designator hint, used only for plan readability and duplicate detection. */
  ref: string;
  /** Free-text role tag surfaced in the plan output (e.g. "regulator", "input-capacitor"). Not interpreted. */
  role: string;
  deviceItem: WorkflowDeviceItem;
  rotation?: number;
  mirror?: boolean;
  subPartName?: string;
  /** Optional placement offset from the workflow anchor. If omitted, the legacy horizontal spacing planner is used. */
  placementOffset?: { dx: number; dy: number };
  pinConnections: WorkflowPinConnection[];
}

/** An existing (already-placed) component's pins to wire, without placing anything new. */
export interface WorkflowExistingComponentInput {
  ref: string;
  role: string;
  primitiveId: string;
  pinConnections: WorkflowPinConnection[];
}

export interface WorkflowNetPortInput {
  netName: string;
  portType?: 'input' | 'output' | 'bidirectional' | 'triState' | 'passive';
  rotation?: number;
}

export interface WorkflowBlockInput {
  projectId: string;
  mode?: WorkflowExecutionMode;
  /** Placement anchor for newly-placed components, in schematic canvas units. */
  anchor: { x: number; y: number };
  /** Horizontal spacing between newly-placed components, in schematic canvas units. */
  spacing?: number;
  components?: WorkflowComponentInput[];
  existingComponents?: WorkflowExistingComponentInput[];
  netPorts?: WorkflowNetPortInput[];
  netPortAnchor?: { x: number; y: number };
}

export type WorkflowOperation =
  | {
      kind: 'placeComponent';
      ref: string;
      role: string;
      method: 'schematic.placeComponent';
      params: Record<string, unknown>;
    }
  | {
      kind: 'connectPinToNet';
      ref: string;
      role: string;
      method: 'schematic.connectPinToNet';
      params: Record<string, unknown>;
    }
  | {
      kind: 'createNetPort';
      netName: string;
      method: 'schematic.createNetPort';
      params: Record<string, unknown>;
    };

export interface WorkflowPlannedComponent {
  ref: string;
  role: string;
  x: number;
  y: number;
}

export interface WorkflowPlan {
  projectId: string;
  transactionId: string;
  mode: WorkflowExecutionMode;
  blocked: boolean;
  placements: WorkflowPlannedComponent[];
  operations: WorkflowOperation[];
  issues: WorkflowIssue[];
  summary: string;
  /** Notes on what rollback can and cannot undo for this specific plan. */
  rollbackNotes: string[];
}
