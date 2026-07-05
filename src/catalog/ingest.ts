/**
 * Verified device catalog ingestion pipeline.
 *
 * Resolves an LCSC part number into a `DeviceEntry` by combining two
 * independent, best-effort sources:
 *
 * 1. The keyless LCSC tier (`src/vendors/lcsc/client.ts`) for commodity
 *    metadata — manufacturer/MPN string, package, stock, price,
 *    basic/preferred/extended classification.
 * 2. The EasyEDA bridge's `library.getDeviceByLcscId` method
 *    (`LIB_Device.getByLcscIds`) for a *reference* to a matching symbol and
 *    footprint already known to the connected EasyEDA Pro instance's
 *    library.
 *
 * Neither source can supply real pin/pad geometry for an arbitrary part —
 * jlcsearch is commodity metadata only, and EasyEDA's API returns opaque
 * library UUID references, not drawable content, with no read-back method
 * for the underlying symbol/footprint drawing. When the EasyEDA lookup
 * finds no match (part not already in the connected instance's library,
 * bridge disconnected, or the method is unsupported/restricted), the
 * resulting device's `symbolRef`/`footprintRef` are marked with
 * `UNRESOLVED_REF_PREFIX` rather than fabricated, and
 * `validateDeviceEntry`/`validateCatalog` will flag that as an error for
 * any category that requires a real symbol/footprint. This is a deliberate
 * design choice, not a bug — see docs/catalog-ingestion.md.
 *
 * @module
 */

import { type ToolContext } from '../tools/types.js';
import { DeviceEntrySchema, type DeviceEntry, UNRESOLVED_REF_PREFIX } from './schema.js';
import {
  validateDeviceEntry as validateEntryBusinessRules,
  type CatalogValidationResult,
} from './validation.js';
import { CatalogError, CatalogErrorCode } from './errors.js';
import { isLcscCategory, type LcscCategory } from '../vendors/lcsc/client.js';

/** Best-effort mapping from an LCSC keyless-tier category to a catalog category. */
const LCSC_CATEGORY_TO_CATALOG_CATEGORY: Record<LcscCategory, string> = {
  resistors: 'passive',
  capacitors: 'passive',
  diodes: 'passive',
  mosfets: 'power',
  leds: 'passive',
  microcontrollers: 'microcontroller',
  switches: 'interface',
  led_drivers: 'power',
};

export type IngestStatus = 'resolved' | 'partial' | 'unresolved';

export interface IngestResult {
  entry: DeviceEntry;
  validation: CatalogValidationResult;
  /**
   * 'resolved': a real EasyEDA symbol/footprint match was found and the
   *   entry passes validation.
   * 'partial': a real EasyEDA match was found but validation still failed
   *   (e.g. missing pin map for a category that requires one).
   * 'unresolved': no EasyEDA library match was found; symbolRef/footprintRef
   *   are placeholders and validation will fail for categories requiring them.
   */
  status: IngestStatus;
  provenance: {
    symbolFootprintSource: 'easyeda-library' | 'unresolved';
    metadataSource: 'keyless-lcsc' | 'unavailable';
  };
}

interface EasyedaLibraryRef {
  name?: string;
  uuid?: string;
  libraryUuid?: string;
}

interface EasyedaDeviceMatch {
  symbol?: EasyedaLibraryRef;
  footprint?: EasyedaLibraryRef;
  description?: string;
}

function normalizeLcscId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return trimmed.toUpperCase().startsWith('C') ? trimmed.toUpperCase() : `C${trimmed}`;
}

async function resolveEasyedaLibraryMatch(
  ctx: Pick<ToolContext, 'bridge'>,
  lcscId: string,
): Promise<EasyedaDeviceMatch | null> {
  if (!ctx.bridge.connected) return null;
  try {
    const result = await ctx.bridge.call<{ lcscId: string }, unknown>('library.getDeviceByLcscId', {
      lcscId,
    });
    const items = Array.isArray(result) ? (result as EasyedaDeviceMatch[]) : [];
    return items[0] ?? null;
  } catch {
    // Bridge disconnected, method unsupported/restricted, or no match — degrade gracefully.
    return null;
  }
}

/**
 * Resolve a single LCSC part number into a catalog `DeviceEntry`, running it
 * through business-rule validation. Never throws for "no match" — only
 * throws `CatalogError` (code `DEVICE_RESOLUTION_FAILED`) when *neither*
 * source returns anything at all for the given id.
 */
export async function ingestDeviceFromLcsc(
  ctx: Pick<ToolContext, 'bridge' | 'vendors'>,
  rawLcscId: string,
): Promise<IngestResult> {
  const lcscId = normalizeLcscId(rawLcscId);
  if (!lcscId) {
    throw new CatalogError({
      code: CatalogErrorCode.DEVICE_RESOLUTION_FAILED,
      message: 'An LCSC part number is required.',
    });
  }

  const [lcscPart, easyedaMatch] = await Promise.all([
    (ctx.vendors.lcsc?.getPartDetail(lcscId) ?? Promise.resolve(null)).catch(() => null),
    resolveEasyedaLibraryMatch(ctx, lcscId),
  ]);

  if (!lcscPart && !easyedaMatch) {
    throw new CatalogError({
      code: CatalogErrorCode.DEVICE_RESOLUTION_FAILED,
      message: `Could not resolve LCSC part "${lcscId}" via the keyless LCSC tier or the connected EasyEDA library.`,
    });
  }

  const category =
    lcscPart?.category && isLcscCategory(lcscPart.category)
      ? (LCSC_CATEGORY_TO_CATALOG_CATEGORY[lcscPart.category as LcscCategory] ?? 'custom')
      : 'custom';

  const symbolRef = easyedaMatch?.symbol?.name
    ? `SYM:${easyedaMatch.symbol.name}`
    : `${UNRESOLVED_REF_PREFIX}${lcscId}`;
  const footprintRef = easyedaMatch?.footprint?.name
    ? `FOOT:${easyedaMatch.footprint.name}`
    : `${UNRESOLVED_REF_PREFIX}${lcscId}`;

  const metadata: Array<{ key: string; value: string }> = [
    { key: 'ingestedAt', value: new Date().toISOString() },
    {
      key: 'ingestSource',
      value: easyedaMatch ? 'easyeda-library+keyless-lcsc' : 'keyless-lcsc-only',
    },
  ];
  if (easyedaMatch?.symbol?.uuid)
    metadata.push({ key: 'symbolUuid', value: easyedaMatch.symbol.uuid });
  if (easyedaMatch?.symbol?.libraryUuid) {
    metadata.push({ key: 'symbolLibraryUuid', value: easyedaMatch.symbol.libraryUuid });
  }
  if (easyedaMatch?.footprint?.uuid) {
    metadata.push({ key: 'footprintUuid', value: easyedaMatch.footprint.uuid });
  }
  if (easyedaMatch?.footprint?.libraryUuid) {
    metadata.push({ key: 'footprintLibraryUuid', value: easyedaMatch.footprint.libraryUuid });
  }

  const mpn = lcscPart?.manufacturer || lcscId;
  const draft = {
    id: `device-lcsc-${lcscId.toLowerCase()}`,
    displayName: mpn,
    category,
    description: easyedaMatch?.description || lcscPart?.description || undefined,
    symbolRef,
    footprintRef,
    model3dRef: '__missing__' as const,
    manufacturer: mpn,
    mpn,
    lcsc: lcscId,
    supplierIds: [{ supplier: 'lcsc', partId: lcscId }],
    package: lcscPart?.package || 'unknown',
    pinMapping: [],
    electricalParams: [],
    lifecycleStatus: lcscPart?.discontinued ? ('obsolete' as const) : ('active' as const),
    assemblyHint: lcscPart?.classification
      ? {
          status: ((lcscPart.stockCount ?? lcscPart.stock ?? 0) > 0
            ? 'in-production'
            : 'unknown') as 'in-production' | 'unknown',
          notes: `LCSC classification: ${lcscPart.classification}`,
        }
      : undefined,
    metadata,
  };

  const parsed = DeviceEntrySchema.safeParse(draft);
  if (!parsed.success) {
    throw new CatalogError({
      code: CatalogErrorCode.CATALOG_INVALID,
      message: `Ingested device for "${lcscId}" failed schema validation: ${parsed.error.message}`,
    });
  }

  const validation = validateEntryBusinessRules(parsed.data);
  const status: IngestStatus = !easyedaMatch
    ? 'unresolved'
    : validation.valid
      ? 'resolved'
      : 'partial';

  return {
    entry: parsed.data,
    validation,
    status,
    provenance: {
      symbolFootprintSource: easyedaMatch ? 'easyeda-library' : 'unresolved',
      metadataSource: lcscPart ? 'keyless-lcsc' : 'unavailable',
    },
  };
}
