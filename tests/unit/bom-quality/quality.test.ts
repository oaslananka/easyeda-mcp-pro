import { describe, it, expect, vi } from 'vitest';
import { generateBomQualityReport } from '../../../src/bom-quality/quality.js';
import { LcscAdapter, MouserAdapter, DigiKeyAdapter } from '../../../src/bom-quality/adapter.js';
import type { BomEntry, AdapterMap } from '../../../src/bom-quality/types.js';
import { DEFAULT_BOM_QUALITY_CONFIG } from '../../../src/bom-quality/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockAdapters(overrides?: {
  lcsc?: Partial<LcscAdapter>;
  mouser?: Partial<MouserAdapter>;
  digikey?: Partial<DigiKeyAdapter>;
}): AdapterMap {
  return {
    lcsc: {
      kind: 'lcsc',
      displayName: 'LCSC',
      isAvailable: vi.fn().mockReturnValue(true),
      queryPart: vi.fn().mockResolvedValue(null),
      ...overrides?.lcsc,
    } as any,
    mouser: {
      kind: 'mouser',
      displayName: 'Mouser',
      isAvailable: vi.fn().mockReturnValue(true),
      queryPart: vi.fn().mockResolvedValue(null),
      ...overrides?.mouser,
    } as any,
    digikey: {
      kind: 'digikey',
      displayName: 'DigiKey',
      isAvailable: vi.fn().mockReturnValue(true),
      queryPart: vi.fn().mockResolvedValue(null),
      ...overrides?.digikey,
    } as any,
  };
}

const now = new Date().toISOString();
function entry(overrides: Partial<BomEntry> & { reference: string }): BomEntry {
  return {
    value: 'Resistor',
    footprint: 'RES-0805',
    quantity: 1,
    source: 'bridge',
    fetchedAt: now,
    mpn: 'CRCW080510K0',
    manufacturer: 'Vishay',
    ...overrides,
  };
}

function activeResult(overrides?: Record<string, unknown>) {
  return {
    supplier: 'lcsc',
    found: true,
    lifecycle: 'active',
    stock: 5000,
    queriedAt: now,
    confidence: 'high',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('generateBomQualityReport', () => {
  it('returns an empty report for no entries', async () => {
    const adapters = mockAdapters();
    const report = await generateBomQualityReport('bom-1', [], adapters);

    expect(report.bomId).toBe('bom-1');
    expect(report.totalEntries).toBe(0);
    expect(report.summary.totalIssues).toBe(0);
    expect(report.hasSupplierErrors).toBe(false);
  });

  it('flags an entry as unavailable when no supplier has it', async () => {
    const adapters = mockAdapters({
      lcsc: { queryPart: vi.fn().mockResolvedValue(activeResult({ found: false })) } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'R1', lcsc: 'C99999' })],
      adapters,
    );

    expect(report.totalEntries).toBe(1);
    expect(report.summary.unavailableCount).toBe(1);
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);
    expect(report.entries[0]!.issues[0]!.type).toBe('unavailable');
  });

  it('flags discontinued parts as unavailable', async () => {
    const adapters = mockAdapters({
      lcsc: {
        queryPart: vi
          .fn()
          .mockResolvedValue(activeResult({ found: true, lifecycle: 'discontinued' })),
      } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'U1', lcsc: 'C55555' })],
      adapters,
    );

    expect(report.summary.unavailableCount).toBe(1);
    const issue = report.entries[0]!.issues.find((i) => i.type === 'unavailable');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('discontinued');
  });

  it('flags single-source parts when multiple suppliers are available', async () => {
    const adapters = mockAdapters({
      lcsc: { queryPart: vi.fn().mockResolvedValue(activeResult()) } as any,
      mouser: { queryPart: vi.fn().mockResolvedValue(null) } as any,
      digikey: { queryPart: vi.fn().mockResolvedValue(null) } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'R1', lcsc: 'C12345' })],
      adapters,
    );

    // LCSC has it but Mouser+DigiKey don't (queried because entry has mpn)
    // Since both mouser and digikey are available and were queried but only lcsc found it
    expect(report.summary.singleSourceCount).toBeGreaterThanOrEqual(1);
  });

  it('flags missing MPN when requireMpn is true and no mpn or manufacturer', async () => {
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'C1', mpn: undefined, manufacturer: undefined })],
      mockAdapters(),
      DEFAULT_BOM_QUALITY_CONFIG,
    );

    expect(report.summary.missingMpnCount).toBe(1);
    expect(report.entries[0]!.issues[0]!.type).toBe('missing_mpn');
  });

  it('flags missing footprint when requireFootprint is true and no footprint', async () => {
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'C1', footprint: undefined })],
      mockAdapters(),
      DEFAULT_BOM_QUALITY_CONFIG,
    );

    expect(report.summary.missingFootprintCount).toBe(1);
  });

  it('flags low stock when stock is below threshold', async () => {
    const adapters = mockAdapters({
      lcsc: {
        queryPart: vi.fn().mockResolvedValue(activeResult({ stock: 5 })),
      } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'R1', lcsc: 'C12345' })],
      adapters,
      { ...DEFAULT_BOM_QUALITY_CONFIG, lowStockThreshold: 100 },
    );

    expect(report.summary.lowStockCount).toBe(1);
  });

  it('does not flag low stock when stock is above threshold', async () => {
    const adapters = mockAdapters({
      lcsc: {
        queryPart: vi.fn().mockResolvedValue(activeResult({ stock: 9999 })),
      } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'R2', lcsc: 'C12345' })],
      adapters,
    );

    expect(report.summary.lowStockCount).toBe(0);
  });

  it('surfaces rate-limited supplier status without crashing the report', async () => {
    const adapters = mockAdapters({
      mouser: {
        queryPart: vi.fn().mockResolvedValue({
          supplier: 'mouser',
          status: 'rate_limited',
          found: false,
          lifecycle: 'unknown',
          stock: 0,
          queriedAt: '2026-06-11T21:00:01.000Z',
          source: 'mouser:search-api',
          cacheAgeSeconds: 0,
          fromCache: false,
          confidence: 'low',
          reason: 'rate limit exceeded',
          statusCode: 429,
        }),
      } as any,
    });

    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'U2', mpn: 'OPA123' })],
      adapters,
    );

    expect(report.hasSupplierErrors).toBe(true);
    expect(report.summary.rateLimitedCount).toBe(1);
    const issue = report.entries[0]!.issues.find((i) => i.type === 'rate_limited');
    expect(issue).toBeDefined();
    expect(issue!.details?.statusCode).toBe(429);
    expect(report.entries[0]!.supplierData[0]!.source).toBe('mouser:search-api');
  });

  it('surfaces unauthorized supplier status with source provenance', async () => {
    const adapters = mockAdapters({
      digikey: {
        queryPart: vi.fn().mockResolvedValue({
          supplier: 'digikey',
          status: 'unauthorized',
          found: false,
          lifecycle: 'unknown',
          stock: 0,
          queriedAt: '2026-06-11T21:00:01.000Z',
          source: 'digikey:product-search-api',
          cacheAgeSeconds: 0,
          fromCache: false,
          confidence: 'low',
          reason: 'credentials rejected',
          statusCode: 401,
        }),
      } as any,
    });

    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'U3', mpn: 'ATMEGA328P' })],
      adapters,
    );

    expect(report.hasSupplierErrors).toBe(true);
    expect(report.summary.unauthorizedCount).toBe(1);
    expect(report.entries[0]!.issues.some((i) => i.type === 'unauthorized')).toBe(true);
  });

  it('sets hasSupplierErrors when an adapter returns low confidence', async () => {
    const adapters = mockAdapters({
      lcsc: {
        queryPart: vi.fn().mockResolvedValue(activeResult({ found: false, confidence: 'low' })),
      } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'R1', lcsc: 'C12345' })],
      adapters,
    );

    expect(report.hasSupplierErrors).toBe(true);
  });

  it('handles mixed entries — some with issues, some clean', async () => {
    const adapters = mockAdapters({
      lcsc: {
        queryPart: vi.fn().mockImplementation(async (id: { lcsc?: string }) => {
          if (id.lcsc === 'C12345') return activeResult({ stock: 9999 });
          return activeResult({ found: false });
        }),
      } as any,
    });

    const report = await generateBomQualityReport(
      'bom-1',
      [
        entry({ reference: 'R1', lcsc: 'C12345', mpn: undefined, manufacturer: undefined }),
        entry({ reference: 'R2', lcsc: 'C99999' }),
      ],
      adapters,
    );

    expect(report.totalEntries).toBe(2);
    // R1: missing_mpn (1), R2: unavailable (1) = 2 issues
    expect(report.summary.totalIssues).toBeGreaterThanOrEqual(2);
  });

  it('respects config.requireMpn = false', async () => {
    const report = await generateBomQualityReport(
      'bom-1',
      [entry({ reference: 'C1', mpn: undefined, manufacturer: undefined })],
      mockAdapters(),
      { ...DEFAULT_BOM_QUALITY_CONFIG, requireMpn: false },
    );

    expect(report.summary.missingMpnCount).toBe(0);
  });

  it('has correct summary counts with multiple issue types', async () => {
    const adapters = mockAdapters({
      lcsc: {
        queryPart: vi.fn().mockResolvedValue(activeResult({ stock: 10 })),
      } as any,
    });
    const report = await generateBomQualityReport(
      'bom-1',
      [
        entry({
          reference: 'R1',
          lcsc: 'C12345',
          footprint: undefined,
          mpn: undefined,
          manufacturer: undefined,
        }),
      ],
      adapters,
      DEFAULT_BOM_QUALITY_CONFIG,
    );

    // R1 with lcsc code found at LCSC but low stock (10 < 100) + missing mpn + missing footprint
    expect(report.summary.lowStockCount).toBe(1);
    expect(report.summary.missingMpnCount).toBe(1);
    expect(report.summary.missingFootprintCount).toBe(1);
    expect(report.summary.totalIssues).toBe(3);
  });
});
