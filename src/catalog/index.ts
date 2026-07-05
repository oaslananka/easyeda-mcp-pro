/**
 * Device Catalog module — verified device library with schema, validation,
 * and starter entries for EasyEDA Pro project design.
 *
 * Public API surface for the device catalog subsystem.
 *
 * @module
 */

// Errors
export { CatalogError, CatalogErrorCode, catalogValidationError, fromZodError } from './errors.js';
export type { CatalogErrorCode as CatalogErrorCodeType, CatalogValidationError } from './errors.js';

// Schema
export {
  DEVICE_CATALOG_SCHEMA_VERSION,
  UNRESOLVED_REF_PREFIX,
  DeviceCatalogSchema,
  DeviceEntrySchema,
  LifecycleStatusSchema,
  AssemblyHintSchema,
  ElectricalParamSchema,
  PinMappingSchema,
  SupplierIdSchema,
  Model3DRefSchema,
  validateDeviceCatalog,
  validateDeviceEntry,
  isDeviceCatalog,
  isDeviceEntry,
} from './schema.js';
export type {
  DeviceCatalog,
  DeviceEntry,
  LifecycleStatus,
  AssemblyHint,
  ElectricalParam,
  PinMapping,
  SupplierId,
  Model3DRef,
} from './schema.js';

// Validation
export {
  validateCatalog,
  validateCatalogOrThrow,
  validateDeviceEntry as validateSingleEntry,
} from './validation.js';
export type { CatalogValidationResult } from './validation.js';

// Starter catalog
export { STARTER_DEVICE_CATALOG } from './starter.js';

// Ingestion pipeline
export { ingestDeviceFromLcsc } from './ingest.js';
export type { IngestResult, IngestStatus } from './ingest.js';
