import { evaluateLatencyBudget, type ObservabilityCategory } from './budgets.js';

export interface TimedMetricInput {
  category: ObservabilityCategory;
  name: string;
  durationMs: number;
  ok: boolean;
}

export interface MetricEvent extends TimedMetricInput {
  observedAt: string;
  budgetStatus: 'ok' | 'warn' | 'fail';
}

export interface CacheMetricsSnapshot {
  hits: number;
  misses: number;
  writes: number;
  deletes: number;
  hitRate: number;
}

export interface VendorMetricsSnapshot {
  requestCount: number;
  errorCount: number;
  averageDurationMs: number;
  lastStatusCode?: number;
}

export interface MetricsSnapshot {
  generatedAt: string;
  startedAt: string;
  toolCalls: number;
  bridgeCalls: number;
  budgetWarnings: number;
  budgetFailures: number;
  recentEvents: MetricEvent[];
  byCategory: Record<
    string,
    {
      count: number;
      ok: number;
      errors: number;
      averageDurationMs: number;
      maxDurationMs: number;
    }
  >;
  cache: CacheMetricsSnapshot;
  vendors: Record<string, VendorMetricsSnapshot>;
}

type CategoryStats = {
  count: number;
  ok: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export class MetricsCollector {
  private readonly startedAt = new Date().toISOString();
  private events: MetricEvent[] = [];
  private categoryStats = new Map<ObservabilityCategory, CategoryStats>();
  private cacheStats = { hits: 0, misses: 0, writes: 0, deletes: 0 };
  private vendorStats = new Map<
    string,
    { count: number; errors: number; totalDurationMs: number; lastStatusCode?: number }
  >();

  constructor(private readonly maxEvents = 200) {}

  recordTimed(input: TimedMetricInput): MetricEvent {
    const budget = evaluateLatencyBudget(input.category, input.durationMs);
    const event: MetricEvent = {
      ...input,
      observedAt: new Date().toISOString(),
      budgetStatus: budget.status,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events = this.events.slice(-this.maxEvents);

    const stats = this.categoryStats.get(input.category) ?? {
      count: 0,
      ok: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    stats.count += 1;
    if (input.ok) stats.ok += 1;
    else stats.errors += 1;
    stats.totalDurationMs += input.durationMs;
    stats.maxDurationMs = Math.max(stats.maxDurationMs, input.durationMs);
    this.categoryStats.set(input.category, stats);
    return event;
  }

  recordCache(result: 'hit' | 'miss' | 'write' | 'delete'): void {
    if (result === 'hit') this.cacheStats.hits += 1;
    else if (result === 'miss') this.cacheStats.misses += 1;
    else if (result === 'write') this.cacheStats.writes += 1;
    else this.cacheStats.deletes += 1;
  }

  recordVendor(vendor: string, durationMs: number, ok: boolean, statusCode?: number): void {
    this.recordTimed({ category: 'vendor-api', name: vendor, durationMs, ok });
    const stats = this.vendorStats.get(vendor) ?? { count: 0, errors: 0, totalDurationMs: 0 };
    stats.count += 1;
    if (!ok) stats.errors += 1;
    stats.totalDurationMs += durationMs;
    stats.lastStatusCode = statusCode;
    this.vendorStats.set(vendor, stats);
  }

  snapshot(): MetricsSnapshot {
    const byCategory: MetricsSnapshot['byCategory'] = {};
    for (const [category, stats] of this.categoryStats.entries()) {
      byCategory[category] = {
        count: stats.count,
        ok: stats.ok,
        errors: stats.errors,
        averageDurationMs: round(stats.count === 0 ? 0 : stats.totalDurationMs / stats.count),
        maxDurationMs: round(stats.maxDurationMs),
      };
    }

    const vendorSnapshot: Record<string, VendorMetricsSnapshot> = {};
    for (const [vendor, stats] of this.vendorStats.entries()) {
      vendorSnapshot[vendor] = {
        requestCount: stats.count,
        errorCount: stats.errors,
        averageDurationMs: round(stats.count === 0 ? 0 : stats.totalDurationMs / stats.count),
        lastStatusCode: stats.lastStatusCode,
      };
    }

    const cacheTotal = this.cacheStats.hits + this.cacheStats.misses;
    return {
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      toolCalls: Array.from(this.categoryStats.entries())
        .filter(
          ([category]) =>
            category !== 'bridge-read' && category !== 'bridge-write' && category !== 'vendor-api',
        )
        .reduce((total, [, stats]) => total + stats.count, 0),
      bridgeCalls:
        (this.categoryStats.get('bridge-read')?.count ?? 0) +
        (this.categoryStats.get('bridge-write')?.count ?? 0),
      budgetWarnings: this.events.filter((event) => event.budgetStatus === 'warn').length,
      budgetFailures: this.events.filter((event) => event.budgetStatus === 'fail').length,
      recentEvents: [...this.events].slice(-25),
      byCategory,
      cache: {
        hits: this.cacheStats.hits,
        misses: this.cacheStats.misses,
        writes: this.cacheStats.writes,
        deletes: this.cacheStats.deletes,
        hitRate: round(cacheTotal === 0 ? 0 : this.cacheStats.hits / cacheTotal),
      },
      vendors: vendorSnapshot,
    };
  }

  reset(): void {
    this.events = [];
    this.categoryStats.clear();
    this.cacheStats = { hits: 0, misses: 0, writes: 0, deletes: 0 };
    this.vendorStats.clear();
  }
}

let globalMetricsCollector = new MetricsCollector();

export function getGlobalMetricsCollector(): MetricsCollector {
  return globalMetricsCollector;
}

export function resetGlobalMetricsCollector(): void {
  globalMetricsCollector = new MetricsCollector();
}
