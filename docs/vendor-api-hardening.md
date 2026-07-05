# Vendor API Hardening

EasyEDA MCP Pro treats supplier and fabrication integrations as optional external data sources. Vendor failures must never crash a design review. Instead, tools return structured low-confidence data with provenance, freshness, and a machine-readable status.

## Supported integrations

| Vendor           | Purpose                                             | Required credentials                                                          | Default state                                                             | Notes                                                                               |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| LCSC / jlcsearch | Component lookup, stock, price, attributes          | None for public jlcsearch; optional LCSC API key for official fallback        | Enabled when `JLCSEARCH_ENABLED=true` and `KEYLESS_SOURCING_ENABLED=true` | Keyless tier only; category-scoped, in-stock-first snapshot (see below).            |
| Mouser           | Component search by MPN, stock, price hints         | `MOUSER_API_KEY` when `MOUSER_ENABLED=true`                                   | Disabled                                                                  | Returns no-match, unauthorized, rate-limited, or unavailable statuses.              |
| DigiKey          | Component search by MPN/keyword, stock, price hints | `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET` when `DIGIKEY_ENABLED=true`   | Disabled, sandbox by default                                              | OAuth token failures are degraded to unauthorized/unavailable sourcing results.     |
| JLCPCB           | Fabrication quote/capability/order APIs             | `JLCPCB_CLIENT_ID` and `JLCPCB_CLIENT_SECRET` when `JLCPCB_MODE=approved_api` | Disabled                                                                  | Order placement remains separately gated by ordering flags and confirmation policy. |

## Keyless sourcing tier (LCSC / jlcsearch)

`KEYLESS_SOURCING_ENABLED` (default `true`) governs whether sourcing tools attempt the
keyless LCSC tier. `JLCSEARCH_ENABLED` (default `true`) governs whether the underlying
LCSC client is constructed at all; both must be true for keyless LCSC lookups to run.

The public jlcsearch API (`https://jlcsearch.tscircuit.com`) is a set of per-category
snapshots, not a general-purpose search engine:

- Each category (`resistors`, `capacitors`, `diodes`, `mosfets`, `leds`,
  `microcontrollers`, `switches`, `led_drivers`) is served from its own
  `/{category}/list.json` endpoint and returns only the ~100 highest-stock parts in
  that category.
- There is no generic cross-category full-text search and no single-part lookup
  endpoint. `easyeda_bom_sourcing`'s keyless candidates are derived by matching
  keywords/packages to a category and, for `getPartDetail`, scanning the cached
  per-category snapshots for a matching LCSC id.
- **Known limitation**: a part outside the top in-stock snapshot for its category will
  not be found via the keyless tier, even though it exists at LCSC. This is a property
  of the public dataset, not a bug — it is why supplier data remains advisory (see
  `docs/vendor-terms.md`).
- Each result reports `classification` (`basic` / `preferred` / `extended`, LCSC/JLCPCB
  assembly terms) and `attributes` (parametric key/value pairs) when the source
  provides them.

Category responses are cached under `${CACHE_DIR}/vendors` for `SOURCING_CACHE_TTL_SECONDS`
(default 6 hours) to reduce load on the public endpoint. Outbound vendor requests are
additionally throttled per-hostname by `VENDOR_MIN_REQUEST_INTERVAL_MS` (default 150ms).
Sourcing results report `from_cache` / `cache_age_seconds` so callers can tell live data
from a cached snapshot.

`easyeda_bom_sourcing` and `easyeda_bom_quality_report` unify keyless (LCSC) and
authenticated (Mouser, DigiKey) suppliers behind `src/vendors/sourcing-facade.ts` /
`src/bom-quality/adapter.ts`; each sourcing result reports which `tier` (`keyless` or
`authenticated`) answered.

## Normalized supplier statuses

BOM sourcing results use the following supplier statuses:

| Status             | Meaning                                                              | Tool behavior                                                       |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `found`            | Supplier returned a matching part.                                   | Result is usable, confidence high/medium.                           |
| `no_match`         | Query succeeded but no part matched.                                 | Not a transport error; confidence medium.                           |
| `unavailable`      | Vendor API/network is unavailable or returned a server-side failure. | Report continues and marks supplier data low confidence.            |
| `unauthorized`     | Missing/rejected credentials or HTTP authorization failure.          | Report continues and tells the user which vendor needs credentials. |
| `rate_limited`     | Vendor rate limit was hit.                                           | Report continues with warning-level issue and retry guidance.       |
| `timeout`          | Request timed out or was aborted.                                    | Report continues with warning-level issue.                          |
| `invalid_response` | Vendor returned malformed/unparseable data.                          | Report continues with error-level issue.                            |

## Provenance and freshness

Every `easyeda_bom_quality_report` supplier datum includes:

- `supplier`
- `status`
- `source`
- `queried_at`
- `cache_age_seconds`
- `from_cache`
- `confidence`
- optional `reason`
- optional `status_code`

LCSC keyless-tier lookups populate real `from_cache` / `cache_age_seconds` values once a
category snapshot has been cached (see "Keyless sourcing tier" above). Mouser and
DigiKey queries are not yet cached and always report `from_cache=false` /
`cache_age_seconds=0`; the fields remain present for a stable response contract as that
caching is added.

## Credential diagnostics

Run:

```bash
npx easyeda-mcp-pro doctor
```

The doctor output reports each vendor as enabled/disabled, configured/missing, credential status, and mode. LCSC public jlcsearch does not require a credential, while Mouser, DigiKey, and JLCPCB require credentials when their feature flags are enabled.

## Safety and privacy rules

- Vendor errors are sanitized before they enter tool output.
- Tool output must not include API keys, OAuth tokens, client secrets, authorization headers, or raw credential values.
- Vendor data is advisory. Users should verify lifecycle, price, stock, and substitution decisions before procurement or manufacturing.
- JLCPCB ordering remains a high-risk workflow and must require explicit user confirmation and appropriate feature flags.

## Failure-mode test coverage

The unit suite covers:

- no-match responses;
- network/API failure degradation;
- rate-limit classification;
- unauthorized/credential failure classification;
- timeout classification;
- invalid JSON/response classification;
- BOM report summary counts for degraded supplier statuses;
- doctor formatting for vendor credential diagnostics.
