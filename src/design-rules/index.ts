/** Engineering design-rule reference lookups: public API. */

export {
  calculateTraceWidth,
  calculateMaxCurrent,
  COPPER_THICKNESS_MILS_PER_OZ,
} from './trace-width.js';
export type {
  ConductorLayer,
  TraceWidthInput,
  TraceWidthResult,
  MaxCurrentInput,
  MaxCurrentResult,
} from './trace-width.js';

export { lookupClearance } from './clearance.js';
export type { ConductorLocation, ClearanceInput, ClearanceResult } from './clearance.js';

export { lookupProtocolRouting, listProtocolRoutingKeys } from './protocol-routing.js';
export type { ProtocolKey, ProtocolRoutingGuidance } from './protocol-routing.js';

export {
  lookupDecouplingGuidance,
  listDecouplingCategories,
  recommendBulkCapacitance,
} from './decoupling.js';
export type {
  DecouplingCategory,
  PerPinDecouplingGuidance,
  BulkCapacitanceRecommendation,
} from './decoupling.js';

export { listDfmChecklist, getDfmChecklistItem } from './dfm-checklist.js';
export type { DfmCategory, DfmChecklistItem } from './dfm-checklist.js';
