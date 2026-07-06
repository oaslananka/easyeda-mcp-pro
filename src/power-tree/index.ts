/** Power-tree analyzer public API. */

export { analyzePowerTree, DEFAULT_LIMITS, requiredBulkCapacitance } from './analysis.js';
export type {
  CapacitorRole,
  PowerCapacitorInput,
  PowerLoadInput,
  PowerProtectionInput,
  PowerRailInput,
  PowerRegulatorInput,
  PowerSourceInput,
  PowerSourceKind,
  PowerTreeInput,
  PowerTreeIssue,
  PowerTreeIssueCode,
  PowerTreeLimits,
  PowerTreeReport,
  PowerTreeSeverity,
  ProtectionKind,
  RailPowerReport,
  RegulatorKind,
  RegulatorThermalReport,
} from './types.js';
