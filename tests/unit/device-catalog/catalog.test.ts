import { describe, it, expect } from 'vitest';
import {
  DeviceCatalogSchema,
  DeviceEntrySchema,
  validateDeviceCatalog,
  isDeviceCatalog,
  isDeviceEntry,
  DEVICE_CATALOG_SCHEMA_VERSION,
} from '../../../src/catalog/schema.js';
import {
  validateCatalog,
  validateCatalogOrThrow,
  validateDeviceEntry as validateEntryBusinessRules,
} from '../../../src/catalog/validation.js';
import { CatalogError, CatalogErrorCode } from '../../../src/catalog/errors.js';
import { STARTER_DEVICE_CATALOG } from '../../../src/catalog/starter.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const minimalValidCatalog = {
  $schema: DEVICE_CATALOG_SCHEMA_VERSION,
  devices: [
    {
      id: 'device-esp32-s3',
      displayName: 'ESP32-S3 MCU',
      category: 'microcontroller',
      description: 'Dual-core MCU with Wi-Fi/BLE',
      symbolRef: 'SYM:ESP32-S3',
      footprintRef: 'FOOT:ESP32-S3',
      model3dRef: '__missing__' as const,
      manufacturer: 'Espressif',
      mpn: 'ESP32-S3-MINI-1-N8',
      lcsc: 'C12345678',
      package: 'ESP32-S3-MINI-1',
      pinMapping: [
        { pin: '1', name: '3V3', type: 'power', description: 'Power supply' },
        { pin: '9', name: 'GND', type: 'ground', description: 'Ground' },
      ],
      electricalParams: [],
      lifecycleStatus: 'active' as const,
      datasheetUrl: 'https://example.com/datasheet.pdf',
    },
  ],
  metadata: {
    version: '1.0.0',
    name: 'Test Catalog',
    updatedAt: '2026-06-11T00:00:00.000Z',
  },
};

const minimalDeviceEntry = {
  id: 'device-test',
  displayName: 'Test Device',
  category: 'passive',
  symbolRef: 'SYM:TEST',
  footprintRef: 'FOOT:TEST',
  manufacturer: 'Generic',
  mpn: 'TEST-001',
  package: '0805',
};

// ── Tests: DeviceEntrySchema ───────────────────────────────────────────────

describe('DeviceEntrySchema', () => {
  it('validates a minimal valid device entry', () => {
    const result = DeviceEntrySchema.safeParse(minimalDeviceEntry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('device-test');
      expect(result.data.lifecycleStatus).toBe('active');
      expect(result.data.model3dRef).toBe('__missing__');
    }
  });

  it('rejects a device entry with empty id', () => {
    const result = DeviceEntrySchema.safeParse({ ...minimalDeviceEntry, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a device entry with missing required fields', () => {
    const result = DeviceEntrySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects extra fields via strict mode', () => {
    const result = DeviceEntrySchema.safeParse({
      ...minimalDeviceEntry,
      extraField: 'not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully populated device entry', () => {
    const fullEntry = {
      ...minimalDeviceEntry,
      category: 'sensor',
      subCategory: 'sensor-temperature',
      description: 'A fully populated test sensor device',
      model3dRef: 'https://example.com/model.step',
      jlcpcb: 'C999999',
      supplierIds: [
        { supplier: 'mouser', partId: '123-MOUS' },
        { supplier: 'digikey', partId: '456-DIGI' },
      ],
      standardPackage: 'SOT-23',
      pinMapping: [
        { pin: '1', name: 'VDD', type: 'power', description: 'Supply voltage' },
        { pin: '2', name: 'GND', type: 'ground', description: 'Ground' },
      ],
      electricalParams: [
        { name: 'Supply Voltage', value: '3.3', unit: 'V', min: '3.0', max: '3.6' },
      ],
      lifecycleStatus: 'new' as const,
      assemblyHint: {
        status: 'in-production' as const,
        moq: 1,
        leadTimeWeeks: 4,
        notes: 'Standard availability',
      },
      datasheetUrl: 'https://example.com/datasheet.pdf',
      productPageUrl: 'https://example.com/product',
      metadata: [{ key: 'source', value: 'manufacturer' }],
      notes: 'This is a test device entry',
    };
    const result = DeviceEntrySchema.safeParse(fullEntry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe('sensor');
      expect(result.data.pinMapping).toHaveLength(2);
      expect(result.data.supplierIds).toHaveLength(2);
      expect(result.data.lifecycleStatus).toBe('new');
      expect(result.data.assemblyHint?.status).toBe('in-production');
    }
  });

  it('accepts URL or empty string for datasheetUrl', () => {
    const withUrl = DeviceEntrySchema.safeParse({
      ...minimalDeviceEntry,
      datasheetUrl: 'https://example.com/ds.pdf',
    });
    expect(withUrl.success).toBe(true);

    const withEmpty = DeviceEntrySchema.safeParse({ ...minimalDeviceEntry, datasheetUrl: '' });
    expect(withEmpty.success).toBe(true);
  });

  it('accepts model3dRef as URL or __missing__ or empty', () => {
    const urlRef = DeviceEntrySchema.safeParse({
      ...minimalDeviceEntry,
      model3dRef: 'https://example.com/model.step',
    });
    expect(urlRef.success).toBe(true);

    const missingRef = DeviceEntrySchema.safeParse({
      ...minimalDeviceEntry,
      model3dRef: '__missing__' as const,
    });
    expect(missingRef.success).toBe(true);

    const emptyRef = DeviceEntrySchema.safeParse({ ...minimalDeviceEntry, model3dRef: '' });
    expect(emptyRef.success).toBe(true);
  });
});

// ── Tests: DeviceCatalogSchema ─────────────────────────────────────────────

describe('DeviceCatalogSchema', () => {
  it('validates a minimal valid catalog', () => {
    const result = DeviceCatalogSchema.safeParse(minimalValidCatalog);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.$schema).toBe(DEVICE_CATALOG_SCHEMA_VERSION);
      expect(result.data.devices).toHaveLength(1);
      expect(result.data.metadata?.name).toBe('Test Catalog');
    }
  });

  it('accepts empty object with defaults applied', () => {
    const result = DeviceCatalogSchema.safeParse({});
    // $schema defaults to DEVICE_CATALOG_SCHEMA_VERSION, devices defaults to []
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.$schema).toBe(DEVICE_CATALOG_SCHEMA_VERSION);
      expect(result.data.devices).toHaveLength(0);
    }
  });

  it('rejects extra fields via strict mode', () => {
    const invalid = { ...minimalValidCatalog, extraField: 'not allowed' };
    const result = DeviceCatalogSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects catalog with duplicate device IDs', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [
        ...minimalValidCatalog.devices,
        { ...minimalValidCatalog.devices[0] }, // duplicate ID
      ],
    };
    const result = DeviceCatalogSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects catalog with duplicate supplier IDs within a device', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [
        {
          ...minimalValidCatalog.devices[0],
          supplierIds: [
            { supplier: 'mouser', partId: '123' },
            { supplier: 'mouser', partId: '123' }, // duplicate
          ],
        },
      ],
    };
    const result = DeviceCatalogSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts catalog with starter entries', () => {
    const catalog = {
      $schema: DEVICE_CATALOG_SCHEMA_VERSION,
      devices: STARTER_DEVICE_CATALOG,
    };
    const result = DeviceCatalogSchema.safeParse(catalog);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.devices).toHaveLength(STARTER_DEVICE_CATALOG.length);
    }
  });

  it('accepts catalog with empty devices array', () => {
    const empty = {
      $schema: DEVICE_CATALOG_SCHEMA_VERSION,
      devices: [],
    };
    const result = DeviceCatalogSchema.safeParse(empty);
    expect(result.success).toBe(true);
  });

  it('accepts catalog without optional metadata', () => {
    const noMeta = {
      $schema: DEVICE_CATALOG_SCHEMA_VERSION,
      devices: minimalValidCatalog.devices,
    };
    const result = DeviceCatalogSchema.safeParse(noMeta);
    expect(result.success).toBe(true);
  });
});

// ── Tests: validateDeviceCatalog ──────────────────────────────────────────

describe('validateDeviceCatalog', () => {
  it('returns validated catalog on valid input', () => {
    const result = validateDeviceCatalog(minimalValidCatalog);
    expect(result.devices).toHaveLength(1);
    expect(result.$schema).toBe(DEVICE_CATALOG_SCHEMA_VERSION);
  });

  it('throws CatalogError on invalid input', () => {
    expect(() => validateDeviceCatalog({ devices: 'not-an-array' })).toThrow(CatalogError);
  });

  it('throws CatalogError on empty input without defaults', () => {
    // Only throws if we pass something that can't satisfy the schema even with defaults
    expect(() => validateDeviceCatalog(null)).toThrow(CatalogError);
  });

  it('throws CatalogError with CATALOG_INVALID code on broken data', () => {
    try {
      validateDeviceCatalog({ devices: 'not-an-array' });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogError);
      expect((err as CatalogError).code).toBe(CatalogErrorCode.CATALOG_INVALID);
      expect((err as CatalogError).errors.length).toBeGreaterThan(0);
    }
  });
});

// ── Tests: isDeviceCatalog / isDeviceEntry ─────────────────────────────────

describe('isDeviceCatalog', () => {
  it('returns true for valid catalog', () => {
    expect(isDeviceCatalog(minimalValidCatalog)).toBe(true);
  });

  it('returns false for invalid input', () => {
    expect(isDeviceCatalog(null)).toBe(false);
    // {} itself is valid (defaults fill $schema/devices), but unrelated types should fail
    expect(isDeviceCatalog('hello')).toBe(false);
    expect(isDeviceCatalog(42)).toBe(false);
    expect(isDeviceCatalog([])).toBe(false);
  });
});

describe('isDeviceEntry', () => {
  it('returns true for valid device entry', () => {
    expect(isDeviceEntry(minimalDeviceEntry)).toBe(true);
  });

  it('returns false for invalid input', () => {
    expect(isDeviceEntry(null)).toBe(false);
    expect(isDeviceEntry({})).toBe(false);
    expect(isDeviceEntry(42)).toBe(false);
  });
});

// ── Tests: validateCatalog (business validation) ──────────────────────────

describe('validateCatalog (business rules)', () => {
  it('returns valid=true for a catalog with no issues', () => {
    const result = validateCatalog(minimalValidCatalog);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects duplicate device IDs', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [
        ...minimalValidCatalog.devices,
        { ...minimalValidCatalog.devices[0], displayName: 'Duplicate' },
      ],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_DUPLICATE_ID')).toBe(true);
  });

  it('detects missing symbol references', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [{ ...minimalValidCatalog.devices[0], symbolRef: '' }],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_MISSING_SYMBOL')).toBe(true);
  });

  it('detects missing footprint references', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [{ ...minimalValidCatalog.devices[0], footprintRef: '' }],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_MISSING_FOOTPRINT')).toBe(true);
  });

  it('detects missing pin map for microcontroller category', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [{ ...minimalValidCatalog.devices[0], pinMapping: [] }],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_MISSING_PIN_MAP')).toBe(true);
  });

  it('does not require pin map for passive devices', () => {
    const passive = {
      ...minimalValidCatalog,
      devices: [
        {
          id: 'device-resistor',
          displayName: 'Resistor',
          category: 'passive',
          symbolRef: 'SYM:RES',
          footprintRef: 'FOOT:RES',
          manufacturer: 'Generic',
          mpn: 'RES-001',
          package: '0805',
          pinMapping: [],
        },
      ],
    };
    const result = validateCatalog(passive);
    // Passives are not in CATEGORIES_REQUIRING_PIN_MAP
    expect(result.valid).toBe(true);
  });

  it('detects missing MPN', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [{ ...minimalValidCatalog.devices[0], mpn: '' }],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_MISSING_MPN')).toBe(true);
  });

  it('detects duplicate supplier IDs', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [
        {
          ...minimalValidCatalog.devices[0],
          supplierIds: [
            { supplier: 'mouser', partId: '123' },
            { supplier: 'mouser', partId: '123' },
          ],
        },
      ],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_DUPLICATE_SUPPLIER_ID')).toBe(true);
  });

  it('generates warnings for missing assembly data on critical categories', () => {
    const noAssembly = {
      ...minimalValidCatalog,
      devices: [
        {
          ...minimalValidCatalog.devices[0],
          category: 'sensor',
          assemblyHint: undefined,
        },
      ],
    };
    const result = validateCatalog(noAssembly);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.code === 'DEVICE_MISSING_ASSEMBLY_DATA')).toBe(true);
  });

  it('throws on invalid catalog via validateCatalogOrThrow', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [
        ...minimalValidCatalog.devices,
        { ...minimalValidCatalog.devices[0] }, // duplicate
      ],
    };
    expect(() => validateCatalogOrThrow(invalid)).toThrow(CatalogError);
  });

  it('passes on valid catalog via validateCatalogOrThrow', () => {
    const result = validateCatalogOrThrow(minimalValidCatalog);
    expect(result.valid).toBe(true);
  });

  it('validates starter catalog entries cleanly', () => {
    const catalog = {
      $schema: DEVICE_CATALOG_SCHEMA_VERSION,
      devices: STARTER_DEVICE_CATALOG,
    };
    const result = validateCatalog(catalog);
    // Starter catalog entries are well-formed — expect no errors
    expect(result.valid).toBe(true);
    // Some may have warnings (e.g., missing assembly data)
    expect(result.errors).toHaveLength(0);
  });

  it('detects an unresolved symbol reference for a category that requires one', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [{ ...minimalValidCatalog.devices[0], symbolRef: 'UNRESOLVED:C12345' }],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_SYMBOL')).toBe(true);
  });

  it('detects an unresolved footprint reference for a category that requires one', () => {
    const invalid = {
      ...minimalValidCatalog,
      devices: [{ ...minimalValidCatalog.devices[0], footprintRef: 'UNRESOLVED:C12345' }],
    };
    const result = validateCatalog(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_FOOTPRINT')).toBe(true);
  });

  it('does not flag a resolved (non-placeholder) symbol/footprint reference', () => {
    const result = validateCatalog(minimalValidCatalog);
    expect(result.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_SYMBOL')).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_FOOTPRINT')).toBe(false);
  });
});

describe('validateDeviceEntry (business rules, single entry)', () => {
  const mcuEntry = minimalValidCatalog.devices[0];

  it('returns valid=true for a well-formed entry', () => {
    const result = validateEntryBusinessRules(mcuEntry);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('flags an unresolved symbol reference', () => {
    const result = validateEntryBusinessRules({ ...mcuEntry, symbolRef: 'UNRESOLVED:C12345' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_SYMBOL')).toBe(true);
  });

  it('flags an unresolved footprint reference', () => {
    const result = validateEntryBusinessRules({ ...mcuEntry, footprintRef: 'UNRESOLVED:C12345' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'DEVICE_UNRESOLVED_FOOTPRINT')).toBe(true);
  });

  it('does not require a pin map for a passive-category entry', () => {
    const result = validateEntryBusinessRules(minimalDeviceEntry);
    expect(result.errors.some((e) => e.code === 'DEVICE_MISSING_PIN_MAP')).toBe(false);
  });
});
