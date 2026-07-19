# Configuration

All configuration is managed using environment variables. When running locally from source, you can define them in a `.env` file in the root directory. When running via `npx`, they are passed as environment variables in your client config JSON.

## Boolean literals

Boolean environment variables accept only `true`, `false`, `1`, or `0`. Text matching is case-insensitive and surrounding whitespace is ignored. Do not use `yes` / `no`, `on` / `off`, `enabled` / `disabled`, or an empty value; unsupported literals and typos stop startup with a validation error naming the variable. Leave a variable unset to use its documented default. Native boolean values remain supported for programmatic configuration and tests.

---

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
