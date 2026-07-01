import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LATENCY_BUDGETS,
  DEFAULT_RETENTION_POLICY,
  MetricsCollector,
  evaluateLatencyBudget,
  resetGlobalMetricsCollector,
} from '../../../src/observability/index.js';

describe('observability budgets and metrics', () => {
  beforeEach(() => resetGlobalMetricsCollector());

  it('evaluates latency budget status as ok warn and fail', () => {
    expect(evaluateLatencyBudget('diagnostics', 20).status).toBe('ok');
    expect(evaluateLatencyBudget('diagnostics', 300).status).toBe('warn');
    expect(evaluateLatencyBudget('diagnostics', 1500).status).toBe('fail');
  });

  it('contains default budgets for major runtime categories', () => {
    expect(DEFAULT_LATENCY_BUDGETS.map((budget) => budget.category)).toEqual(
      expect.arrayContaining([
        'diagnostics',
        'bridge-read',
        'bridge-write',
        'vendor-api',
        'cache',
        'export',
      ]),
    );
  });

  it('records timing, vendor and cache metrics', () => {
    const collector = new MetricsCollector();
    collector.recordTimed({
      category: 'analysis',
      name: 'local-rule-check',
      durationMs: 42,
      ok: true,
    });
    collector.recordTimed({
      category: 'diagnostics',
      name: 'slow-diagnostic',
      durationMs: 1200,
      ok: false,
    });
    collector.recordCache('hit');
    collector.recordCache('miss');
    collector.recordCache('write');
    collector.recordVendor('vendor.example', 250, true, 200);

    const snapshot = collector.snapshot();

    expect(snapshot.byCategory.analysis.count).toBe(1);
    expect(snapshot.byCategory.diagnostics.errors).toBe(1);
    expect(snapshot.budgetFailures).toBe(1);
    expect(snapshot.cache.hitRate).toBe(0.5);
    expect(snapshot.vendors['vendor.example']).toMatchObject({
      requestCount: 1,
      errorCount: 0,
      averageDurationMs: 250,
      lastStatusCode: 200,
    });
  });

  it('defines bounded retention defaults', () => {
    expect(DEFAULT_RETENTION_POLICY.artifactRetentionDays).toBeGreaterThan(0);
    expect(DEFAULT_RETENTION_POLICY.telemetryRetentionDays).toBeGreaterThan(0);
    expect(DEFAULT_RETENTION_POLICY.maxArtifactBytes).toBeGreaterThan(1024);
  });
});
