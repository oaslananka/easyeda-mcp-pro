/**
 * Sourcing facade — a single entry point for tools to resolve part
 * sourcing/pricing data across the keyless tier (LCSC via jlcsearch) and
 * authenticated tiers (Mouser, DigiKey), reusing the {@link SupplierAdapter}
 * normalization already built for BOM quality checks.
 *
 * @module
 */

import { type ToolContext } from '../tools/types.js';
import { createAdapters } from '../bom-quality/adapter.js';
import { type SupplierQueryResult } from '../bom-quality/types.js';

export type SourcingTier = 'keyless' | 'authenticated';

export interface SourcingIdentifier {
  lcsc?: string;
  mpn?: string;
}

export interface SourcingTierResult {
  supplier: string;
  tier: SourcingTier;
  found: boolean;
  in_stock: boolean;
  quantity_available?: number;
  unit_price?: number;
  currency?: string;
  lead_time_days?: number;
  classification?: string;
  status: string;
  source: string;
  from_cache: boolean;
  cache_age_seconds: number;
  reason?: string;
}

export interface ResolvePartSourcingOptions {
  /** Restrict to these supplier keys (case-insensitive). Omit to try every configured supplier. */
  suppliers?: string[];
  /** Whether the keyless LCSC tier should be attempted. Defaults to true. */
  keylessSourcingEnabled?: boolean;
}

function toTierResult(result: SupplierQueryResult, tier: SourcingTier): SourcingTierResult {
  return {
    supplier: result.supplier,
    tier,
    found: result.found,
    in_stock: result.found && result.stock > 0,
    quantity_available: result.found ? result.stock : undefined,
    unit_price: result.unitPrice,
    currency: result.currency,
    lead_time_days: result.leadTimeDays,
    classification: result.classification,
    status: result.status,
    source: result.source,
    from_cache: result.fromCache,
    cache_age_seconds: result.cacheAgeSeconds,
    reason: result.reason,
  };
}

/**
 * Resolve sourcing/pricing data for a single part identifier across every
 * configured, available supplier. LCSC is queried keyless-first via the
 * public jlcsearch dataset when an LCSC code is known; Mouser/DigiKey are
 * queried only when a manufacturer part number is known, since neither
 * exposes a keyless tier.
 */
export async function resolvePartSourcing(
  vendors: ToolContext['vendors'],
  identifier: SourcingIdentifier,
  options?: ResolvePartSourcingOptions,
): Promise<SourcingTierResult[]> {
  const requested = options?.suppliers?.map((s) => s.toLowerCase());
  const wants = (supplier: string) => !requested || requested.includes(supplier);
  const keylessEnabled = options?.keylessSourcingEnabled ?? true;

  const adapters = createAdapters(vendors);
  const results: SourcingTierResult[] = [];

  if (wants('lcsc') && keylessEnabled && adapters.lcsc.isAvailable() && identifier.lcsc) {
    const result = await adapters.lcsc.queryPart({ lcsc: identifier.lcsc });
    if (result) results.push(toTierResult(result, 'keyless'));
  }

  for (const kind of ['mouser', 'digikey'] as const) {
    if (!wants(kind)) continue;
    const adapter = adapters[kind];
    if (!adapter.isAvailable() || !identifier.mpn) continue;
    const result = await adapter.queryPart({ mpn: identifier.mpn });
    if (result) results.push(toTierResult(result, 'authenticated'));
  }

  return results;
}
