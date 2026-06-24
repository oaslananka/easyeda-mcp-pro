# Security Architecture & Threat Model

This document describes the security architecture, trust boundaries, authentication mechanisms, and threat model for `easyeda-mcp-pro`. It is intended for maintainers, security reviewers, and production deployers.

---

## 1. Deployment Modes

The server supports four deployment modes, each with a distinct security posture:

| Mode            | Transport             | Authentication                        | Trust Boundary      | Threat Level   |
| :-------------- | :-------------------- | :------------------------------------ | :------------------ | :------------- |
| **Local stdio** | `stdio`               | None (process-local)                  | OS process boundary | **Low**        |
| **Local HTTP**  | `http` (127.0.0.1)    | Optional OAuth, default loopback-only | Loopback network    | **Low-Medium** |
| **Remote HTTP** | `http` (non-loopback) | **OAuth required**                    | External network    | **High**       |
| **Dev bridge**  | WebSocket (bridge)    | Optional challenge/response pairing   | Local machine       | **Low-Medium** |

### 1.1 Local stdio (default)

- The server spawns as a child process of the MCP client (Claude Desktop, Cursor, etc.).
- Communication occurs over standard input/output — no network socket is opened.
- No authentication is needed because the OS process boundary provides isolation.
- **Trust model**: The MCP client is trusted. Any process that can interact with the server's stdin/stdout has full access.

### 1.2 Local HTTP

- The server listens on `127.0.0.1` (loopback only) by default.
- Rate limiting is applied (default 100 req/min per IP).
- Security headers are added to all responses.
- OAuth is optional in loopback mode; `HTTP_AUTH_DISABLED` can be set to `true` for local development.
- **Trust model**: Only processes on the same machine can reach the server. This is suitable for local AI assistants and custom integrations.

### 1.3 Remote HTTP

- The server binds to a non-loopback address (e.g., `0.0.0.0` or a specific LAN IP).
- **OAuth is mandatory** for non-loopback hosts. The server refuses to start without OAuth configuration (see §6).
- Origin validation and DNS rebinding protection are enforced.
- **Trust model**: The network is untrusted. All requests must present a valid bearer token.

### 1.4 Dev Bridge

- A WebSocket server listens on `127.0.0.1` for the EasyEDA Pro bridge extension to connect.
- When `BRIDGE_HOST` is non-loopback and `BRIDGE_TOKEN` is set, a challenge/response pairing handshake is required.
- All bridge messages are validated against a Zod schema before processing.
- Payload size is enforced (default max 1 MiB).
- **Trust model**: The bridge extension is authenticated via pairing when enabled; otherwise, loopback-only binding provides implicit trust.

---

## 2. Authentication & Authorization

### 2.1 OAuth 2.0 / OpenID Connect (HTTP transport)

When `OAUTH_ENABLED=true`, every request to `/mcp` must include an `Authorization: Bearer <token>` header.

**Validation flow:**

1. Token is extracted from the `Authorization` header.
2. Token is verified using `jose.jwtVerify` against a configured JWKS endpoint.
3. Supported signature algorithms: RS256, RS384, RS512, ES256, ES384, ES512.
4. The following claims are validated:
   - `iss` (issuer) — must match `OAUTH_ISSUER`.
   - `aud` (audience) — must match `OAUTH_AUDIENCE` (default `easyeda-mcp-pro`).
   - `exp` (expiration) — token must not be expired.
5. Token type (`typ` header) is checked — non-JWT tokens are rejected.
6. On validation failure, detailed error codes are returned: `token_expired`, `invalid_issuer`, `invalid_audience`, `invalid_signature`, `missing_auth`.

**Configuration requirements for non-loopback HTTP:**

```
OAUTH_ENABLED=true
OAUTH_ISSUER=https://your-idp.example.com
OAUTH_AUDIENCE=easyeda-mcp-pro
OAUTH_JWKS_URI=https://your-idp.example.com/.well-known/jwks.json
OAUTH_REQUIRED_SCOPES=easyeda:read
```

The server enforces a startup safety check: **non-loopback HTTP without OAuth is rejected with an error**.

### 2.2 Bridge Pairing Authentication

When the bridge runs on a non-loopback host and `BRIDGE_TOKEN` is configured, a challenge/response pairing handshake occurs:

1. Server sends a `pairing_challenge` message with a random UUID to the connecting client.
2. Client must respond with a `pairing_response` containing:
   - The echoed `challenge` UUID.
   - The correct `sessionToken` matching the server's `BRIDGE_TOKEN`.
3. If the response is missing, mismatched, or times out (10 s), the connection is closed with code `4001`.
4. After successful pairing, the client proceeds to the `handshake` phase where the session token is validated again.
5. Pending challenges are cleaned up on disconnect or timeout.

**Sequence:**

```
Server → Client: { type: "pairing_challenge", challenge: "<uuid>" }
Client → Server: { type: "pairing_response", challenge: "<uuid>", sessionToken: "<token>" }
── pairing complete ──
Client → Server: { type: "handshake", protocolVersion: "1.0.0", sessionToken: "<token>", ... }
Server → Client: { type: "hello", bridgeVersion: "1.0.0", capabilities: [...], ... }
```

### 2.3 Tool Profile Authorization

Tools are organized into hierarchical profiles: `core` < `pro` < `full` < `dev` < `experimental`.

- The `TOOL_PROFILE` environment variable selects which tools are enabled.
- Each tool definition declares a minimum `profile` level.
- Only tools at or below the active profile are registered on the MCP server.
- `core` is the default and exposes ~29 tools.
- `pro` adds manufacturing export tools (pick-and-place, PDF, netlist).
- `full` adds the controlled `easyeda_api_call` tool for direct EasyEDA API access.
- `dev` adds runtime probes for debugging (bridge method probing, component inspection).
- `experimental` enables MCP Apps, Tasks, simulation, autorouter, and AI action plans.

**Security principle:** Privilege escalation is prevented because tool registration happens at startup. Changing the active profile requires a server restart.

---

## 3. Tool-Level Safety Controls

### 3.1 `confirmWrite` Gate

All tools that can mutate design state (schematic, PCB, exports) declare `confirmWrite: true` in their definition.

At runtime, the `ToolRegistry.registerAllOnServer()` wrapper:

1. Checks whether `confirmWrite === true` in the tool definition.
2. If so, inspects the incoming call parameters for `confirmWrite: true`.
3. If absent, returns a structured error `ERR_CONFIRM_WRITE_REQUIRED` without executing the handler.

This prevents LLMs from accidentally mutating design state without explicit user acknowledgment.

Mutation tools also support a registry-level write transaction flow through `writeMode`:

- `writeMode=plan` validates the tool input and returns a structured transaction plan without calling the bridge.
- `writeMode=preview` returns a structured preview checkpoint without calling the bridge.
- `writeMode=apply` is the default execution mode and still requires `confirmWrite=true`.
- `writeMode=verify` returns a non-mutating verification checkpoint; callers should follow it with read-only diagnostics after applying a change.

The safe sequence for agents is: plan → preview → user confirmation → apply with `confirmWrite=true` → verify with read-only checks.

**Risk tiers:**

| Risk Level | Tool Type                      | Examples                                                              | confirmWrite Required |
| :--------- | :----------------------------- | :-------------------------------------------------------------------- | :-------------------- |
| **Low**    | Read-only, diagnostics         | `easyeda_health_check`, `easyeda_schematic_nets`                      | No                    |
| **Medium** | Schematic writes               | `easyeda_schematic_place_component`, `easyeda_schematic_add_wire`     | Yes                   |
| **High**   | PCB writes, exports, API calls | `easyeda_pcb_add_track`, `easyeda_export_gerbers`, `easyeda_api_call` | Yes                   |

### 3.2 Structured Error Handling

All tools return structured errors with machine-readable codes:

| Code                         | Meaning                                          |
| :--------------------------- | :----------------------------------------------- |
| `ERR_CONFIRM_WRITE_REQUIRED` | Mutation tool called without `confirmWrite=true` |
| `ERR_BRIDGE_DISCONNECTED`    | Bridge connection is not available               |
| `ERR_TOOL_EXECUTION`         | Handler threw an unexpected error                |
| `ERR_TOOL_NOT_FOUND`         | Tool name does not match a registered tool       |
| `ERR_INVALID_INPUT`          | Zod schema validation failed on input parameters |

### 3.3 Tool Registration Uniqueness

The `ToolRegistry` enforces unique tool names at registration time — duplicate registration throws an error, preventing tool shadowing or override attacks.

---

## 4. Network Security

### 4.1 HTTP Transport Security

**Rate limiting:**

- Per-IP sliding window rate limiter (default 100 requests per minute).
- Returns `429 Too Many Requests` with `retryAfterMs` and `X-RateLimit-*` headers.
- Active entries are cleaned up when the store exceeds 1000 entries.

**Security headers (applied to all HTTP responses):**
| Header | Value | Purpose |
| :----- | :---- | :------ |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `X-XSS-Protection` | `0` | Disables legacy XSS filter (preventsXSS in modern browsers) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Controls referrer header leakage |

**Origin validation (CORS):**

- Loopback mode: accepts `http://127.0.0.1`, `http://localhost`, `http://::1`, `null`, and the legacy `CORS_ORIGIN` value.
- Non-loopback mode: requires an explicit `ALLOWED_ORIGINS` allowlist (comma-separated). Wildcard (`*`) disables origin checking.
- Requests without an `Origin` header (non-browser clients) are always allowed.
- Unknown origins receive `403 Origin not allowed`.
- DNS rebinding protection validates the `Host` header against the configured `HTTP_HOST` on non-loopback deployments.

**Health endpoints:**

- `/healthz` — liveness probe (returns `{ status: "ok", version }`).
- `/readyz` — readiness probe (returns `{ status: "ok", uptime }`).
- These endpoints do not expose sensitive information.

### 4.2 Bridge (WebSocket) Security

**Payload size enforcement:**

- Messages exceeding `BRIDGE_MAX_PAYLOAD_SIZE` (default 1 MiB) are rejected and the connection is closed with code `4009`.

**Schema validation:**

- Every incoming bridge message is parsed against a Zod schema before processing.
- Unknown message types, malformed JSON, or invalid schemas are logged and rejected.

**Handshake validation:**

- Protocol version must be in the supported set (`["1.0.0"]`).
- Session token (if configured) must match exactly.
- Extension version mismatch produces a warning log but does not block the connection.

**Stale request sweep:**

- A periodic timer (every 30 s) sweeps the pending-request map for leaked timeouts — defence-in-depth against timer drift.

**Heartbeat:**

- Periodic heartbeats (interval configurable via `BRIDGE_HEARTBEAT_MS`, default 10 s) detect dead connections.
- Failed heartbeat delivery triggers a clean disconnect.

**Reconnect backoff:**

- Exponential backoff: 1 s → 2 s → 4 s → 8 s → 16 s → 30 s (capped).
- Max attempts configurable via `BRIDGE_RECONNECT_MAX_ATTEMPTS` (default 0 = infinite).

---

## 5. Secrets Management

### 5.1 Environment Variables

All sensitive credentials are read from environment variables at startup:

| Category    | Variables                                    |
| :---------- | :------------------------------------------- |
| AI provider | `AI_API_KEY`                                 |
| JLCPCB      | `JLCPCB_CLIENT_ID`, `JLCPCB_CLIENT_SECRET`   |
| LCSC        | `LCSC_API_KEY`, `LCSC_API_SECRET`            |
| Mouser      | `MOUSER_API_KEY`                             |
| DigiKey     | `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` |
| Bridge      | `BRIDGE_TOKEN`                               |
| OAuth       | (derived from JWKS token, not stored in env) |

### 5.2 Log Redaction

The `redactObject()` and `redactSecrets()` utilities in `src/utils/redaction.ts` automatically redact sensitive values from logs and diagnostic output:

- Regex patterns match: `api_key`, `client_secret`, `token`, `password`, `bearer`, PEM private keys, and `authorization` headers.
- Object keys containing `key`, `secret`, `token`, `password`, `credential`, `authorization`, or `cookie` are replaced with `[REDACTED]`.
- The `easyeda_get_server_config` tool returns only safe configuration variables (port, transport, environment) — credentials are never exposed.

### 5.3 Config Validation at Startup

The Zod schema in `src/config/env.ts` validates all environment variables at startup:

- Type coercion and range checks (e.g., ports 1-65535, rate limits 1-10000, timeouts within bounds).
- Unknown project-prefixed env vars produce startup warnings to catch typos.
- Production mode enforced checks:
  - `BRIDGE_RAW_EXEC_ENABLED` must be `false`.
  - `JLCPCB_ENABLE_ORDERING` requires `JLCPCB_MODE=approved_api`.
  - Non-loopback HTTP without OAuth is rejected.
- Test mode (`NODE_ENV=test`) allows safe overrides for testing.

---

## 6. Safe Defaults vs Unsafe Overrides

Every unsafe configuration override has a safe default. The following table documents each override, its risk, and when it is appropriate:

| Variable                    | Safe Default  | Unsafe Override                | Risk                                            | When Appropriate                            |
| :-------------------------- | :------------ | :----------------------------- | :---------------------------------------------- | :------------------------------------------ |
| `HTTP_HOST`                 | `127.0.0.1`   | Non-loopback (e.g., `0.0.0.0`) | **High** — exposes server to network            | Remote deployment behind auth/reverse proxy |
| `OAUTH_ENABLED`             | `false`       | `true`                         | **Medium** — required for non-loopback          | Remote HTTP access with proper IdP          |
| `BRIDGE_RAW_EXEC_ENABLED`   | `false`       | `true`                         | **Critical** — enables raw JavaScript execution | Development/testing only                    |
| `BRIDGE_TOKEN`              | `''`          | Set to a shared secret         | **Medium** — enables bridge pairing             | Non-loopback bridge connections             |
| `EASYEDA_DEV_BRIDGE`        | `false`       | `true`                         | **Medium** — enables dev bridge features        | Development only                            |
| `HTTP_AUTH_DISABLED`        | `false`       | `true`                         | **High** — disables all HTTP auth               | Local development, testing                  |
| `NODE_ENV`                  | `development` | `production`                   | **Medium** — enables production safety checks   | Production deployment                       |
| `JLCPCB_ENABLE_ORDERING`    | `false`       | `true`                         | **High** — enables ordering via API             | When JLCPCB ordering is needed              |
| `AI_ALLOW_DESIGN_MUTATIONS` | `false`       | `true`                         | **High** — allows AI to modify designs          | Experimental AI-assisted design             |
| `MCP_TASKS_ENABLED`         | `false`       | `true`                         | **Medium** — enables MCP task protocol          | When task protocol needed                   |
| `TOOL_PROFILE`              | `core`        | `full`, `dev`, `experimental`  | **Varies** — grants access to more tools        | When broader tool access is needed          |
| `CORS_ORIGIN`               | `''`          | Set to an origin               | **Low** — local dev only                        | Legacy CORS configuration                   |
| `ALLOWED_ORIGINS`           | `''`          | Comma-separated origins        | **Medium** — restricts cross-origin access      | Remote HTTP with known browser clients      |

---

## 7. Supplier API Security

### 7.1 LCSC (jlcsearch)

- **Enabled by default** (`JLCSEARCH_ENABLED=true`).
- Uses a public search API endpoint — no credentials required for basic search.
- API key/secret can be configured for authenticated access.

### 7.2 JLCPCB

- **Disabled by default** (`JLCPCB_MODE=disabled`).
- Three modes: `disabled`, `mock`, `approved_api`.
- `JLCPCB_ENABLE_ORDERING` requires `approved_api` mode (enforced at startup in production).
- API credentials (`JLCPCB_CLIENT_ID`, `JLCPCB_CLIENT_SECRET`) are required for `approved_api` mode.

### 7.3 Mouser

- **Disabled by default** (`MOUSER_ENABLED=false`).
- Requires `MOUSER_API_KEY` to be configured.
- Uses `https://api.mouser.com` as the API base URL.

### 7.4 DigiKey

- **Disabled by default** (`DIGIKEY_ENABLED=false`).
- Requires OAuth2 client credentials (`DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`).
- Defaults to sandbox mode (`DIGIKEY_SANDBOX=true`).

**Data privacy:** Only explicitly initiated supplier queries are sent over the network. No design geometry, netlist data, or board layout is ever uploaded to supplier APIs.

---

## 8. Data at Rest

| Data Type           | Location                                                          | Protection                                      |
| :------------------ | :---------------------------------------------------------------- | :---------------------------------------------- |
| Configuration       | `.env` file                                                       | File system permissions; never committed to git |
| SQLite database     | `SQLITE_PATH` (default `.easyeda-mcp-pro/easyeda-mcp-pro.sqlite`) | File system permissions                         |
| Artifacts (exports) | `ARTIFACT_DIR` (default `.easyeda-mcp-pro/artifacts/`)            | Path traversal validation at the tool level     |
| Cache               | `CACHE_DIR` (default `.easyeda-mcp-pro/cache/`)                   | File system permissions                         |

Path traversal protection is enforced in all export tools — artifact paths are validated against the configured `ARTIFACT_DIR` before read or write operations.

---

## 9. CI/CD Security

### 9.1 GitHub Actions

- All action references are pinned to full 40-character commit SHAs.
- Workflows default to `permissions: contents: read` (least privilege).
- The release workflow has elevated permissions scoped to the specific job.
- Concurrency limits cancel in-progress runs on the same branch/tag.
- CodeQL analysis runs on every push and PR (security-extended + security-and-quality queries).
- Socket.dev scans every PR for dependency vulnerabilities.

### 9.2 Dependency Management

- Renovate automates dependency updates.
- Runtime dependencies require manual review — never auto-merged.
- Patch/minor devDependencies auto-merge if CI passes.
- Minimum release age of 3 days before Renovate creates a PR (mitigates zero-day package poisoning).
- Vulnerability alerts via OSV database.

### 9.3 Branch Protection

- `main` requires PR approval (minimum 1 reviewer).
- Status checks must pass: `quality (24)`, `quality (25)`, `codeql`.
- Branches must be up to date before merging.
- Linear history enforced (squash or rebase merge).

---

## 10. Threat Model

### 10.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    Trusted (OS Boundary)                  │
│                                                          │
│  ┌──────────────┐    stdio     ┌───────────────────┐    │
│  │ MCP Client    │◄───────────►│  easyeda-mcp-pro   │    │
│  │ (Claude, etc.)│             │  (MCP Server)      │    │
│  └──────────────┘             └──────────┬──────────┘    │
│                                          │               │
│                         WebSocket (loopback)             │
│                                          │               │
│  ┌───────────────────────────────────────┴──────────┐    │
│  │           EasyEDA Pro Bridge Extension            │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    Semi-Trusted                          │
│                                                         │
│  ┌──────────────┐    HTTP (loopback)   ┌────────────┐  │
│  │ Local Scripts │◄───────────────────►│ MCP Server  │  │
│  └──────────────┘                       └────────────┘  │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                   Untrusted                              │
│                                                         │
│  ┌──────────────┐   HTTP (network)    ┌────────────┐   │
│  │ Remote Client │◄──────────────────►│ MCP Server  │   │
│  │               │   (OAuth Required)  │ (OAuth)     │   │
│  └──────────────┘                      └────────────┘   │
│                                                         │
│  ┌──────────────┐     HTTPS API        ┌────────────┐   │
│  │ MCP Server    │◄──────────────────►│ Supplier    │   │
│  │               │                     │ APIs        │   │
│  └──────────────┘                      └────────────┘   │
└────────────────────────────────────────────────────────┘
```

### 10.2 Threat Scenarios

#### T1: Credential leakage via logs

- **Risk**: API keys or tokens appear in log output.
- **Mitigation**: Automatic redaction of `key`, `secret`, `token`, `password`, `bearer`, and `authorization` patterns in `redactSecrets()` and `redactObject()`.
- **Residual risk**: Low. Custom env vars not following naming conventions could leak.

#### T2: Unauthorized bridge command execution

- **Risk**: An attacker sends malicious commands through the bridge WebSocket.
- **Mitigation**: Schema validation on all messages, payload size enforcement, pairing challenge for non-loopback connections, session token validation, known-method allowlist.
- **Residual risk**: Low. Loopback-only default prevents remote access.

#### T3: Supplier API key exposure

- **Risk**: JLCPCB/Mouser/DigiKey credentials exposed in tool output or logs.
- **Mitigation**: Secrets never returned in tool output; redacted from config dumps and logs.
- **Residual risk**: Low.

#### T4: Unsanctioned design mutation by AI

- **Risk**: An LLM mutates schematic or PCB state without user consent.
- **Mitigation**: `confirmWrite` gate requires explicit acknowledgment for all mutation tools. Tool profiles gate access by risk tier.
- **Residual risk**: Low. The gate is enforced at the registry level before any handler executes.

#### T5: Local file system traversal via artifact paths

- **Risk**: A crafted export tool call reads or writes files outside the artifact directory.
- **Mitigation**: Paths validated against `ARTIFACT_DIR` at the tool level. Artifact directory is configurable.
- **Residual risk**: Low.

#### T6: OAuth token forgery or replay

- **Risk**: An attacker forges a JWT or replays a captured token.
- **Mitigation**: JWKS-based signature verification, `iss`/`aud`/`exp` claim validation, supported algorithm restriction, token type checking. Token expiry limits the replay window.
- **Residual risk**: Medium. Token lifetime depends on IdP configuration — short-lived tokens with rotation are recommended.

#### T7: DNS rebinding attack

- **Risk**: Attacker-controlled DNS resolves to the server's IP, bypassing same-origin policy.
- **Mitigation**: Host header validation on non-loopback deployments checks against the configured `HTTP_HOST`.
- **Residual risk**: Low on loopback; Medium on non-loopback without strict Host header checks.

#### T8: Dependency supply chain attack

- **Risk**: Compromised dependency introduces malicious code.
- **Mitigation**: SHA-pinned actions, 3-day minimum release age, manual review of runtime dep upgrades, OSV vulnerability scanning, Socket.dev PR scanning.
- **Residual risk**: Low-Medium. Zero-day in a widely-used dependency may not be detected immediately.

#### T9: Bridge connection hijacking

- **Risk**: Another process on the same machine connects to the bridge WebSocket before the legitimate EasyEDA Pro extension.
- **Mitigation**: Session token validation during handshake. Pairing challenge/response for non-loopback. Loopback-only binding by default.
- **Residual risk**: Low. On a shared machine with `BRIDGE_TOKEN` unset, the first connection wins.

---

## 11. Security Checklists

### 11.1 Enabling HTTP Mode

- [ ] Set `TRANSPORT=http`.
- [ ] For **loopback** (127.0.0.1): OK with defaults. Optionally set `HTTP_AUTH_DISABLED=true` for local tooling.
- [ ] For **remote access**:
  - [ ] Set `HTTP_HOST` to the bind address (e.g., `0.0.0.0` or LAN IP).
  - [ ] Configure OAuth:
    - [ ] `OAUTH_ENABLED=true`
    - [ ] `OAUTH_ISSUER` — valid IdP issuer URL.
    - [ ] `OAUTH_JWKS_URI` — valid JWKS endpoint.
    - [ ] `OAUTH_AUDIENCE` — expected audience (default `easyeda-mcp-pro`).
  - [ ] Set `ALLOWED_ORIGINS` if browser-based clients will connect.
  - [ ] Configure `HTTP_RATE_LIMIT_MAX` if the default 100 req/min is too restrictive.
- [ ] Restart the server and verify:
  - [ ] Server starts without SAFETY errors.
  - [ ] `/healthz` returns `200 OK`.
  - [ ] Authenticated request to `/mcp` returns valid MCP response.
  - [ ] Unauthenticated request to `/mcp` returns `401`.
  - [ ] Request from unknown `Origin` returns `403`.

### 11.2 Enabling Project-Changing Operations

- [ ] Select the appropriate tool profile (`TOOL_PROFILE`):
  - [ ] `core` — schematic reads, diagnostics, BOM (no mutations).
  - [ ] `pro` — adds manufacturing exports.
  - [ ] `full` — adds `easyeda_api_call` for controlled EasyEDA API access.
  - [ ] `dev` — adds runtime diagnostic probes.
- [ ] Confirm that your AI assistant's system prompt or tool use policy includes asking for user confirmation before calling mutation tools.
- [ ] Verify `confirmWrite` is respected:
  - [ ] Call a mutation tool _without_ `confirmWrite` — expect `ERR_CONFIRM_WRITE_REQUIRED`.
  - [ ] Call a mutation tool _with_ `confirmWrite=true` — expect successful execution.
- [ ] (Optional) Enable `AI_ALLOW_DESIGN_MUTATIONS=true` **only** if you understand the risks of AI-driven design edits.
- [ ] Audit the active tool profile with `easyeda_get_tool_profiles`.

### 11.3 Handling Generated Design & Export Files

- [ ] Set `ARTIFACT_DIR` to a dedicated directory (default `.easyeda-mcp-pro/artifacts/`).
- [ ] Verify that export tools write to the artifact directory.
- [ ] Verify path traversal protection: a tool call with `../../../etc/passwd` should be rejected.
- [ ] Clean up the artifact directory periodically (exports are not auto-deleted).
- [ ] If sensitive designs are exported, ensure the artifact directory has restricted file system permissions.
- [ ] When using export manifest validation (see [export-manifest.md](export-manifest.md)):
  - [ ] Define expected artifacts before generating exports.
  - [ ] Validate exports against the manifest after generation.
  - [ ] Verify checksums if integrity checking is required.

### 11.4 Production Deployment Readiness

- [ ] Set `NODE_ENV=production`.
- [ ] Set `LOG_LEVEL=info` or `warn` (not `debug` or `trace`).
- [ ] Verify safe config:
  - [ ] `BRIDGE_RAW_EXEC_ENABLED=false`.
  - [ ] `JLCPCB_ENABLE_ORDERING` → requires `JLCPCB_MODE=approved_api`.
  - [ ] `HTTP_HOST` is loopback OR OAuth is enabled.
  - [ ] `HTTP_AUTH_DISABLED` is `false` for any non-loopback HTTP.
- [ ] Run full CI gate locally:
  - [ ] `pnpm install --frozen-lockfile`
  - [ ] `pnpm format:check`
  - [ ] `pnpm typecheck`
  - [ ] `pnpm lint` (0 errors)
  - [ ] `pnpm test`
  - [ ] `pnpm build`
  - [ ] `pnpm build:extension` + `pnpm verify:extension`
- [ ] Verify no open security alerts on the GitHub Security tab.
- [ ] Review dependency dashboard for pending critical updates.

---

## 12. Related Documentation

- [Safety Model](SAFETY_MODEL.md) — Tool risk classifications, `confirmWrite` details, data privacy.
- [Export Manifest](export-manifest.md) — Validation rules for manufacturing export artifacts.
- [Repository Governance](REPOSITORY_GOVERNANCE.md) — Branch protection, dependency management policies.
- [Release CI Runbook](release-ci-runbook.md) — CI failure triage, release verification checklist.
- [Security Policy](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md) — Vulnerability reporting, supported versions, scope.
- [Configuration Guide](guide/configuration.md) — Complete env variable reference.
