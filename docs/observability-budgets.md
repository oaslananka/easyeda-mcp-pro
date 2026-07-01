# Performance and Observability Budgets

Production-grade agent workflows need predictable runtime behavior. EasyEDA MCP Pro exposes latency budgets, in-memory metrics, vendor timing, cache counters, and retention expectations through a diagnostics tool.

## Tool

```text
easyeda_observability_report
```

The tool is read-only and returns:

- latency budgets by category;
- runtime metrics snapshot;
- cache hit/miss/write/delete counters;
- vendor API timing summary;
- storage and artifact retention policy;
- default bridge timeout policy.

## Latency budgets

| Category        |    P50 |    P95 | Timeout | Scope                                                 |
| --------------- | -----: | -----: | ------: | ----------------------------------------------------- |
| `diagnostics`   |  50 ms | 250 ms |     1 s | Local diagnostics and metadata-only tools             |
| `bridge-read`   | 250 ms |  1.5 s |    15 s | Read-only EasyEDA bridge calls                        |
| `bridge-write`  | 500 ms |    3 s |    30 s | Confirmed bridge write/apply calls                    |
| `vendor-api`    | 800 ms |    5 s |    30 s | External vendor API requests including retry overhead |
| `cache`         |  10 ms |  50 ms |  250 ms | SQLite cache and metadata lookups                     |
| `export`        |    1 s |   10 s |    60 s | Manufacturing/export generation workflows             |
| `analysis`      | 100 ms |    1 s |     5 s | Local DRC/ERC, BOM, power-tree, PCB and QA analysis   |
| `documentation` |  50 ms | 500 ms |     2 s | Generated docs, summaries and manifests               |

Budget evaluation uses three states:

```text
ok   -> duration <= p95 budget
warn -> duration > p95 budget but <= timeout budget
fail -> duration > timeout budget
```

## Runtime metrics

The in-memory metrics collector records:

```typescript
{
  toolCalls: number;
  bridgeCalls: number;
  budgetWarnings: number;
  budgetFailures: number;
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
  cache: {
    hits: number;
    misses: number;
    writes: number;
    deletes: number;
    hitRate: number;
  }
  vendors: Record<
    string,
    {
      requestCount: number;
      errorCount: number;
      averageDurationMs: number;
      lastStatusCode?: number;
    }
  >;
}
```

The snapshot is intentionally memory-only. It is useful for local diagnostics, Inspector sessions, CI smoke checks, and support reports. It must not include secrets or raw vendor credentials.

## Timeout behavior

Bridge calls use the configured bridge timeout unless a tool supplies a narrower timeout. Long-running live diagnostics and raw API execution accept explicit `timeoutMs` inputs with schema bounds.

Timeouts are surfaced as structured failures and recorded as failed budget events. The bridge manager also has a stale request sweep as a defensive cleanup path.

## Cache and artifact retention

Default retention policy:

| Field               | Default |
| ------------------- | ------: |
| cache default TTL   |    24 h |
| vendor cache TTL    |     7 d |
| artifact retention  |    30 d |
| telemetry retention |    14 d |
| cleanup cadence     |  manual |
| max artifact bytes  | 512 MiB |

Cache entries with explicit TTL expire automatically on read. Artifact cleanup is conservative and should be invoked explicitly before deleting handoff files.

## Regression guard

Representative unit tests cover:

- budget status evaluation;
- diagnostics output schema;
- registry-level tool duration instrumentation;
- cache hit/miss/write/delete counters;
- vendor request timing on success/failure;
- bounded retention defaults.

These tests prevent accidental removal of observability fields or unbounded retention defaults.
