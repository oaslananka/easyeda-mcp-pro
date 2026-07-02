import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import {
  generateBomQualityReport,
  createAdapters,
  DEFAULT_BOM_QUALITY_CONFIG,
} from '../bom-quality/index.js';
import type { BomQualityConfig } from '../bom-quality/types.js';

function registerBomSourcingTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_bom_sourcing',
    title: 'Get BOM sourcing info',
    description:
      'Retrieve pricing and availability information for all parts in the project BOM from specified suppliers.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: false,
    group: 'bom',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      suppliers: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      parts: z.array(
        z.object({
          reference: z.string(),
          value: z.string(),
          lcsc: z.string().optional(),
          sourcing: z.array(
            z.object({
              supplier: z.string(),
              in_stock: z.boolean(),
              quantity_available: z.number().int().nonnegative().optional(),
              unit_price: z.number().nonnegative().optional(),
              currency: z.string().optional(),
              lead_time_days: z.number().int().nonnegative().optional(),
            }),
          ),
        }),
      ),
      total_parts: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, suppliers = ['lcsc'] } = params as {
        projectId: string;
        suppliers?: string[];
      };
      try {
        const bomResult = await ctx.bridge.call('bom.generate', {
          projectId,
          format: 'json',
          groupBy: 'lcsc',
        });
        const bomEntries = bomResult as Array<{
          reference: string;
          value: string;
          lcsc?: string;
          quantity: number;
        }>;

        if (!bomEntries?.length) {
          return { project_id: projectId, parts: [], total_parts: 0 };
        }

        const parts = await Promise.allSettled(
          bomEntries.map(async (entry) => {
            const sourcing: Array<{
              supplier: string;
              in_stock: boolean;
              quantity_available?: number;
              unit_price?: number;
              currency?: string;
              lead_time_days?: number;
            }> = [];

            if (suppliers.includes('lcsc') && ctx.vendors.lcsc && entry.lcsc) {
              try {
                const detail = await ctx.vendors.lcsc.getPartDetail(entry.lcsc);
                if (detail) {
                  const rawDetail = detail as unknown as Record<string, unknown>;
                  sourcing.push({
                    supplier: 'lcsc',
                    in_stock: (detail.stockCount ?? detail.stock ?? 0) > 0,
                    quantity_available: detail.stockCount ?? detail.stock,
                    unit_price:
                      (rawDetail.priceBreaks as Array<{ unitPrice?: number }> | undefined)?.[0]
                        ?.unitPrice ??
                      (typeof rawDetail.price === 'number'
                        ? rawDetail.price
                        : typeof rawDetail.price === 'string'
                          ? parseFloat(rawDetail.price)
                          : undefined),
                    currency: 'USD',
                    lead_time_days: detail.leadTime,
                  });
                }
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
              } catch (_err) {
                // ignore and continue
              }
            }

            return {
              reference: entry.reference,
              value: entry.value,
              lcsc: entry.lcsc,
              sourcing,
            };
          }),
        );

        return {
          project_id: projectId,
          parts: parts.map((r) =>
            r.status === 'fulfilled' ? r.value : { reference: '', value: '', sourcing: [] },
          ),
          total_parts: bomEntries.length,
        };
      } catch (err) {
        return {
          project_id: projectId,
          parts: [],
          total_parts: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
  registry.register({
    name: 'easyeda_bom_quality_report',
    title: 'BOM Quality Report',
    description:
      'Generate a BOM quality report that identifies unavailable, single-source, missing-MPN, missing-footprint, and low-stock items across configured suppliers.',
    profile: 'core',
    evidence: ['vendor-api-docs'],
    risk: 'medium',
    confirmWrite: false,
    group: 'bom',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
      low_stock_threshold: z.number().int().nonnegative().default(100).optional(),
      require_mpn: z.boolean().default(true).optional(),
      require_footprint: z.boolean().default(true).optional(),
      stale_vendor_data_seconds: z.number().int().nonnegative().optional(),
      minimum_quality_score: z.number().int().min(0).max(100).optional(),
    }),
    outputSchema: z.object({
      bom_id: z.string(),
      generated_at: z.string(),
      total_entries: z.number().int().nonnegative(),
      summary: z.object({
        total_issues: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
        unavailable_count: z.number().int().nonnegative(),
        single_source_count: z.number().int().nonnegative(),
        missing_mpn_count: z.number().int().nonnegative(),
        missing_footprint_count: z.number().int().nonnegative(),
        low_stock_count: z.number().int().nonnegative(),
        unauthorized_count: z.number().int().nonnegative(),
        rate_limited_count: z.number().int().nonnegative(),
        timeout_count: z.number().int().nonnegative(),
        invalid_response_count: z.number().int().nonnegative(),
        stale_vendor_data_count: z.number().int().nonnegative(),
        missing_vendor_data_count: z.number().int().nonnegative(),
        package_mismatch_count: z.number().int().nonnegative(),
        manufacturer_risk_count: z.number().int().nonnegative(),
        lifecycle_risk_count: z.number().int().nonnegative(),
        no_safe_alternate_count: z.number().int().nonnegative(),
        high_risk_component_count: z.number().int().nonnegative(),
      }),
      entries: z.array(
        z.object({
          reference: z.string(),
          description: z.string(),
          footprint: z.string(),
          quantity: z.number().int().nonnegative(),
          lcsc: z.string().optional(),
          mpn: z.string().optional(),
          manufacturer: z.string().optional(),
          supplier_data: z.array(
            z.object({
              supplier: z.string(),
              status: z.string(),
              found: z.boolean(),
              source: z.string(),
              queried_at: z.string(),
              cache_age_seconds: z.number().int().nonnegative(),
              from_cache: z.boolean(),
              confidence: z.string(),
              reason: z.string().optional(),
              status_code: z.number().int().optional(),
              stock: z.number().optional(),
              lifecycle: z.string().optional(),
              unit_price: z.number().optional(),
              currency: z.string().optional(),
              lead_time_days: z.number().optional(),
            }),
          ),

          component_quality: z.object({
            score: z.number().int().min(0).max(100),
            risk: z.string(),
            recommended_action: z.string(),
            dimensions: z.object({
              lifecycle: z.object({ score: z.number(), risk: z.string(), reason: z.string() }),
              stock: z.object({ score: z.number(), risk: z.string(), reason: z.string() }),
              manufacturer: z.object({ score: z.number(), risk: z.string(), reason: z.string() }),
              package: z.object({ score: z.number(), risk: z.string(), reason: z.string() }),
              freshness: z.object({ score: z.number(), risk: z.string(), reason: z.string() }),
            }),
            alternates: z.array(
              z.object({
                supplier: z.string(),
                mpn: z.string().optional(),
                lcsc: z.string().optional(),
                manufacturer: z.string().optional(),
                description: z.string().optional(),
                lifecycle: z.string(),
                stock: z.number(),
                unit_price: z.number().optional(),
                currency: z.string().optional(),
                compatibility: z.string(),
                score: z.number(),
                reasons: z.array(z.string()),
                caveats: z.array(z.string()),
              }),
            ),
            provenance: z.object({
              supplier_count: z.number().int().nonnegative(),
              found_supplier_count: z.number().int().nonnegative(),
              live_supplier_count: z.number().int().nonnegative(),
              cached_supplier_count: z.number().int().nonnegative(),
              oldest_cache_age_seconds: z.number().int().nonnegative(),
              newest_query_at: z.string().optional(),
            }),
          }),
          issues: z.array(
            z.object({
              type: z.string(),
              severity: z.string(),
              reference: z.string(),
              message: z.string(),
              details: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        }),
      ),
      has_supplier_errors: z.boolean(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const {
        projectId,
        low_stock_threshold: lowStockThreshold,
        require_mpn: requireMpn,
        require_footprint: requireFootprint,
        stale_vendor_data_seconds: staleVendorDataSeconds,
        minimum_quality_score: minimumQualityScore,
      } = params as {
        projectId: string;
        low_stock_threshold?: number;
        require_mpn?: boolean;
        require_footprint?: boolean;
        stale_vendor_data_seconds?: number;
        minimum_quality_score?: number;
      };
      try {
        const bomResult = await ctx.bridge.call('bom.generate', {
          projectId,
          format: 'json',
          groupBy: 'value',
        });
        const bomEntries = bomResult as Array<{
          reference?: string;
          value?: string;
          footprint?: string;
          lcsc?: string;
          quantity?: number;
          manufacturer?: string;
        }>;

        if (!bomEntries?.length) {
          return {
            bom_id: projectId,
            generated_at: new Date().toISOString(),
            total_entries: 0,
            summary: {
              total_issues: 0,
              errors: 0,
              warnings: 0,
              info: 0,
              unavailable_count: 0,
              single_source_count: 0,
              missing_mpn_count: 0,
              missing_footprint_count: 0,
              low_stock_count: 0,
              unauthorized_count: 0,
              rate_limited_count: 0,
              timeout_count: 0,
              invalid_response_count: 0,
              stale_vendor_data_count: 0,
              missing_vendor_data_count: 0,
              package_mismatch_count: 0,
              manufacturer_risk_count: 0,
              lifecycle_risk_count: 0,
              no_safe_alternate_count: 0,
              high_risk_component_count: 0,
            },
            entries: [],
            has_supplier_errors: false,
          };
        }

        const now = new Date().toISOString();
        const entries = bomEntries.map((e) => ({
          reference: e.reference ?? '',
          value: e.value,
          footprint: e.footprint,
          lcsc: e.lcsc,
          mpn: undefined as string | undefined,
          manufacturer: e.manufacturer,
          quantity: e.quantity ?? 0,
          source: 'bridge' as const,
          fetchedAt: now,
        }));

        const adapters = createAdapters(ctx.vendors);
        const config: BomQualityConfig = {
          ...DEFAULT_BOM_QUALITY_CONFIG,
          lowStockThreshold: lowStockThreshold ?? DEFAULT_BOM_QUALITY_CONFIG.lowStockThreshold,
          requireMpn: requireMpn ?? DEFAULT_BOM_QUALITY_CONFIG.requireMpn,
          requireFootprint: requireFootprint ?? DEFAULT_BOM_QUALITY_CONFIG.requireFootprint,
          staleVendorDataSeconds:
            staleVendorDataSeconds ?? DEFAULT_BOM_QUALITY_CONFIG.staleVendorDataSeconds,
          minimumQualityScore:
            minimumQualityScore ?? DEFAULT_BOM_QUALITY_CONFIG.minimumQualityScore,
        };

        const report = await generateBomQualityReport(projectId, entries, adapters, config);

        return {
          bom_id: report.bomId,
          generated_at: report.generatedAt,
          total_entries: report.totalEntries,
          summary: {
            total_issues: report.summary.totalIssues,
            errors: report.summary.errors,
            warnings: report.summary.warnings,
            info: report.summary.info,
            unavailable_count: report.summary.unavailableCount,
            single_source_count: report.summary.singleSourceCount,
            missing_mpn_count: report.summary.missingMpnCount,
            missing_footprint_count: report.summary.missingFootprintCount,
            low_stock_count: report.summary.lowStockCount,
            unauthorized_count: report.summary.unauthorizedCount,
            rate_limited_count: report.summary.rateLimitedCount,
            timeout_count: report.summary.timeoutCount,
            invalid_response_count: report.summary.invalidResponseCount,
            stale_vendor_data_count: report.summary.staleVendorDataCount,
            missing_vendor_data_count: report.summary.missingVendorDataCount,
            package_mismatch_count: report.summary.packageMismatchCount,
            manufacturer_risk_count: report.summary.manufacturerRiskCount,
            lifecycle_risk_count: report.summary.lifecycleRiskCount,
            no_safe_alternate_count: report.summary.noSafeAlternateCount,
            high_risk_component_count: report.summary.highRiskComponentCount,
          },
          entries: report.entries.map((e) => ({
            reference: e.reference,
            description: e.description,
            footprint: e.footprint,
            quantity: e.quantity,
            lcsc: e.lcsc,
            mpn: e.mpn,
            manufacturer: e.manufacturer,
            supplier_data: e.supplierData.map((s) => ({
              supplier: s.supplier,
              status: s.status,
              found: s.found,
              source: s.source,
              queried_at: s.queriedAt,
              cache_age_seconds: s.cacheAgeSeconds,
              from_cache: s.fromCache,
              confidence: s.confidence,
              reason: s.reason,
              status_code: s.statusCode,
              stock: s.stock,
              lifecycle: s.lifecycle,
              unit_price: s.unitPrice,
              currency: s.currency,
              lead_time_days: s.leadTimeDays,
            })),

            component_quality: {
              score: e.componentQuality.score,
              risk: e.componentQuality.risk,
              recommended_action: e.componentQuality.recommendedAction,
              dimensions: e.componentQuality.dimensions,
              alternates: e.componentQuality.alternates.map((candidate) => ({
                supplier: candidate.supplier,
                mpn: candidate.mpn,
                lcsc: candidate.lcsc,
                manufacturer: candidate.manufacturer,
                description: candidate.description,
                lifecycle: candidate.lifecycle,
                stock: candidate.stock,
                unit_price: candidate.unitPrice,
                currency: candidate.currency,
                compatibility: candidate.compatibility,
                score: candidate.score,
                reasons: candidate.reasons,
                caveats: candidate.caveats,
              })),
              provenance: {
                supplier_count: e.componentQuality.provenance.supplierCount,
                found_supplier_count: e.componentQuality.provenance.foundSupplierCount,
                live_supplier_count: e.componentQuality.provenance.liveSupplierCount,
                cached_supplier_count: e.componentQuality.provenance.cachedSupplierCount,
                oldest_cache_age_seconds: e.componentQuality.provenance.oldestCacheAgeSeconds,
                newest_query_at: e.componentQuality.provenance.newestQueryAt,
              },
            },
            issues: e.issues.map((i) => ({
              type: i.type,
              severity: i.severity,
              reference: i.reference,
              message: i.message,
              details: i.details,
            })),
          })),
          has_supplier_errors: report.hasSupplierErrors,
        };
      } catch (err) {
        return {
          bom_id: projectId,
          generated_at: new Date().toISOString(),
          total_entries: 0,
          summary: {
            total_issues: 0,
            errors: 0,
            warnings: 0,
            info: 0,
            unavailable_count: 0,
            single_source_count: 0,
            missing_mpn_count: 0,
            missing_footprint_count: 0,
            low_stock_count: 0,
            unauthorized_count: 0,
            rate_limited_count: 0,
            timeout_count: 0,
            invalid_response_count: 0,
            stale_vendor_data_count: 0,
            missing_vendor_data_count: 0,
            package_mismatch_count: 0,
            manufacturer_risk_count: 0,
            lifecycle_risk_count: 0,
            no_safe_alternate_count: 0,
            high_risk_component_count: 0,
          },
          entries: [],
          has_supplier_errors: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerBomSourcingTools };
