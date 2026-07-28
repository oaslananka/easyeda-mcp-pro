# Configuration

All configuration is managed using environment variables. When running locally from source, you can define them in a `.env` file in the root directory. When running via `npx`, they are passed as environment variables in your client config JSON.

## Boolean literals

Boolean environment variables accept only `true`, `false`, `1`, or `0`. Text matching is case-insensitive and surrounding whitespace is ignored. Do not use `yes` / `no`, `on` / `off`, `enabled` / `disabled`, or an empty value; unsupported literals and typos stop startup with a validation error naming the variable. Leave a variable unset to use its documented default. Native boolean values remain supported for programmatic configuration and tests.

---

## Storage paths

`DATA_DIR` is the base for writable local state. When it is unset, the server uses `~/.easyeda-mcp-pro`. The server resolves `DATA_DIR` first and derives any unset subordinate paths from it:

| Variable       | Derived default                     |
| -------------- | ----------------------------------- |
| `SQLITE_PATH`  | `<DATA_DIR>/easyeda-mcp-pro.sqlite` |
| `ARTIFACT_DIR` | `<DATA_DIR>/artifacts`              |
| `CACHE_DIR`    | `<DATA_DIR>/cache`                  |

Setting only the base directory relocates all three defaults:

```ini
DATA_DIR=/srv/easyeda-mcp-pro
```

This resolves the database to `/srv/easyeda-mcp-pro/easyeda-mcp-pro.sqlite`, artifacts to `/srv/easyeda-mcp-pro/artifacts`, and cache files to `/srv/easyeda-mcp-pro/cache`. Native separators are used on Windows.

Each subordinate variable remains an independent override. Leave it unset to inherit from `DATA_DIR`, or set it explicitly when one path needs a different location. Explicit relative values remain relative to the MCP process working directory and are not converted to absolute paths. Changing path settings does not move existing data; migrate or remove old state manually after stopping the server.

---

## Sourcing request controls

The sourcing facade applies shared controls before calling LCSC, Mouser, DigiKey, or other supported vendor paths:

| Variable                         | Default | Behavior                                                             |
| -------------------------------- | ------- | -------------------------------------------------------------------- |
| `KEYLESS_SOURCING_ENABLED`       | `true`  | Allows supported public fallbacks when vendor credentials are absent |
| `SOURCING_CACHE_TTL_SECONDS`     | `21600` | Reuses cached sourcing responses for six hours; `0` disables reuse   |
| `VENDOR_MIN_REQUEST_INTERVAL_MS` | `150`   | Enforces a minimum delay between requests to the same vendor         |

These controls do not enable ordering and do not bypass vendor authentication requirements. Disable keyless sourcing when deployment policy requires credentialed vendor access only.

---

## Tool Profiles

The active tool set is gated by the `TOOL_PROFILE` environment variable.

`TOOL_SCOPES` can optionally add a second capability allowlist. Leave it empty for the default local all-capabilities mode, or set comma/space separated scopes such as `schematic:read,bom:read,export:write`.

Mutation tools accept an optional `writeMode` control. Use `plan` or `preview` to validate and inspect a pending change without touching EasyEDA, then use the default `apply` mode with `confirmWrite=true` only after user approval. Use `verify` as a non-mutating checkpoint before running read-only diagnostics after an apply.

| Profile          | Level   | Purpose                                                                                                                            |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `core` (default) | L0 + L1 | Standard read-only and inspection tools (schematic components, nets, stackup, layers, export Gerbers).                             |
| `pro`            | L1+     | Includes Gerber, Pick & Place, BOM, schematic/PCB PDF, and netlist export tools.                                                   |
| `full`           | L0-L1   | Adds the generic controlled documented `easyeda_api_call` tool, enabling custom interactions. Mutation calls require confirmation. |
| `dev`            | Dev     | Adds diagnostic component probes and WebSocket bridge diagnostics.                                                                 |

Configure this in your client environment configuration:

```json
"env": {
  "TOOL_PROFILE": "pro",
  "TOOL_SCOPES": "schematic:read,bom:read,checks:read,export:write"
}
```

---

## Feature maturity and reserved settings

A variable being accepted by the environment schema does not necessarily mean that a runtime
feature is active. `easyeda_get_feature_flags`, `easyeda_get_capabilities`, and
`easyeda_get_server_config` expose a maturity report with separate `configured` and `effective`
values.

| Settings                                                                                               | Maturity     | Runtime effect                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------- |
| `MCP_TASKS_ENABLED`                                                                                    | Reserved     | Parsed for compatibility; the server does not advertise or execute MCP Tasks.                   |
| `MCP_APPS_ENABLED`                                                                                     | Reserved     | Parsed for compatibility; no Apps UI/resource runtime is registered.                            |
| `MCP_V2_EXPERIMENTAL`                                                                                  | Reserved     | Does not change protocol negotiation. Use `MCP_PROTOCOL_VERSION` only with a supported version. |
| `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, `AI_MAX_TOKENS`, `AI_TIMEOUT_MS`, `AI_ALLOW_DESIGN_MUTATIONS` | Reserved     | No in-process AI provider is called and no AI design mutation is enabled.                       |
| `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `TRACE_SAMPLE_RATE`                | Reserved     | No OTLP exporter is started; local structured metrics remain available.                         |
| `MCP_BRIDGE_BACKEND=remote_relay`                                                                      | Experimental | Activates the implemented paired relay path with documented non-Beta limitations.               |
| Raw execution gates                                                                                    | Experimental | Effective only when both explicit development-only gates are enabled; refused in production.    |
| OAuth/JWKS settings                                                                                    | Implemented  | Enforced for non-loopback HTTP and used for token validation.                                   |

Reserved settings report `effective: false` even when configured. They are retained so future
implementation can avoid unnecessary configuration churn, but must not be presented as shipped
product capabilities.

---

## Supplier Sourcing Configuration

Suppliers are optional and disabled by default. Set the following variables to enable integrations:

### LCSC (Electronic Components)

- `JLCSEARCH_ENABLED=true` (Default is true, does not require API keys for basic inventory lookups).

### Mouser Electronics

- `MOUSER_ENABLED=true`
- `MOUSER_API_KEY=your-mouser-api-key`

### DigiKey Electronics

- `DIGIKEY_ENABLED=true`
- `DIGIKEY_CLIENT_ID=your-client-id`
- `DIGIKEY_CLIENT_SECRET=your-client-secret`

### JLCPCB Fabrication

- `JLCPCB_MODE=approved_api`
- `JLCPCB_CLIENT_ID=your-client-id`
- `JLCPCB_CLIENT_SECRET=your-client-secret`

---

## Transport Configuration

By default, the server uses standard I/O (stdio) transport. To run as an HTTP server:

```ini
TRANSPORT=http
HTTP_HOST=127.0.0.1
HTTP_PORT=3000
HTTP_RATE_LIMIT_MAX=100
```

Loopback HTTP deployments validate browser `Origin` headers and only accept loopback `Host` headers. For browser tooling running on a local development port, use the default loopback host or set `CORS_ORIGIN` / `ALLOWED_ORIGINS` explicitly.

### Remote Security for HTTP

For every non-loopback HTTP deployment, OAuth 2.0 validation is mandatory regardless of `NODE_ENV`:

```ini
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-identity-provider.com
OAUTH_JWKS_URI=https://your-identity-provider.com/.well-known/jwks.json
OAUTH_AUDIENCE=easyeda-mcp-pro
ALLOWED_ORIGINS=https://your-client.example.com
```

_Note: Non-loopback `HTTP_HOST` (e.g., `0.0.0.0`) without complete OAuth settings is rejected at startup in development, test, and production. `ALLOWED_ORIGINS=*` is also rejected because CORS does not authenticate non-browser clients._

### Raw execution quarantine

`easyeda_execute` is not registered by default. To expose it for local debugging you must set both `BRIDGE_RAW_EXEC_ENABLED=true` and `MCP_RAW_EXEC_EXPERIMENTAL=true`. When `TOOL_SCOPES` is set, include `bridge:execute` as well. Do not enable these settings in production.
