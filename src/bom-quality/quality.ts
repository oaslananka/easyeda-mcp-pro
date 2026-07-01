/**
 * BOM quality — report generation.
 *
 * Analyses BOM entries against supplier data to surface issues:
 *  1. **Unavailable** — part not found or discontinued at any supplier.
 *  2. **Single-source** — part found at exactly one supplier.
 *  3. **Missing MPN** — no manufacturer part number.
 *  4. **Missing footprint** — no package / footprint.
 *  5. **Low stock** — stock below threshold at every supplier.
 *
 * @module
 */

import type {
  BomEntry,
  BomQualityReport,
  BomQualityIssue,
  BomQualityIssueType,
  BomQualityConfig,
  SupplierQueryResult,
  SupplierKind,
} from './types.js';
import { DEFAULT_BOM_QUALITY_CONFIG } from './types.js';
import type { AdapterMap, SupplierAdapter } from './adapter.js';
import { availableAdapters } from './adapter.js';
import { getLogger } from '../utils/logger.js';
import type pino from 'pino';

// ── Issue factory ──────────────────────────────────────────────────────────

function issue(
  type: BomQualityIssueType,
  severity: 'error' | 'warning' | 'info',
  reference: string,
  message: string,
  details?: Record<string, unknown>,
): BomQualityIssue {
  return { type, severity, reference, message, details };
}

function unavailableIssue(ref: string, supplier: string, reason: string): BomQualityIssue {
  return issue('unavailable', 'error', ref, `Part not available at ${supplier}: ${reason}`, {
    supplier,
    reason,
  });
}

function supplierStatusIssue(ref: string, result: SupplierQueryResult): BomQualityIssue | null {
  const status = result.status ?? (result.found ? 'found' : 'no_match');
  if (status === 'found' || status === 'no_match') return null;

  const type =
    status === 'unauthorized' ||
    status === 'rate_limited' ||
    status === 'timeout' ||
    status === 'invalid_response'
      ? status
      : 'unavailable';

  const severity = status === 'rate_limited' || status === 'timeout' ? 'warning' : 'error';

  return issue(
    type,
    severity,
    ref,
    `Supplier ${result.supplier} query ${status}: ${result.reason ?? 'no reason provided'}`,
    {
      supplier: result.supplier,
      status,
      reason: result.reason,
      statusCode: result.statusCode,
      source: result.source,
      queriedAt: result.queriedAt,
      cacheAgeSeconds: result.cacheAgeSeconds,
      fromCache: result.fromCache,
    },
  );
}

function singleSourceIssue(ref: string, suppliers: SupplierKind[]): BomQualityIssue {
  return issue(
    'single_source',
    'warning',
    ref,
    `Part is single-sourced (only found at ${suppliers.join(', ')})`,
    { suppliers },
  );
}

function missingMpnIssue(ref: string): BomQualityIssue {
  return issue(
    'missing_mpn',
    'warning',
    ref,
    'No manufacturer part number (MPN) specified — replaceability is limited',
  );
}

function missingFootprintIssue(ref: string): BomQualityIssue {
  return issue(
    'missing_footprint',
    'warning',
    ref,
    'No footprint / package specified — PCB layout verification is not possible',
  );
}

function lowStockIssue(ref: string, supplier: string, stock: number): BomQualityIssue {
  return issue('low_stock', 'warning', ref, `Low stock at ${supplier}: ${stock} units`, {
    supplier,
    stock,
  });
}

// ── Supplier query scope ───────────────────────────────────────────────────

/**
 * Determine which supplier identifiers to query based on what the entry has.
 * - If an LCSC code is present, query LCSC.
 * - If an MPN is present, query Mouser and DigiKey.
 */
function queryTargets(
  entry: BomEntry,
): Array<{ supplier: 'lcsc' | 'mouser' | 'digikey'; identifier: { lcsc?: string; mpn?: string } }> {
  const targets: Array<{
    supplier: 'lcsc' | 'mouser' | 'digikey';
    identifier: { lcsc?: string; mpn?: string };
  }> = [];

  if (entry.lcsc) {
    targets.push({ supplier: 'lcsc', identifier: { lcsc: entry.lcsc } });
  }
  if (entry.mpn) {
    targets.push({ supplier: 'mouser', identifier: { mpn: entry.mpn } });
    targets.push({ supplier: 'digikey', identifier: { mpn: entry.mpn } });
  }

  return targets;
}

// ── Supplier query helper ────────────────────────────────────────────────

async function querySuppliersForEntry(
  entry: BomEntry,
  adapterByKind: Map<SupplierKind, SupplierAdapter>,
  _logger: pino.Logger,
): Promise<{ supplierData: SupplierQueryResult[]; hasErrors: boolean; queriedCount: number }> {
  const targets = queryTargets(entry);
  const supplierData: SupplierQueryResult[] = [];
  let hasErrors = false;

  for (const target of targets) {
    const adapter = adapterByKind.get(target.supplier);
    if (!adapter) continue;
    try {
      const result = await adapter.queryPart(target.identifier);
      if (result) {
        supplierData.push(result);
        if (result.confidence === 'low') hasErrors = true;
      }
    } catch {
      // Should not happen (adapters catch internally), but safeguard
      hasErrors = true;
    }
  }

  return { supplierData, hasErrors, queriedCount: targets.length };
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Generate a BOM quality report for the given entries.
 *
 * For each entry the function:
 *  1. Queries every available supplier that can handle the entry.
 *  2. Collects supplier results (with error resilience).
 *  3. Runs the five quality checks.
 *  4. Returns a structured report with a summary.
 *
 * Supplier failures are caught gracefully — the report always succeeds
 * (non-null), with `hasSupplierErrors` set to `true` and any affected
 * entries marked via their issues.
 */
export async function generateBomQualityReport(
  bomId: string,
  entries: BomEntry[],
  adapters: AdapterMap,
  config: BomQualityConfig = DEFAULT_BOM_QUALITY_CONFIG,
): Promise<BomQualityReport> {
  const now = new Date().toISOString();
  let hasSupplierErrors = false;

  // Resolve available adapters once
  const adapterList = availableAdapters(adapters);
  const adapterByKind = new Map(adapterList.map((a) => [a.kind, a]));
  const logger = getLogger();

  const reportEntries = await Promise.all(
    entries.map(async (entry) => {
      // ── 1. Query applicable suppliers ──────────────────────────────────
      const { supplierData, hasErrors, queriedCount } = await querySuppliersForEntry(
        entry,
        adapterByKind,
        logger,
      );
      if (hasErrors) hasSupplierErrors = true;

      // ── 2. Run quality checks ──────────────────────────────────────────
      const issues: BomQualityIssue[] = [];

      // Check: unavailable (not found or discontinued at any queried supplier)
      const foundSuppliers = supplierData.filter((s) => s.found);
      const discontinuedSuppliers = supplierData.filter(
        (s) => s.found && s.lifecycle === 'discontinued',
      );

      if (supplierData.length > 0 && foundSuppliers.length === 0) {
        // Queried at least one supplier, none had it
        const queried = supplierData.map((s) => s.supplier).join(', ');
        issues.push(unavailableIssue(entry.reference, queried, 'not found at any supplier'));
      }

      for (const ds of discontinuedSuppliers) {
        issues.push(unavailableIssue(entry.reference, ds.supplier, 'discontinued / obsolete'));
      }

      for (const supplierResult of supplierData) {
        const statusIssue = supplierStatusIssue(entry.reference, supplierResult);
        if (statusIssue) issues.push(statusIssue);
      }

      // Check: single-source
      const uniqueFoundSuppliers = [...new Set(foundSuppliers.map((s) => s.supplier))];
      if (uniqueFoundSuppliers.length === 1 && queriedCount > 1) {
        // Only flag single-source when we actually queried more than one supplier
        // (i.e. the entry had identifiers for multiple suppliers)
        issues.push(singleSourceIssue(entry.reference, uniqueFoundSuppliers));
      }

      // Check: missing MPN
      if (config.requireMpn && !entry.mpn && !entry.manufacturer) {
        issues.push(missingMpnIssue(entry.reference));
      }

      // Check: missing footprint
      if (config.requireFootprint && !entry.footprint) {
        issues.push(missingFootprintIssue(entry.reference));
      }

      // Check: low stock (at every found supplier)
      if (foundSuppliers.length > 0) {
        const allLow = foundSuppliers.every((s) => s.stock < config.lowStockThreshold);
        if (allLow) {
          for (const fs of foundSuppliers) {
            issues.push(lowStockIssue(entry.reference, fs.supplier, fs.stock));
          }
        }
      }

      return {
        reference: entry.reference,
        description: entry.value ?? '',
        footprint: entry.footprint ?? '',
        quantity: entry.quantity,
        lcsc: entry.lcsc,
        mpn: entry.mpn,
        manufacturer: entry.manufacturer,
        supplierData,
        issues,
      };
    }),
  );

  // ── 3. Aggregate summary ────────────────────────────────────────────────
  const allIssues = reportEntries.flatMap((e) => e.issues);
  const summary = {
    totalIssues: allIssues.length,
    errors: allIssues.filter((i) => i.severity === 'error').length,
    warnings: allIssues.filter((i) => i.severity === 'warning').length,
    info: allIssues.filter((i) => i.severity === 'info').length,
    unavailableCount: allIssues.filter((i) => i.type === 'unavailable').length,
    singleSourceCount: allIssues.filter((i) => i.type === 'single_source').length,
    missingMpnCount: allIssues.filter((i) => i.type === 'missing_mpn').length,
    missingFootprintCount: allIssues.filter((i) => i.type === 'missing_footprint').length,
    lowStockCount: allIssues.filter((i) => i.type === 'low_stock').length,
    unauthorizedCount: allIssues.filter((i) => i.type === 'unauthorized').length,
    rateLimitedCount: allIssues.filter((i) => i.type === 'rate_limited').length,
    timeoutCount: allIssues.filter((i) => i.type === 'timeout').length,
    invalidResponseCount: allIssues.filter((i) => i.type === 'invalid_response').length,
  };

  return {
    bomId,
    generatedAt: now,
    totalEntries: entries.length,
    entries: reportEntries,
    summary,
    hasSupplierErrors,
  };
}
