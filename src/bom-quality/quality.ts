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
  ComponentQualityAssessment,
  ComponentQualityDimension,
  ComponentRiskLevel,
  ComponentAlternateCandidate,
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

function staleVendorDataIssue(ref: string, ageSeconds: number): BomQualityIssue {
  return issue('stale_vendor_data', 'warning', ref, `Supplier data is stale (${ageSeconds}s old)`, {
    cacheAgeSeconds: ageSeconds,
  });
}

function missingVendorDataIssue(ref: string): BomQualityIssue {
  return issue(
    'missing_vendor_data',
    'warning',
    ref,
    'No supplier data was available for component quality scoring',
  );
}

function packageMismatchIssue(ref: string, footprint: string): BomQualityIssue {
  return issue(
    'package_mismatch',
    'error',
    ref,
    `Supplier package data does not match footprint ${footprint}`,
    {
      footprint,
    },
  );
}

function manufacturerRiskIssue(ref: string, reason: string): BomQualityIssue {
  return issue('manufacturer_risk', 'warning', ref, reason);
}

function lifecycleRiskIssue(ref: string, reason: string): BomQualityIssue {
  return issue('lifecycle_risk', 'error', ref, reason);
}

function noSafeAlternateIssue(ref: string): BomQualityIssue {
  return issue('no_safe_alternate', 'warning', ref, 'No safe alternate candidate was identified');
}

function riskFromScore(score: number): ComponentRiskLevel {
  if (score >= 85) return 'low';
  if (score >= 65) return 'medium';
  if (score >= 40) return 'high';
  return 'critical';
}

function dimension(score: number, reason: string): ComponentQualityDimension {
  return { score, risk: riskFromScore(score), reason };
}

function footprintTokens(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.toUpperCase();
  const tokens = [
    '0201',
    '0402',
    '0603',
    '0805',
    '1206',
    '1210',
    'SOT-23',
    'SOT23',
    'SOIC',
    'TSSOP',
    'QFN',
    'DFN',
    'BGA',
    'DIP',
  ];
  return tokens.filter((token) => normalized.includes(token));
}

function packageMatches(
  entryFootprint: string | undefined,
  result: SupplierQueryResult,
): boolean | undefined {
  const expected = footprintTokens(entryFootprint);
  if (expected.length === 0) return undefined;
  const descriptionTokens = footprintTokens(result.description);
  if (descriptionTokens.length === 0) return undefined;
  return expected.some((token) => descriptionTokens.includes(token));
}

function supplierIdentity(result: SupplierQueryResult): string {
  return result.mpn ?? result.lcsc ?? result.description ?? result.supplier;
}

function evaluateAlternate(
  entry: BomEntry,
  result: SupplierQueryResult,
): ComponentAlternateCandidate {
  const caveats: string[] = [];
  const reasons: string[] = [];
  let score = 100;
  let compatibility: ComponentAlternateCandidate['compatibility'] = 'drop_in';
  const pkg = packageMatches(entry.footprint, result);

  if (result.lifecycle === 'discontinued') {
    compatibility = 'unsafe';
    score -= 60;
    caveats.push('Lifecycle is discontinued or obsolete.');
  } else if (result.lifecycle === 'unknown') {
    compatibility = 'review_required';
    score -= 15;
    caveats.push('Lifecycle is unknown; verify with manufacturer datasheet.');
  } else {
    reasons.push('Lifecycle is active.');
  }

  if (result.stock <= 0) {
    compatibility = 'unsafe';
    score -= 45;
    caveats.push('No supplier stock is available.');
  } else if (result.stock < Math.max(1, entry.quantity * 10)) {
    compatibility = compatibility === 'drop_in' ? 'review_required' : compatibility;
    score -= 15;
    caveats.push('Stock is low relative to BOM quantity.');
  } else {
    reasons.push('Supplier stock is available.');
  }

  if (pkg === false) {
    compatibility = 'unsafe';
    score -= 50;
    caveats.push(`Package appears incompatible with footprint ${entry.footprint}.`);
  } else if (pkg === undefined && entry.footprint) {
    compatibility = compatibility === 'drop_in' ? 'review_required' : compatibility;
    score -= 10;
    caveats.push('Package could not be verified from supplier description.');
  } else if (pkg === true) {
    reasons.push('Package appears compatible with the requested footprint.');
  }

  if (!result.manufacturer) {
    compatibility = compatibility === 'drop_in' ? 'review_required' : compatibility;
    score -= 10;
    caveats.push('Manufacturer is missing from supplier data.');
  }

  if ((result.cacheAgeSeconds ?? 0) > 7 * 24 * 60 * 60) {
    compatibility = compatibility === 'drop_in' ? 'review_required' : compatibility;
    score -= 10;
    caveats.push('Supplier data is stale and should be refreshed.');
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  return {
    supplier: result.supplier,
    mpn: result.mpn,
    lcsc: result.lcsc,
    manufacturer: result.manufacturer,
    description: result.description,
    lifecycle: result.lifecycle,
    stock: result.stock,
    unitPrice: result.unitPrice,
    currency: result.currency,
    compatibility,
    score: boundedScore,
    reasons:
      reasons.length > 0 ? reasons : [`Candidate ${supplierIdentity(result)} requires review.`],
    caveats,
  };
}

function assessComponentQuality(
  entry: BomEntry,
  supplierData: SupplierQueryResult[],
  config: BomQualityConfig,
): ComponentQualityAssessment {
  const found = supplierData.filter((result) => result.found);
  const live = supplierData.filter((result) => !result.fromCache);
  const cached = supplierData.filter((result) => result.fromCache);
  const totalStock = found.reduce((acc, result) => acc + result.stock, 0);
  const oldestCacheAge = supplierData.reduce(
    (max, result) => Math.max(max, result.cacheAgeSeconds ?? 0),
    0,
  );
  const newestQueryAt = supplierData
    .map((result) => result.queriedAt)
    .sort()
    .at(-1);
  const allDiscontinued =
    found.length > 0 && found.every((result) => result.lifecycle === 'discontinued');
  const anyUnknownLifecycle = found.some((result) => result.lifecycle === 'unknown');
  const packageMismatch = found.some((result) => packageMatches(entry.footprint, result) === false);
  const missingPackageEvidence =
    Boolean(entry.footprint) &&
    found.every((result) => packageMatches(entry.footprint, result) === undefined);

  const lifecycle = allDiscontinued
    ? dimension(0, 'All found supplier records are discontinued or obsolete.')
    : found.length === 0
      ? dimension(25, 'No found supplier records are available for lifecycle review.')
      : anyUnknownLifecycle
        ? dimension(70, 'At least one found supplier record has unknown lifecycle.')
        : dimension(100, 'Found supplier records indicate active lifecycle.');

  const stock =
    found.length === 0
      ? dimension(20, 'No found supplier stock data is available.')
      : totalStock < entry.quantity
        ? dimension(25, 'Total supplier stock is below BOM quantity.')
        : found.every((result) => result.stock < config.lowStockThreshold)
          ? dimension(55, 'All found suppliers are below the configured low-stock threshold.')
          : dimension(100, 'Supplier stock is above the configured threshold.');

  const manufacturer =
    !entry.manufacturer && found.every((result) => !result.manufacturer)
      ? dimension(45, 'Manufacturer is missing from BOM and supplier data.')
      : found.length <= 1
        ? dimension(70, 'Part has limited manufacturer/source diversity.')
        : dimension(100, 'Manufacturer/source diversity is acceptable.');

  const pkg = !entry.footprint
    ? dimension(40, 'BOM entry has no footprint/package metadata.')
    : packageMismatch
      ? dimension(25, 'At least one supplier candidate appears package-incompatible.')
      : missingPackageEvidence
        ? dimension(70, 'Package could not be verified from supplier descriptions.')
        : dimension(100, 'Package metadata is present and compatible.');

  const freshness =
    supplierData.length === 0
      ? dimension(30, 'No vendor data was collected for freshness review.')
      : oldestCacheAge > config.staleVendorDataSeconds
        ? dimension(55, 'At least one supplier response is older than the stale-data threshold.')
        : dimension(100, 'Supplier data freshness is within threshold.');

  const alternates = found
    .map((result) => evaluateAlternate(entry, result))
    .sort((a, b) => b.score - a.score);
  const score = Math.round(
    lifecycle.score * 0.25 +
      stock.score * 0.25 +
      manufacturer.score * 0.15 +
      pkg.score * 0.2 +
      freshness.score * 0.15,
  );
  const safeAlternate = alternates.some((candidate) => candidate.compatibility !== 'unsafe');
  const recommendedAction =
    supplierData.length === 0
      ? 'insufficient_data'
      : score < 45 || allDiscontinued || !safeAlternate
        ? 'replace'
        : score < config.minimumQualityScore
          ? 'review'
          : 'accept';

  return {
    score,
    risk: riskFromScore(score),
    dimensions: { lifecycle, stock, manufacturer, package: pkg, freshness },
    alternates,
    recommendedAction,
    provenance: {
      supplierCount: supplierData.length,
      foundSupplierCount: found.length,
      liveSupplierCount: live.length,
      cachedSupplierCount: cached.length,
      oldestCacheAgeSeconds: oldestCacheAge,
      newestQueryAt,
    },
  };
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

      const componentQuality = assessComponentQuality(entry, supplierData, config);
      if (supplierData.length === 0) {
        issues.push(missingVendorDataIssue(entry.reference));
      }
      if (componentQuality.provenance.oldestCacheAgeSeconds > config.staleVendorDataSeconds) {
        issues.push(
          staleVendorDataIssue(entry.reference, componentQuality.provenance.oldestCacheAgeSeconds),
        );
      }
      if (
        componentQuality.dimensions.package.risk === 'critical' ||
        componentQuality.dimensions.package.reason.includes('incompatible')
      ) {
        if (entry.footprint) issues.push(packageMismatchIssue(entry.reference, entry.footprint));
      }
      if (componentQuality.dimensions.manufacturer.risk === 'high') {
        issues.push(
          manufacturerRiskIssue(entry.reference, componentQuality.dimensions.manufacturer.reason),
        );
      }
      if (componentQuality.dimensions.lifecycle.risk === 'critical') {
        issues.push(
          lifecycleRiskIssue(entry.reference, componentQuality.dimensions.lifecycle.reason),
        );
      }
      if (!componentQuality.alternates.some((candidate) => candidate.compatibility !== 'unsafe')) {
        issues.push(noSafeAlternateIssue(entry.reference));
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
        componentQuality,
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
    staleVendorDataCount: allIssues.filter((i) => i.type === 'stale_vendor_data').length,
    missingVendorDataCount: allIssues.filter((i) => i.type === 'missing_vendor_data').length,
    packageMismatchCount: allIssues.filter((i) => i.type === 'package_mismatch').length,
    manufacturerRiskCount: allIssues.filter((i) => i.type === 'manufacturer_risk').length,
    lifecycleRiskCount: allIssues.filter((i) => i.type === 'lifecycle_risk').length,
    noSafeAlternateCount: allIssues.filter((i) => i.type === 'no_safe_alternate').length,
    highRiskComponentCount: reportEntries.filter(
      (e) => e.componentQuality.risk === 'high' || e.componentQuality.risk === 'critical',
    ).length,
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
