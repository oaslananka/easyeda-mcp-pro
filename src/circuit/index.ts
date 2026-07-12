/**
 * Circuit module — DesignIntent and CircuitIR schemas, compiler, and types.
 *
 * Public API surface for the circuit modeling subsystem.
 *
 * @module
 */

// Errors
export { CircuitError, CircuitErrorCode, fromZodError, validationError } from './errors.js';
export type { CircuitErrorCode as CircuitErrorCodeType, CircuitValidationError } from './errors.js';

// Types
export {
  BoardType,
  ValidationStatus,
  NetType,
  BlockType,
  ConstraintSeverity,
  ConstraintType,
  isValidBoardType,
  isValidBlockType,
} from './types.js';
export type { DesignIntentRef, MetadataEntry } from './types.js';

// DesignIntent
export {
  DesignIntentSchema,
  DESIGN_INTENT_SCHEMA_VERSION,
  validateDesignIntent,
  isDesignIntent,
} from './design-intent.js';
export type { DesignIntent } from './design-intent.js';

// Reference designs
export { UsbIsolatedRs485ReferenceSchema } from './reference-design.js';
export type { UsbIsolatedRs485Reference } from './reference-design.js';

// CircuitIR
export {
  CircuitIRSchema,
  CIRCUIT_IR_SCHEMA_VERSION,
  BlockSchema,
  DeviceSchema,
  NetSchema,
  NetNodeSchema,
  PowerRailSchema,
  InterfaceSchema,
  InterfacePinSchema,
  ConstraintSchema,
  BomIntentSchema,
  PcbIntentSchema,
  ManufacturingIntentSchema,
  validateCircuitIR,
  isCircuitIR,
} from './circuit-ir.js';
export type {
  CircuitIR,
  Block,
  Device,
  Net,
  NetNode,
  PowerRail,
  Interface,
  InterfacePin,
  Constraint,
  BomIntent,
  PcbIntent,
  ManufacturingIntent,
} from './circuit-ir.js';

// Compiler
export { compile, setValidationStatus, isReadyForEasyEDA } from './compiler.js';
export type { CompileOptions, CompileResult } from './compiler.js';

// Component planning
export {
  ROLE_REFDES_PREFIX,
  ROLE_PACKAGE_HINT,
  COMPONENT_PLAN_METADATA_KEYS,
  determineComponentRole,
  planComponents,
  getDeviceRole,
} from './component-planning.js';
export type {
  ComponentRole,
  RoleConfidence,
  ComponentRolePlan,
  ComponentPlanResult,
} from './component-planning.js';
