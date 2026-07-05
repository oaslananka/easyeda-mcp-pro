import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { ingestDeviceFromLcsc } from '../catalog/ingest.js';
import { CatalogError } from '../catalog/errors.js';
import { type DeviceEntry } from '../catalog/schema.js';
import { type VerifiedDeviceRecord } from '../storage/types.js';

const catalogValidationIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const deviceEntrySummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  category: z.string(),
  manufacturer: z.string(),
  mpn: z.string(),
  lcsc: z.string().optional(),
  package: z.string(),
  symbolRef: z.string(),
  footprintRef: z.string(),
  pinMappingCount: z.number().int().nonnegative(),
  lifecycleStatus: z.string(),
});

function summarizeEntry(entry: DeviceEntry) {
  return {
    id: entry.id,
    displayName: entry.displayName,
    category: entry.category,
    manufacturer: entry.manufacturer,
    mpn: entry.mpn,
    lcsc: entry.lcsc,
    package: entry.package,
    symbolRef: entry.symbolRef,
    footprintRef: entry.footprintRef,
    pinMappingCount: entry.pinMapping.length,
    lifecycleStatus: entry.lifecycleStatus,
  };
}

function recordToSummary(record: VerifiedDeviceRecord): {
  lcsc_id: string;
  status: string;
  error_count: number;
  warning_count: number;
  updated_at: string;
  entry: ReturnType<typeof summarizeEntry> | null;
} {
  let summary: ReturnType<typeof summarizeEntry> | null;
  try {
    const entry = JSON.parse(record.entryJson) as DeviceEntry;
    summary = summarizeEntry(entry);
  } catch {
    // A malformed/incomplete cache entry must not fail the whole list — surface it as
    // entry: null rather than throwing.
    summary = null;
  }
  return {
    lcsc_id: record.lcscId,
    status: record.status,
    error_count: record.errorCount,
    warning_count: record.warningCount,
    updated_at: record.updatedAt,
    entry: summary,
  };
}

function registerCatalogTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_catalog_verify_device',
    title: 'Verify and cache a device from an LCSC part number',
    description:
      'Resolve an LCSC part number into a catalog device entry (keyless LCSC metadata plus an ' +
      'EasyEDA symbol/footprint reference, if already known locally), validate it, and write it ' +
      'to the local device cache (confirmWrite required). Does NOT verify pin/pad geometry — ' +
      'see docs/catalog-ingestion.md.',
    profile: 'pro',
    evidence: ['vendor-api-docs', 'pro-api-types', 'inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'catalog',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      lcscId: z.string().min(1),
      confirmWrite: z.boolean().default(false),
    }),
    outputSchema: z.object({
      lcsc_id: z.string(),
      status: z.enum(['resolved', 'partial', 'unresolved']),
      valid: z.boolean(),
      errors: z.array(catalogValidationIssueSchema),
      warnings: z.array(catalogValidationIssueSchema),
      provenance: z.object({
        symbol_footprint_source: z.enum(['easyeda-library', 'unresolved']),
        metadata_source: z.enum(['keyless-lcsc', 'unavailable']),
      }),
      entry: deviceEntrySummarySchema,
      cached: z.boolean(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { lcscId } = params as { lcscId: string };
      try {
        const result = await ingestDeviceFromLcsc(ctx, lcscId);
        let cached = false;
        if (ctx.storage) {
          ctx.storage.upsertVerifiedDevice({
            lcscId: result.entry.lcsc ?? lcscId,
            entryJson: JSON.stringify(result.entry),
            status: result.status,
            errorCount: result.validation.errors.length,
            warningCount: result.validation.warnings.length,
          });
          cached = true;
        }
        return {
          lcsc_id: result.entry.lcsc ?? lcscId,
          status: result.status,
          valid: result.validation.valid,
          errors: result.validation.errors,
          warnings: result.validation.warnings,
          provenance: {
            symbol_footprint_source: result.provenance.symbolFootprintSource,
            metadata_source: result.provenance.metadataSource,
          },
          entry: summarizeEntry(result.entry),
          cached,
        };
      } catch (err) {
        return {
          lcsc_id: lcscId,
          status: 'unresolved' as const,
          valid: false,
          errors: err instanceof CatalogError ? [{ code: err.code, message: err.message }] : [],
          warnings: [],
          provenance: {
            symbol_footprint_source: 'unresolved' as const,
            metadata_source: 'unavailable' as const,
          },
          entry: null,
          cached: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_catalog_list',
    title: 'List verified devices',
    description:
      'List devices cached by easyeda_catalog_verify_device, with their validation status and ' +
      'provenance. Optionally filter by status (resolved/partial/unresolved). This is a local ' +
      'cache only — never redistributed.',
    profile: 'pro',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'catalog',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      status: z.enum(['resolved', 'partial', 'unresolved']).optional(),
    }),
    outputSchema: z.object({
      devices: z.array(
        z.object({
          lcsc_id: z.string(),
          status: z.string(),
          error_count: z.number().int().nonnegative(),
          warning_count: z.number().int().nonnegative(),
          updated_at: z.string(),
          entry: deviceEntrySummarySchema.nullable(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { status } = params as { status?: 'resolved' | 'partial' | 'unresolved' };
      if (!ctx.storage) {
        return {
          devices: [],
          total: 0,
          not_available: true,
          error: 'Local storage is unavailable.',
        };
      }
      try {
        const records = ctx.storage.listVerifiedDevices(status);
        const devices = records.map(recordToSummary);
        return { devices, total: devices.length };
      } catch (err) {
        return {
          devices: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerCatalogTools };
