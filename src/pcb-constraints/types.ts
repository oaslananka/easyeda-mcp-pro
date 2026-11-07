/**
 * PCB constraints — types for constraint validation output.
 *
 * @module
 */

import type { ConstraintSeverity } from '../circuit/types.js';

// ── Constraint issue codes ─────────────────────────────────────────────────

/** Machine-readable code identifying a PCB constraint check. */
export type PcbConstraintCode =
  | 'PCB_MISSING_OUTLINE'
  | 'PCB_OUTLINE_TOO_SMALL'
  | 'PCB_MISSING_STACKUP'
  | 'PCB_LAYER_COUNT_MISMATCH'
  | 'PCB_MISSING_MOUNTING_HOLES'
  | 'PCB_MISSING_NET_CLASSES'
  | 'PCB_INVALID_CLEARANCE'
  | 'PCB_KEEPOUT_VIOLATION'
  | 'PCB_MISSING_PLACEMENT_ZONES'
  | 'PCB_MISSING_MANUFACTURING_CONSTRAINTS'
  | 'PCB_FIDUCIAL_REQUIRED'
  | 'PCB_HIGH_VOLTAGE_CLEARANCE'
  | 'PCB_DRILL_FILE_MISSING'
  | 'PCB_COPPER_EDGE_CLEARANCE'
  | 'PCB_DRILL_TOO_SMALL'
  | 'PCB_ANNULAR_RING_TOO_SMALL'
  | 'PCB_SOLDERMASK_SLIVER'
  | 'PCB_SILKSCREEN_OVER_PAD'
  | 'PCB_TOOLING_HOLE_MISSING'
  | 'PCB_POLARITY_MARK_MISSING'
  | 'PCB_COMPONENT_SPACING_VIOLATION'
  | 'PCB_TESTPOINT_COVERAGE_LOW'
  | 'PCB_PROGRAMMING_HEADER_MISSING'
  | 'PCB_FAB_NOTES_MISSING'
  | 'PCB_CONSTRAINT_INTERNAL';

// ── Constraint issue ───────────────────────────────────────────────────────

/**
 * A single PCB constraint issue (error or warning).
 *
 * Mirrors the pattern from net-validation/errors.ts.
 */
export interface PcbConstraintIssue {
  /** Machine-readable code. */
  code: PcbConstraintCode;
  /** Human-readable description. */
  message: string;
  /** Dot-notation path to the offending field. */
  path?: string;
  /** Whether this blocks validation or is advisory. */
  severity: 'error' | 'warning';
  /** The constraint type from CircuitIR (electrical, mechanical, pcb-layout, etc.). */
  constraintType?: string;
  /** The severity level from CircuitIR (required, recommended, informational). */
  constraintSeverity?: ConstraintSeverity;
  /** Actionable hint for the user. */
  remediationHint: string;
  /** Additional context. */
  details?: Record<string, unknown>;
}

// ── Validation result ──────────────────────────────────────────────────────

export interface PcbConstraintResult {
  /** True only when there are no blocking errors and no unverifiable rules. */
  valid: boolean;
  /** Issues that block validation. */
  errors: PcbConstraintIssue[];
  /** Advisory issues. */
  warnings: PcbConstraintIssue[];
  /** Rules whose required native/explicit evidence was unavailable. */
  unknownChecks: Array<{ area: string; missingFields: string[] }>;
  /** Summary of how many constraints were checked. */
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    notApplicable: number;
    unknown: number;
  };
}

// ── Input for PCB constraint checks ────────────────────────────────────────

/**
 * Input contract for PCB constraint validation.
 *
 * Designed to be created from a CircuitIR or directly from board inspection
 * data (easyeda_board_layers, easyeda_board_dimensions, etc.).
 */
export interface PcbConstraintInput {
  /** Board dimensions in mm. */
  widthMm?: number;
  heightMm?: number;
  /** Number of copper layers. */
  layerCount?: number;
  /** Independently observed number of copper layers in a stackup, when available. */
  stackupCopperLayerCount?: number;
  /** Whether the board outline is defined. */
  hasOutline?: boolean;
  /** Whether mounting holes are present. */
  mountingHoleCount?: number;
  /** Whether a detailed layer stackup is defined. */
  hasLayerStack?: boolean;
  /** Whether net classes with routing rules are defined. */
  hasNetClasses?: boolean;
  /** Whether clearance rules are defined. */
  hasClearanceRules?: boolean;
  /** Whether keepout areas are defined. */
  hasKeepoutAreas?: boolean;
  /** Whether placement zones are defined. */
  hasPlacementZones?: boolean;
  /** Whether fiducials are defined. */
  hasFiducials?: boolean;
  /** Whether test pads are defined. */
  hasTestPads?: boolean;
  /** Whether the drill/NC drill file is present in the manufacturing package. */
  hasDrillFile?: boolean;
  /** Minimum width across an explicitly enumerated track inventory, mm. Caller-supplied;
   * the sparse native board summary does not establish complete track geometry. */
  minObservedTraceWidthMm?: number;
  /** Minimum projected different-net, same-copper-layer trace-to-trace edge gap, mm.
   * Negative values mean geometrically overlapping copper, not a proven physical short.
   * Caller-supplied; the native summary cannot prove the minimum or DRC clearance. */
  minObservedCopperGapMm?: number;
  /** Minimum copper-to-board-edge clearance observed in mm. */
  minCopperToEdgeMm?: number;
  /** Number of copper-to-edge clearance violations. */
  copperToEdgeViolationCount?: number;
  /** Minimum finished/mechanical drill diameter observed in mm. */
  minDrillMm?: number;
  /** Minimum annular ring observed in mm. */
  minAnnularRingMm?: number;
  /** Minimum soldermask web/sliver observed in mm. */
  minSolderMaskSliverMm?: number;
  /** Count of soldermask sliver violations. */
  solderMaskSliverViolationCount?: number;
  /** Count of silkscreen objects overlapping copper pads. */
  silkscreenOverPadCount?: number;
  /** Number of SMT components requiring assembly alignment. */
  smtComponentCount?: number;
  /** Count of global/local fiducials. Overrides hasFiducials when provided. */
  fiducialCount?: number;
  /** Count of tooling holes for panel/fixture assembly. */
  toolingHoleCount?: number;
  /** Number of polarized/orientation-sensitive components. */
  polarizedComponentCount?: number;
  /** Number of polarized components with explicit polarity/orientation marks. */
  polarityMarkCount?: number;
  /** Count of component courtyard/spacing violations. */
  componentSpacingViolationCount?: number;
  /** Critical nets that should be accessible for bring-up/test. */
  criticalNetNames?: string[];
  /** Nets that have test pads/probes. */
  testPointNets?: string[];
  /** Whether a programming/debug header is present when required. */
  hasProgrammingHeader?: boolean;
  /** Whether this design requires a programming/debug header. */
  requiresProgrammingHeader?: boolean;
  /** Whether fabrication notes are present in the handoff package. */
  hasFabricationNotes?: boolean;
  /** Whether the design contains high-voltage domains. */
  hasHighVoltage?: boolean;
  /** Manufacturing process (lead-free, lead-based, mixed). */
  manufacturingProcess?: string;
  /** Whether a quantity is specified. */
  hasQuantity?: boolean;
}

// ── Constraint report ──────────────────────────────────────────────────────

/**
 * A human-readable explanation of which constraints were applied and
 * which remain manual/unchecked.
 */
export interface ConstraintReport {
  /** Constraint areas that were checked. */
  checked: Array<{
    area: string;
    status: 'passed' | 'failed' | 'not-applicable' | 'unknown';
    details: string;
  }>;
  /** Constraints that cannot be verified automatically (require human review). */
  manualReviewRequired: Array<{
    area: string;
    reason: string;
  }>;
  /** Overall verdict. */
  verdict: 'approved' | 'needs-review' | 'rejected';
}
