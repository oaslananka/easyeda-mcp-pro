/**
 * BOM quality — core type definitions.
 *
 * @module
 */

/** Supported supplier identifiers. */
export type SupplierKind = 'lcsc' | 'mouser' | 'digikey' | 'jlcpcb';

/** Lifecycle / status of a part at a supplier. */
export type PartLifecycle = 'active' | 'discontinued' | 'unknown';

/** Normalized quality risk level. */
export type ComponentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Substitution compatibility classification. */
export type SubstitutionCompatibility = 'drop_in' | 'review_required' | 'unsafe';

/** BOM entry as passed to quality check, extended with metadata. */
export interface BomEntry {
  reference: string;
  value?: string;
  footprint?: string;
  lcsc?: string;
  mpn?: string;
  manufacturer?: string;
  quantity: number;
  /** Source of this entry (e.g. 'bridge', 'manual'). */
  source: string;
  /** ISO-8601 timestamp when this entry was obtained. */
  fetchedAt: string;
}

/** Normalised supplier query status. */
export type SupplierQueryStatus =
  | 'found'
  | 'no_match'
  | 'unavailable'
  | 'unauthorized'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_response';

/** Normalised result from a single supplier query. */
export interface SupplierQueryResult {
  supplier: SupplierKind;
  /** Machine-readable query status for graceful degradation. */
  status: SupplierQueryStatus;
  found: boolean;
  lcsc?: string;
  mpn?: string;
  manufacturer?: string;
  description?: string;
  lifecycle: PartLifecycle;
  stock: number;
  unitPrice?: number;
  currency?: string;
  leadTimeDays?: number;
  /** ISO-8601 timestamp of this supplier response. */
  queriedAt: string;
  /** Data source endpoint or integration family used for provenance. */
  source: string;
  /** Cache age in seconds when served from cache; zero means live/fresh. */
  cacheAgeSeconds: number;
  /** Whether the result came from a cache. */
  fromCache: boolean;
  /** Human-readable confidence (e.g. 'high', 'medium', 'low'). */
  confidence: 'high' | 'medium' | 'low';
  /** Sanitized unavailable/error reason. Never contains credentials or raw tokens. */
  reason?: string;
  /** Sanitized HTTP status code when known. */
  statusCode?: number;
}

/** Issue type identifiers for the BOM quality report. */
export type BomQualityIssueType =
  | 'stale_vendor_data'
  | 'missing_vendor_data'
  | 'package_mismatch'
  | 'manufacturer_risk'
  | 'lifecycle_risk'
  | 'no_safe_alternate'
  | 'unavailable'
  | 'unauthorized'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_response'
  | 'single_source'
  | 'missing_mpn'
  | 'missing_footprint'
  | 'low_stock';

/** Per-dimension component quality score. */
export interface ComponentQualityDimension {
  score: number;
  risk: ComponentRiskLevel;
  reason: string;
}

/** Suggested alternate or substitution candidate. */
export interface ComponentAlternateCandidate {
  supplier: SupplierKind;
  mpn?: string;
  lcsc?: string;
  manufacturer?: string;
  description?: string;
  lifecycle: PartLifecycle;
  stock: number;
  unitPrice?: number;
  currency?: string;
  compatibility: SubstitutionCompatibility;
  score: number;
  reasons: string[];
  caveats: string[];
}

/** Aggregated lifecycle, stock, package and sourcing quality assessment. */
export interface ComponentQualityAssessment {
  score: number;
  risk: ComponentRiskLevel;
  dimensions: {
    lifecycle: ComponentQualityDimension;
    stock: ComponentQualityDimension;
    manufacturer: ComponentQualityDimension;
    package: ComponentQualityDimension;
    freshness: ComponentQualityDimension;
  };
  alternates: ComponentAlternateCandidate[];
  recommendedAction: 'accept' | 'review' | 'replace' | 'insufficient_data';
  provenance: {
    supplierCount: number;
    foundSupplierCount: number;
    liveSupplierCount: number;
    cachedSupplierCount: number;
    oldestCacheAgeSeconds: number;
    newestQueryAt?: string;
  };
}

/** A single quality issue found for a BOM entry. */
export interface BomQualityIssue {
  type: BomQualityIssueType;
  severity: 'error' | 'warning' | 'info';
  reference: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Complete BOM quality report. */
export interface BomQualityReport {
  bomId: string;
  generatedAt: string;
  totalEntries: number;
  entries: Array<{
    reference: string;
    description: string;
    footprint: string;
    quantity: number;
    lcsc?: string;
    mpn?: string;
    manufacturer?: string;
    /** Supplier-specific data collected during the check. */
    supplierData: SupplierQueryResult[];
    /** Lifecycle, stock, package, source diversity, freshness and alternate assessment. */
    componentQuality: ComponentQualityAssessment;
    issues: BomQualityIssue[];
  }>;
  summary: {
    totalIssues: number;
    errors: number;
    warnings: number;
    info: number;
    unavailableCount: number;
    singleSourceCount: number;
    missingMpnCount: number;
    missingFootprintCount: number;
    lowStockCount: number;
    unauthorizedCount: number;
    rateLimitedCount: number;
    timeoutCount: number;
    invalidResponseCount: number;
    staleVendorDataCount: number;
    missingVendorDataCount: number;
    packageMismatchCount: number;
    manufacturerRiskCount: number;
    lifecycleRiskCount: number;
    noSafeAlternateCount: number;
    highRiskComponentCount: number;
  };
  /** Whether any suppliers returned errors during the check. */
  hasSupplierErrors: boolean;
}

/** Configuration for BOM quality checking. */
export interface BomQualityConfig {
  /** Stock threshold below which a part is considered low-stock. */
  lowStockThreshold: number;
  /** Whether to treat a missing LCSC code as an error. */
  requireLcsc: boolean;
  /** Whether to treat a missing MPN as a warning. */
  requireMpn: boolean;
  /** Whether to treat a missing footprint as a warning. */
  requireFootprint: boolean;
  /** Cache age above which supplier data is considered stale. */
  staleVendorDataSeconds: number;
  /** Minimum acceptable aggregate component quality score. */
  minimumQualityScore: number;
}

export const DEFAULT_BOM_QUALITY_CONFIG: BomQualityConfig = {
  lowStockThreshold: 100,
  requireLcsc: false,
  requireMpn: true,
  requireFootprint: true,
  staleVendorDataSeconds: 7 * 24 * 60 * 60,
  minimumQualityScore: 70,
};
