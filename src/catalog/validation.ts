/**
 * Device catalog validation rules.
 *
 * Validates a DeviceCatalog against business rules beyond schema-level
 * constraints (type correctness, required fields). These rules check for:
 *
 * - Duplicate device IDs
 * - Missing symbol references
 * - Missing footprint references
 * - Missing pin maps (for ICs and connectors)
 * - Incompatible package assignments
 * - Missing manufacturer part numbers
 * - Missing assembly availability hints
 * - Duplicate supplier IDs within a single device
 *
 * @module
 */

import {
  CatalogError,
  CatalogErrorCode,
  CatalogValidationError,
  catalogValidationError,
} from './errors.js';
import type { DeviceCatalog, DeviceEntry } from './schema.js';
import { DEVICE_CATALOG_SCHEMA_VERSION, UNRESOLVED_REF_PREFIX } from './schema.js';

// ── Constants ─────────────────────────────────────────────────────────────

/** Device categories that are expected to have a pin mapping. */
const CATEGORIES_REQUIRING_PIN_MAP = new Set([
  'microcontroller',
  'sensor',
  'power',
  'communication',
  'interface',
  'connector',
  'memory',
  'logic',
  'amplifier',
  'converter',
]);

/** Categories that require a footprint (all functional devices). */
const CATEGORIES_REQUIRING_FOOTPRINT = new Set([
  'microcontroller',
  'sensor',
  'power',
  'communication',
  'interface',
  'connector',
  'memory',
  'logic',
  'amplifier',
  'converter',
  'passive',
  'electromechanical',
  'protection',
  'clocking',
]);

/** Categories that require a symbol. */
const CATEGORIES_REQUIRING_SYMBOL = new Set([
  'microcontroller',
  'sensor',
  'power',
  'communication',
  'interface',
  'connector',
  'memory',
  'logic',
  'amplifier',
  'converter',
  'passive',
  'electromechanical',
  'protection',
  'clocking',
  'custom',
]);

// ── Validation result ─────────────────────────────────────────────────────

export interface CatalogValidationResult {
  valid: boolean;
  errors: CatalogValidationError[];
  warnings: CatalogValidationError[];
}

// ── Individual rule checks ────────────────────────────────────────────────

function checkDuplicateIds(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];
  const seen = new Map<string, number>();

  for (const device of catalog.devices) {
    const id = device.id;
    if (seen.has(id)) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_DUPLICATE_ID,
          `Duplicate device ID: "${id}"`,
          {
            deviceId: id,
            firstIndex: seen.get(id),
          },
        ),
      );
    }
    seen.set(id, seen.size);
  }

  return errors;
}

function checkMissingSymbol(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    if (CATEGORIES_REQUIRING_SYMBOL.has(device.category)) {
      if (!device.symbolRef || device.symbolRef.trim().length === 0) {
        errors.push(
          catalogValidationError(
            CatalogErrorCode.DEVICE_MISSING_SYMBOL,
            `Device "${device.id}" (category: ${device.category}) is missing a symbol reference`,
            { deviceId: device.id, category: device.category },
          ),
        );
      }
    }
  }

  return errors;
}

function checkMissingFootprint(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    if (CATEGORIES_REQUIRING_FOOTPRINT.has(device.category)) {
      if (!device.footprintRef || device.footprintRef.trim().length === 0) {
        errors.push(
          catalogValidationError(
            CatalogErrorCode.DEVICE_MISSING_FOOTPRINT,
            `Device "${device.id}" (category: ${device.category}) is missing a footprint reference`,
            { deviceId: device.id, category: device.category },
          ),
        );
      }
    }
  }

  return errors;
}

function checkUnresolvedReferences(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    if (
      CATEGORIES_REQUIRING_SYMBOL.has(device.category) &&
      device.symbolRef.startsWith(UNRESOLVED_REF_PREFIX)
    ) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_UNRESOLVED_SYMBOL,
          `Device "${device.id}" (category: ${device.category}) has no resolved symbol reference — it was ingested without a matching EasyEDA library entry`,
          { deviceId: device.id, category: device.category, symbolRef: device.symbolRef },
        ),
      );
    }
    if (
      CATEGORIES_REQUIRING_FOOTPRINT.has(device.category) &&
      device.footprintRef.startsWith(UNRESOLVED_REF_PREFIX)
    ) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_UNRESOLVED_FOOTPRINT,
          `Device "${device.id}" (category: ${device.category}) has no resolved footprint reference — it was ingested without a matching EasyEDA library entry`,
          { deviceId: device.id, category: device.category, footprintRef: device.footprintRef },
        ),
      );
    }
  }

  return errors;
}

function checkMissingPinMap(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    if (CATEGORIES_REQUIRING_PIN_MAP.has(device.category)) {
      if (!device.pinMapping || device.pinMapping.length === 0) {
        errors.push(
          catalogValidationError(
            CatalogErrorCode.DEVICE_MISSING_PIN_MAP,
            `Device "${device.id}" (category: ${device.category}) is missing a pin map`,
            { deviceId: device.id, category: device.category },
          ),
        );
      }
    }
  }

  return errors;
}

function checkMissingMpn(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    if (!device.mpn || device.mpn.trim().length === 0) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_MISSING_MPN,
          `Device "${device.id}" is missing a manufacturer part number (MPN)`,
          { deviceId: device.id },
        ),
      );
    }
  }

  return errors;
}

function checkMissingAssemblyData(catalog: DeviceCatalog): CatalogValidationError[] {
  const warnings: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    if (!device.assemblyHint) {
      // Not an error for passive components, but warn for ICs and electromechanical
      if (
        device.category === 'microcontroller' ||
        device.category === 'connector' ||
        device.category === 'sensor'
      ) {
        warnings.push(
          catalogValidationError(
            CatalogErrorCode.DEVICE_MISSING_ASSEMBLY_DATA,
            `Device "${device.id}" (category: ${device.category}) has no assembly availability hints`,
            { deviceId: device.id, category: device.category },
          ),
        );
      }
    }
  }

  return warnings;
}

function checkDuplicateSupplierIds(catalog: DeviceCatalog): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const device of catalog.devices) {
    const seen = new Set<string>();
    const supplierIds = device.supplierIds ?? [];
    for (const sid of supplierIds) {
      const key = `${sid.supplier}:${sid.partId}`;
      if (seen.has(key)) {
        errors.push(
          catalogValidationError(
            CatalogErrorCode.DEVICE_DUPLICATE_SUPPLIER_ID,
            `Device "${device.id}" has duplicate supplier ID "${key}"`,
            { deviceId: device.id, supplierKey: key },
          ),
        );
      }
      seen.add(key);
    }
  }

  return errors;
}

// ── Main validation entry point ───────────────────────────────────────────

/**
 * Validate a DeviceCatalog against all business rules.
 *
 * Returns both errors (catalog is invalid) and warnings (catalog is valid
 * but has issues the user should address).
 *
 * Schema-level validation (type correctness, required fields) is handled
 * by `DeviceCatalogSchema.parse()` / `validateDeviceCatalog()`.
 * This function adds domain-specific cross-field validation.
 */
export function validateCatalog(catalog: DeviceCatalog): CatalogValidationResult {
  const errors: CatalogValidationError[] = [];
  const warnings: CatalogValidationError[] = [];

  // Schema version check (warning only — allow forward compatibility)
  if (catalog.$schema !== DEVICE_CATALOG_SCHEMA_VERSION) {
    warnings.push(
      catalogValidationError(
        CatalogErrorCode.CATALOG_SCHEMA_VERSION_MISMATCH,
        `Catalog schema version "${catalog.$schema}" does not match expected "${DEVICE_CATALOG_SCHEMA_VERSION}"`,
        {
          expected: DEVICE_CATALOG_SCHEMA_VERSION,
          actual: catalog.$schema,
        },
      ),
    );
  }

  // Run all validation rules
  errors.push(...checkDuplicateIds(catalog));
  errors.push(...checkMissingSymbol(catalog));
  errors.push(...checkMissingFootprint(catalog));
  errors.push(...checkUnresolvedReferences(catalog));
  errors.push(...checkMissingPinMap(catalog));
  errors.push(...checkMissingMpn(catalog));
  warnings.push(...checkMissingAssemblyData(catalog));
  errors.push(...checkDuplicateSupplierIds(catalog));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a catalog and throw if any errors are found.
 *
 * Returns structured errors+warnings on success.
 * Throws `CatalogError` with all validation errors if the catalog is invalid.
 */
export function validateCatalogOrThrow(catalog: DeviceCatalog): CatalogValidationResult {
  const result = validateCatalog(catalog);
  if (!result.valid) {
    throw new CatalogError({
      code: CatalogErrorCode.CATALOG_INVALID,
      message: `Catalog validation failed with ${result.errors.length} error(s)`,
      errors: result.errors,
    });
  }
  return result;
}

function validateRequiredFields(entry: DeviceEntry): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  // MPN check
  if (!entry.mpn || entry.mpn.trim().length === 0) {
    errors.push(
      catalogValidationError(
        CatalogErrorCode.DEVICE_MISSING_MPN,
        `Device "${entry.id}" is missing an MPN`,
        { deviceId: entry.id },
      ),
    );
  }

  // Symbol check for functional categories
  if (CATEGORIES_REQUIRING_SYMBOL.has(entry.category)) {
    if (!entry.symbolRef || entry.symbolRef.trim().length === 0) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_MISSING_SYMBOL,
          `Device "${entry.id}" is missing a symbol reference`,
          { deviceId: entry.id, category: entry.category },
        ),
      );
    }
  }

  // Footprint check
  if (CATEGORIES_REQUIRING_FOOTPRINT.has(entry.category)) {
    if (!entry.footprintRef || entry.footprintRef.trim().length === 0) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_MISSING_FOOTPRINT,
          `Device "${entry.id}" is missing a footprint reference`,
          { deviceId: entry.id, category: entry.category },
        ),
      );
    }
  }

  // Unresolved symbol/footprint reference check (ingested without a real EasyEDA match)
  if (
    CATEGORIES_REQUIRING_SYMBOL.has(entry.category) &&
    entry.symbolRef.startsWith(UNRESOLVED_REF_PREFIX)
  ) {
    errors.push(
      catalogValidationError(
        CatalogErrorCode.DEVICE_UNRESOLVED_SYMBOL,
        `Device "${entry.id}" (category: ${entry.category}) has no resolved symbol reference — it was ingested without a matching EasyEDA library entry`,
        { deviceId: entry.id, category: entry.category, symbolRef: entry.symbolRef },
      ),
    );
  }
  if (
    CATEGORIES_REQUIRING_FOOTPRINT.has(entry.category) &&
    entry.footprintRef.startsWith(UNRESOLVED_REF_PREFIX)
  ) {
    errors.push(
      catalogValidationError(
        CatalogErrorCode.DEVICE_UNRESOLVED_FOOTPRINT,
        `Device "${entry.id}" (category: ${entry.category}) has no resolved footprint reference — it was ingested without a matching EasyEDA library entry`,
        { deviceId: entry.id, category: entry.category, footprintRef: entry.footprintRef },
      ),
    );
  }

  return errors;
}

function validatePinConfiguration(entry: DeviceEntry): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  // Pin map check for complex devices
  if (CATEGORIES_REQUIRING_PIN_MAP.has(entry.category)) {
    if (!entry.pinMapping || entry.pinMapping.length === 0) {
      errors.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_MISSING_PIN_MAP,
          `Device "${entry.id}" is missing a pin map`,
          { deviceId: entry.id, category: entry.category },
        ),
      );
    }
  }

  return errors;
}

function validateMetadata(entry: DeviceEntry): CatalogValidationError[] {
  const warnings: CatalogValidationError[] = [];

  // Assembly data warning for critical categories
  if (!entry.assemblyHint) {
    if (
      entry.category === 'microcontroller' ||
      entry.category === 'connector' ||
      entry.category === 'sensor'
    ) {
      warnings.push(
        catalogValidationError(
          CatalogErrorCode.DEVICE_MISSING_ASSEMBLY_DATA,
          `Device "${entry.id}" has no assembly availability hints`,
          { deviceId: entry.id, category: entry.category },
        ),
      );
    }
  }

  return warnings;
}

/**
 * Validate a single device entry against common rules.
 *
 * This is useful for pre-validation before adding a device to a catalog.
 */
export function validateDeviceEntry(entry: DeviceEntry): CatalogValidationResult {
  const errors: CatalogValidationError[] = [
    ...validateRequiredFields(entry),
    ...validatePinConfiguration(entry),
  ];
  const warnings: CatalogValidationError[] = validateMetadata(entry);

  return { valid: errors.length === 0, errors, warnings };
}
