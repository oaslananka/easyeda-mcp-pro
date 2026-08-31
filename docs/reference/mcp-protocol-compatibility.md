# MCP protocol compatibility

This document records the protocol boundary that must remain explicit while `easyeda-mcp-pro`
adds support for MCP `2026-07-28`. Modern HTTP and stdio are opt-in behind `MCP_V2_EXPERIMENTAL`; legacy/sessionful HTTP and the legacy stdio handshake remain the defaults.

## Current support

| Area                  | Current repository behavior                                            |
| --------------------- | ---------------------------------------------------------------------- |
| MCP SDK               | Modular v2 packages; server/node lock to `2.0.0`, client is test-only  |
| Default MCP revision  | `2025-11-25`                                                           |
| HTTP era              | Legacy/sessionful by default; dual-era when `MCP_V2_EXPERIMENTAL=true` |
| HTTP initialization   | `initialize` followed by `notifications/initialized`                   |
| HTTP session identity | `MCP-Session-Id`                                                       |
| HTTP session routing  | Per-session `McpServer` + `StreamableHTTPServerTransport` instances    |
| Stdio                 | Legacy by default; dual-era `serveStdio(...)` when the flag is enabled |
| MCP `2026-07-28`      | Experimental HTTP + stdio support behind `MCP_V2_EXPERIMENTAL`         |

The server intentionally accepts a missing `MCP-Protocol-Version` header for retained legacy
clients. With the experimental flag disabled, an explicit non-legacy version is rejected before
legacy session state is created. With the flag enabled, official SDK classification routes legacy
requests to the retained session map and modern claims to a strict per-request v2 handler; malformed
or unsupported modern claims stay on the modern rejection path and cannot create legacy sessions.

## Upstream protocol eras

MCP `2026-07-28` is a new protocol era rather than a header-only revision of the 2025 transport.
The official MCP release removes the `initialize` / `initialized` exchange and
`MCP-Session-Id`; modern requests carry protocol, client identity, and capability metadata per
request, with optional `server/discover` discovery.

The official TypeScript SDK v2 line exposes the two eras through different lifecycle entry points:

- legacy: revisions `2024-10-07` through `2025-11-25`, using the existing `initialize` family;
- modern: `2026-07-28`, using per-request metadata and optional `server/discover`;
- HTTP modern serving: `createMcpHandler(...)` from `@modelcontextprotocol/server`, with Node
  adaptation through `@modelcontextprotocol/node`;
- stdio modern serving: `serveStdio(...)`;
- client negotiation: `versionNegotiation`, with legacy as the default unless modern behavior is
  explicitly selected.

Research baseline on 2026-08-09: the stable v2 packages
`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/node`, and
`@modelcontextprotocol/core` are published at `2.0.0`. The repository now resolves the direct
server/node SDK packages to `2.0.0` in the lockfile and keeps the client package test-only. This
provides the modular SDK foundation used by the opt-in modern HTTP and stdio paths.

Primary references:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [TypeScript SDK protocol eras](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
- [TypeScript SDK v1-to-v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [TypeScript SDK 2026-07-28 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)

## Legacy-to-modern behavior map

Every row is a migration invariant. `Retain` means the current behavior remains on the legacy path;
`Replace` means the modern path needs a separate implementation; `Remove` means the behavior must
not leak into modern requests.

| Current behavior                                          | Legacy path                                | Modern `2026-07-28` path                                    | Migration rule                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` + `notifications/initialized`                | Retain                                     | Remove                                                      | Never emulate modern support by accepting an initialize request under a new version string.                                                 |
| `MCP-Session-Id`                                          | Retain                                     | Remove                                                      | Modern request handling must not depend on legacy session headers or the legacy session map.                                                |
| `Map<sessionId, McpHttpSession>`                          | Retain                                     | Replace                                                     | Build modern request state per request; do not share a legacy `McpServer`/transport instance with modern traffic.                           |
| POST without a session ID is accepted only for initialize | Retain                                     | Replace                                                     | Modern POST requests are self-contained and must be routed to the modern handler instead of the legacy initialize gate.                     |
| GET `/mcp` session stream routing                         | Retain                                     | Replace where the v2 handler requires streaming             | Do not route a modern request through `sessionForRequest`.                                                                                  |
| DELETE `/mcp` session termination                         | Retain                                     | Remove from modern session semantics                        | A modern request has no legacy MCP session to terminate.                                                                                    |
| Missing protocol header accepted                          | Retain for legacy compatibility            | Do not use as proof of modern era                           | Era detection must be explicit and deterministic.                                                                                           |
| Single configured `MCP_PROTOCOL_VERSION` equality check   | Retain only as legacy compatibility policy | Replace                                                     | Modern negotiation must validate supported eras/versions rather than silently widening the legacy middleware.                               |
| Unsupported-version JSON response                         | Retain                                     | Replace with the modern SDK/protocol structured rejection   | Rejections must name supported protocol eras/versions and create no session/request state.                                                  |
| `createSessionServer()` factory                           | Retain for sessionful legacy HTTP          | Replace with an era-aware fresh server factory              | Tool/resource/prompt registration must be deterministic in both eras.                                                                       |
| Direct `McpServer` + `StdioServerTransport`               | Retain                                     | Replace with `serveStdio(...)` when modern stdio is enabled | Do not change stdio wire behavior merely by upgrading package imports.                                                                      |
| OAuth/JWKS verification                                   | Retain                                     | Retain                                                      | Era selection happens inside the same authenticated trust boundary; issuer, audience, signature, expiry, and scope checks stay fail closed. |
| Host validation / DNS-rebinding protection                | Retain                                     | Retain                                                      | Modern routing must not bypass the existing Host-header policy.                                                                             |
| Origin allowlist / CORS                                   | Retain                                     | Retain, with modern MCP headers added only as required      | Never use permissive CORS as protocol negotiation.                                                                                          |
| Rate limiting and security headers                        | Retain                                     | Retain                                                      | Apply before dispatch for both eras.                                                                                                        |
| Remote Relay authorization and invocation grants          | Retain                                     | Retain                                                      | Protocol-era changes must not weaken user/session isolation, approval requirements, or one-invocation grant scope.                          |
| `MCP_V2_EXPERIMENTAL` rollout gate                        | Retain for legacy/default-off behavior     | Experimental opt-in for modern HTTP and stdio               | Flag-on uses official era negotiation/classification; flag-off preserves the pre-existing legacy contract.                                  |

## Security invariants

A modern protocol implementation is not acceptable unless all of these remain true:

1. Non-loopback HTTP still refuses startup without complete OAuth and an explicit non-wildcard
   origin allowlist.
2. JWT issuer, audience, signature, expiry, token type, and required scopes remain validated before
   MCP dispatch.
3. Host-header validation continues to protect loopback and remote listeners from DNS rebinding.
4. Remote Relay user identity, paired session selection, approval IDs, invocation grants, and
   per-session serialization remain isolated across concurrent callers.
5. A request classified as modern never enters the legacy `MCP-Session-Id` map, and a legacy
   request never reuses modern per-request state.
6. Unsupported or malformed era metadata fails before any EasyEDA bridge mutation or remote action
   can execute.

The SDK's 2026 authorization migration also documents client/authorization-server opt-ins such as
`finishAuth`, credential-store issuer binding, discovery state, step-up scope handling, DCR changes,
and authorization-server TLS requirements. `easyeda-mcp-pro` is the protected MCP resource in this
flow: it does not implement an SDK OAuth client credential store or an authorization server. Those
client/authorization-server APIs therefore are not invoked by this runtime. The applicable resource
server obligations remain fail-closed bearer validation (JWKS signature, issuer, audience, expiry,
token type, and required scopes), protected-resource metadata, origin/Host policy, and rate limiting.
The modern `/mcp` integration suite exercises those controls before modern protocol dispatch and
asserts that rejected requests create no legacy session state.

## Delivery sequence

The compatibility work should remain reviewable as separate changes:

1. **Legacy baseline:** lock the current raw HTTP initialize/session/termination behavior and
   unsupported-modern-version rejection in tests. No production behavior changes.
2. **SDK v2 compile migration:** use the stable modular v2 package set and migrate imports while
   preserving legacy wire behavior. This foundation is complete.
3. **Modern HTTP path:** explicit era routing and `2026-07-28` request handling are available
   behind `MCP_V2_EXPERIMENTAL`; the existing sessionful route remains independent.
4. **Modern stdio path:** `serveStdio(...)` is enabled behind the same experimental flag; pinned modern and default legacy clients are covered by hermetic process-level interop tests.
5. **Security and Remote Relay parity:** complete. Modern `/mcp` fixtures prove issuer, audience,
   scope, origin, rate-limit, Remote Relay identity, approval gating, and legacy-session isolation;
   the shared pre-dispatch middleware and existing Host-header tests retain DNS-rebinding protection.
6. **Rollout:** complete for the experimental phase. Supported/experimental states and rollback are
   explicit below. Changing the default era remains a separate release decision rather than part of
   this compatibility program.

## Experimental rollout and rollback

- `2025-11-25` remains the default and supported legacy application protocol for HTTP and stdio.
- `2026-07-28` remains **experimental** and requires `MCP_V2_EXPERIMENTAL=true`; no legacy revision
  is deprecated or removed by this program.
- Rollback is configuration-only: set `MCP_V2_EXPERIMENTAL=false` and restart the server. No database
  migration, persisted protocol state, or legacy-session conversion is required. The retained
  sessionful HTTP and direct legacy stdio paths remain the same paths used before modern opt-in.
- A client explicitly pinned to the modern era must receive a modern rejection or become unavailable
  after rollback; the server must not silently reinterpret modern envelopes as legacy sessions.
- `easyeda-mcp-pro doctor` reports the configured transport, default era, supported revisions, and
  whether modern experimental routing is enabled so operators can verify activation or rollback.
- Promoting `2026-07-28` from experimental, changing the default era, or deprecating a legacy revision
  requires a separate release decision and fresh compatibility/security evidence.

The compatibility program therefore supports controlled dual-era experimentation without changing
the default protocol contract.
