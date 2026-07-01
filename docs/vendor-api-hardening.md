# Vendor API Hardening

EasyEDA MCP Pro treats supplier and fabrication integrations as optional external data sources. Vendor failures must never crash a design review. Instead, tools return structured low-confidence data with provenance, freshness, and a machine-readable status.

## Supported integrations

| Vendor           | Purpose                                             | Required credentials                                                          | Default state                         | Notes                                                                               |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| LCSC / jlcsearch | Component lookup, stock, price hints                | None for public jlcsearch; optional LCSC API key for official fallback        | Enabled when `JLCSEARCH_ENABLED=true` | Public search can be unavailable or incomplete.                                     |
| Mouser           | Component search by MPN, stock, price hints         | `MOUSER_API_KEY` when `MOUSER_ENABLED=true`                                   | Disabled                              | Returns no-match, unauthorized, rate-limited, or unavailable statuses.              |
| DigiKey          | Component search by MPN/keyword, stock, price hints | `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET` when `DIGIKEY_ENABLED=true`   | Disabled, sandbox by default          | OAuth token failures are degraded to unauthorized/unavailable sourcing results.     |
| JLCPCB           | Fabrication quote/capability/order APIs             | `JLCPCB_CLIENT_ID` and `JLCPCB_CLIENT_SECRET` when `JLCPCB_MODE=approved_api` | Disabled                              | Order placement remains separately gated by ordering flags and confirmation policy. |

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

The current implementation returns live data with `from_cache=false` and `cache_age_seconds=0`. The fields are present now so future cache implementations can preserve a stable response contract.

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
