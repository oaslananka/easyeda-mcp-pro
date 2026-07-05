/**
 * DeviceCatalog — versioned, validated device catalog schema.
 *
 * A DeviceCatalog is a curated library of verified device definitions used
 * in EasyEDA Pro projects. Each entry is a "known-good" device with stable
 * catalog IDs, pre-validated symbol/footprint/3D-model references, pin
 * mapping, electrical parameters, lifecycle and assembly hints, and cross-
 * references to supplier databases (LCSC, JLCPCB, Mouser, DigiKey).
 *
 * The catalog is designed to be:
 * 1. **Versioned** — schema version string for forward compatibility.
 * 2. **Validated** — cross-field refs are checked at parse time.
 * 3. **Extensible** — new device classes and suppliers can be added.
 * 4. **Reusable** — CircuitIR devices can be resolved from the catalog.
 *
 * @schema device-catalog/v1
 */

import { z } from 'zod';
import { CatalogError, CatalogErrorCode, fromZodError } from './errors.js';

// ── Schema version ────────────────────────────────────────────────────────

export const DEVICE_CATALOG_SCHEMA_VERSION = 'device-catalog/v1';

/**
 * Prefix used for a `symbolRef`/`footprintRef` value when a device was
 * ingested but the reference could not be resolved to a real EasyEDA
 * library entry (e.g. `LIB_Device.getByLcscIds` found no match). Kept
 * non-empty so it still satisfies `DeviceEntrySchema`'s `.min(1)`
 * constraint, but flagged as invalid by `validateCatalog`/`validateDeviceEntry`
 * for any category that requires a real symbol/footprint — see
 * `src/catalog/validation.ts`.
 */
export const UNRESOLVED_REF_PREFIX = 'UNRESOLVED:';

// ── Sub-schemas ───────────────────────────────────────────────────────────

/**
 * Lifecycle status of a device.
 */
export const LifecycleStatusSchema = z.enum([
  'active',
  'deprecated',
  'obsolete',
  'new',
  'not-recommended',
]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/**
 * Assembly availability hint.
 */
export const AssemblyHintSchema = z.object({
  /** Typical stock availability: 'in-production', 'limited', 'end-of-life', 'contact-factory' */
  status: z.enum(['in-production', 'limited', 'end-of-life', 'contact-factory', 'unknown']),
  /** Minimum order quantity (if applicable) */
  moq: z.number().int().positive().optional(),
  /** Lead time estimate (weeks) */
  leadTimeWeeks: z.number().int().nonnegative().optional(),
  /** Notes about assembly availability */
  notes: z.string().max(256).optional(),
});
export type AssemblyHint = z.infer<typeof AssemblyHintSchema>;

/**
 * Electrical parameter entry (key-value with optional unit).
 */
export const ElectricalParamSchema = z.object({
  name: z.string().min(1).max(64),
  value: z.string().min(1).max(128),
  unit: z.string().max(32).optional(),
  min: z.string().max(64).optional(),
  max: z.string().max(64).optional(),
});
export type ElectricalParam = z.infer<typeof ElectricalParamSchema>;

/**
 * Pin mapping entry.
 */
export const PinMappingSchema = z.object({
  pin: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  type: z
    .enum([
      'power',
      'ground',
      'input',
      'output',
      'bidirectional',
      'analog',
      'open-drain',
      'pass-through',
      'no-connect',
    ])
    .optional(),
  description: z.string().max(256).optional(),
});
export type PinMapping = z.infer<typeof PinMappingSchema>;

/**
 * Supplier ID cross-reference.
 */
export const SupplierIdSchema = z.object({
  /** Supplier name: 'lcsc', 'jlcpcb', 'mouser', 'digikey', 'farnell', etc. */
  supplier: z.string().min(1).max(32),
  /** Part ID at the supplier. */
  partId: z.string().min(1).max(64),
  /** Optional direct URL to the product page. */
  url: z.string().url().optional(),
});
export type SupplierId = z.infer<typeof SupplierIdSchema>;

/**
 * 3D model reference — either a URL/path or an explicit missing marker.
 */
export const Model3DRefSchema = z.union([
  z.string().url(),
  z.literal('__missing__'),
  z.literal(''),
]);
export type Model3DRef = z.infer<typeof Model3DRefSchema>;

/**
 * Single device entry in the catalog.
 */
export const DeviceEntrySchema = z
  .object({
    /** Stable, unique device catalog ID (e.g. "device-esp32-s3-mini-1"). */
    id: z.string().min(1).max(128),

    /** Human-readable display name. */
    displayName: z.string().min(1).max(256),

    /** Functional category / block type the device belongs to. */
    category: z.string().min(1).max(64),

    /** Description of the device's role. */
    description: z.string().max(2048).optional(),

    /**
     * Sub-category for finer classification
     * (e.g. "mcu", "sensor-temperature", "ldo", "connector-usb").
     */
    subCategory: z.string().max(64).optional(),

    // ── EasyEDA references ──────────────────────────────────────────────

    /** EasyEDA symbol library reference (e.g. "SYM:ESP32-S3-MINI-1"). */
    symbolRef: z.string().min(1).max(256),

    /** EasyEDA footprint library reference (e.g. "FOOT:ESP32-S3-MINI-1"). */
    footprintRef: z.string().min(1).max(256),

    /** EasyEDA 3D model reference — URL/path or explicit missing marker. */
    model3dRef: Model3DRefSchema.default('__missing__'),

    // ── Manufacturer info ───────────────────────────────────────────────

    manufacturer: z.string().min(1).max(256),
    mpn: z.string().min(1).max(128),

    /** LCSC part number (e.g. "C123456"). */
    lcsc: z.string().max(32).optional(),

    /** JLCPCB part number if different from LCSC. */
    jlcpcb: z.string().max(32).optional(),

    /** Additional supplier cross-references. */
    supplierIds: z.array(SupplierIdSchema).default([]),

    // ── Package ─────────────────────────────────────────────────────────

    /** Package type description (e.g. "QFN-28_4x4mm_P0.4mm"). */
    package: z.string().min(1).max(128),

    /** Standard IPC/JEDEC package name if applicable. */
    standardPackage: z.string().max(64).optional(),

    // ── Pin mapping ─────────────────────────────────────────────────────

    /** Pin mapping, required for ICs and connectors, optional for passives. */
    pinMapping: z.array(PinMappingSchema).default([]),

    // ── Electrical parameters ───────────────────────────────────────────

    /** Key electrical parameters. */
    electricalParams: z.array(ElectricalParamSchema).default([]),

    // ── Lifecycle and assembly ──────────────────────────────────────────

    lifecycleStatus: LifecycleStatusSchema.default('active'),
    assemblyHint: AssemblyHintSchema.optional(),

    // ── Documentation ───────────────────────────────────────────────────

    /** URL to the device datasheet. */
    datasheetUrl: z.string().url().optional().or(z.literal('')),

    /** URL to the manufacturer product page. */
    productPageUrl: z.string().url().optional().or(z.literal('')),

    // ── Metadata ────────────────────────────────────────────────────────

    /** Arbitrary key-value metadata. */
    metadata: z.array(z.object({ key: z.string(), value: z.string() })).default([]),

    /** Notes free-text. */
    notes: z.string().max(4096).optional(),
  })
  .strict();

export type DeviceEntry = z.infer<typeof DeviceEntrySchema>;

// ── Full catalog schema ───────────────────────────────────────────────────

export const DeviceCatalogSchema = z
  .object({
    $schema: z.literal(DEVICE_CATALOG_SCHEMA_VERSION).default(DEVICE_CATALOG_SCHEMA_VERSION),

    /** List of device entries. */
    devices: z.array(DeviceEntrySchema).default([]),

    metadata: z
      .object({
        version: z.literal('1.0.0').default('1.0.0'),
        name: z.string().max(256).optional(),
        description: z.string().max(2048).optional(),
        updatedAt: z.string().datetime().optional(),
        deviceCount: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (data) => {
      // Check for duplicate device IDs
      const ids = new Set<string>();
      for (const dev of data.devices) {
        if (ids.has(dev.id)) return false;
        ids.add(dev.id);
      }
      return true;
    },
    { message: 'Duplicate device IDs are not allowed', path: ['devices'] },
  )
  .refine(
    (data) => {
      // Check for duplicate supplier IDs per device
      for (const dev of data.devices) {
        const seen = new Set<string>();
        for (const sid of dev.supplierIds) {
          const key = `${sid.supplier}:${sid.partId}`;
          if (seen.has(key)) return false;
          seen.add(key);
        }
      }
      return true;
    },
    { message: 'Duplicate supplier IDs within a single device are not allowed', path: ['devices'] },
  );

export type DeviceCatalog = z.infer<typeof DeviceCatalogSchema>;

// ── Validation helpers ─────────────────────────────────────────────────────

/**
 * Parse and validate an unknown input as a DeviceCatalog.
 *
 * Returns the validated DeviceCatalog on success.
 * Throws `CatalogError` with structured errors on failure.
 */
export function validateDeviceCatalog(input: unknown): DeviceCatalog {
  const result = DeviceCatalogSchema.safeParse(input);
  if (!result.success) {
    const errors = fromZodError(result.error, 'catalog');
    throw new CatalogError({
      code: CatalogErrorCode.CATALOG_INVALID,
      message: 'Device catalog validation failed',
      errors,
    });
  }
  return result.data;
}

/**
 * Parse and validate an unknown input as a single DeviceEntry.
 *
 * Returns the validated DeviceEntry on success.
 * Throws `CatalogError` with structured errors on failure.
 */
export function validateDeviceEntry(input: unknown): DeviceEntry {
  const result = DeviceEntrySchema.safeParse(input);
  if (!result.success) {
    const errors = fromZodError(result.error, 'device');
    throw new CatalogError({
      code: CatalogErrorCode.CATALOG_INVALID,
      message: 'Device entry validation failed',
      errors,
    });
  }
  return result.data;
}

/**
 * Type guard: check whether an unknown value is a valid DeviceCatalog.
 */
export function isDeviceCatalog(value: unknown): value is DeviceCatalog {
  return DeviceCatalogSchema.safeParse(value).success;
}

/**
 * Type guard: check whether an unknown value is a valid DeviceEntry.
 */
export function isDeviceEntry(value: unknown): value is DeviceEntry {
  return DeviceEntrySchema.safeParse(value).success;
}
