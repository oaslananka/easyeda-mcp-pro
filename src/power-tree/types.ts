/**
 * Power-tree analyzer types.
 *
 * Models sources, regulators, rails, loads, protection devices, and bulk
 * capacitance so agents can reason about current margin, dropout, and thermal
 * risk before committing a circuit or PCB handoff.
 *
 * @module
 */

export type PowerSourceKind =
  'usb' | 'battery' | 'barrel-jack' | 'bench' | 'ac-dc' | 'external' | 'custom';

export type RegulatorKind =
  'ldo' | 'linear' | 'buck' | 'boost' | 'buck-boost' | 'load-switch' | 'custom';

export type ProtectionKind =
  | 'fuse'
  | 'polyfuse'
  | 'tvs'
  | 'reverse-polarity'
  | 'ideal-diode'
  | 'current-limit'
  | 'esd'
  | 'custom';

export type CapacitorRole = 'bulk' | 'input' | 'output' | 'decoupling' | 'hold-up' | 'custom';

export type PowerTreeSeverity = 'error' | 'warning' | 'info';

export type PowerTreeIssueCode =
  | 'POWER_RAIL_OVERCURRENT'
  | 'POWER_RAIL_LOW_MARGIN'
  | 'POWER_SOURCE_MISSING_PROTECTION'
  | 'POWER_MISSING_BULK_CAPACITANCE'
  | 'POWER_REGULATOR_OVERLOAD'
  | 'POWER_REGULATOR_DROPOUT'
  | 'POWER_REGULATOR_THERMAL_RISK'
  | 'POWER_REGULATOR_THERMAL_OVER_LIMIT'
  | 'POWER_SEQUENCE_MISSING'
  | 'POWER_TREE_INTERNAL';

export interface PowerRailInput {
  id: string;
  name: string;
  voltage: number;
  /** Maximum current capacity for this rail when known. */
  maxCurrentA?: number;
  /** Optional explicit source ids driving this rail. */
  sourceRefs?: string[];
  /** Optional explicit regulator ids driving this rail. */
  regulatorRefs?: string[];
  /** Whether this rail is externally accessible or directly fed from outside the board. */
  external?: boolean;
  /** Whether this rail is safety-critical or expected to be protected. */
  requiresProtection?: boolean;
  /** Whether bulk capacitance is expected on this rail. */
  requiresBulkCapacitance?: boolean;
  /** Optional sequencing dependency: this rail should come up after listed rail ids. */
  sequenceAfterRailRefs?: string[];
}

export interface PowerSourceInput {
  id: string;
  name?: string;
  kind: PowerSourceKind;
  railId: string;
  voltage: number;
  maxCurrentA?: number;
  currentLimitA?: number;
  requiresProtection?: boolean;
}

export interface PowerRegulatorInput {
  id: string;
  ref?: string;
  kind: RegulatorKind;
  inputRailId: string;
  outputRailId: string;
  inputVoltage?: number;
  outputVoltage?: number;
  maxOutputCurrentA?: number;
  currentLimitA?: number;
  dropoutVoltage?: number;
  efficiency?: number;
  quiescentCurrentA?: number;
  thermalResistanceCPerW?: number;
  maxJunctionTempC?: number;
  package?: string;
}

export interface PowerLoadInput {
  id: string;
  ref?: string;
  railId: string;
  currentA: number;
  peakCurrentA?: number;
  category?: string;
  required?: boolean;
}

export interface PowerProtectionInput {
  id: string;
  railId: string;
  kind: ProtectionKind;
  ref?: string;
  currentRatingA?: number;
  location?: 'input' | 'output' | 'rail' | 'connector';
}

export interface PowerCapacitorInput {
  id: string;
  railId: string;
  ref?: string;
  capacitanceUf: number;
  role: CapacitorRole;
  voltageRating?: number;
}

export interface PowerTreeLimits {
  /** Warning threshold for available-current margin. Default: 20%. */
  minCurrentMarginPercent?: number;
  /** Warning threshold for junction temperature margin. Default: 20°C. */
  minThermalMarginC?: number;
  /** Default ambient temperature. Default: 25°C. */
  ambientTempC?: number;
  /** Default minimum bulk capacitance per ampere. Default: 47µF/A. */
  minBulkCapacitanceUfPerA?: number;
  /** Default bulk capacitance floor when a rail requires bulk capacitance. Default: 10µF. */
  minBulkCapacitanceUf?: number;
}

export interface PowerTreeInput {
  projectId?: string;
  rails: PowerRailInput[];
  sources?: PowerSourceInput[];
  regulators?: PowerRegulatorInput[];
  loads?: PowerLoadInput[];
  protections?: PowerProtectionInput[];
  capacitors?: PowerCapacitorInput[];
  limits?: PowerTreeLimits;
}

export interface PowerTreeIssue {
  code: PowerTreeIssueCode;
  severity: PowerTreeSeverity;
  message: string;
  railId?: string;
  railName?: string;
  componentRef?: string;
  remediationHint: string;
  details?: Record<string, unknown>;
}

export interface RailPowerReport {
  railId: string;
  railName: string;
  voltage: number;
  loadCurrentA: number;
  peakCurrentA: number;
  availableCurrentA?: number;
  marginA?: number;
  marginPercent?: number;
  loadCount: number;
  sourceRefs: string[];
  regulatorRefs: string[];
  protectionRefs: string[];
  bulkCapacitanceUf: number;
  requiredBulkCapacitanceUf?: number;
  passed: boolean;
}

export interface RegulatorThermalReport {
  regulatorId: string;
  ref?: string;
  kind: RegulatorKind;
  inputRailId: string;
  outputRailId: string;
  inputVoltage: number;
  outputVoltage: number;
  outputCurrentA: number;
  maxOutputCurrentA?: number;
  currentMarginA?: number;
  currentMarginPercent?: number;
  dropoutMarginV?: number;
  estimatedDissipationW?: number;
  estimatedJunctionTempC?: number;
  thermalMarginC?: number;
  passed: boolean;
}

export interface PowerTreeSummary {
  railCount: number;
  sourceCount: number;
  regulatorCount: number;
  loadCount: number;
  totalLoadCurrentA: number;
  totalPeakCurrentA: number;
  errorCount: number;
  warningCount: number;
  passed: boolean;
  humanSummary: string;
}

export interface PowerTreeReport {
  projectId: string;
  passed: boolean;
  rails: RailPowerReport[];
  regulators: RegulatorThermalReport[];
  issues: PowerTreeIssue[];
  summary: PowerTreeSummary;
}
