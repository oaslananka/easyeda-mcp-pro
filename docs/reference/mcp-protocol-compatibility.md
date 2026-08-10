# MCP protocol compatibility

This document records the protocol boundary that must remain explicit while `easyeda-mcp-pro`
adds support for MCP `2026-07-28`. It is a compatibility contract, not a claim that the modern
protocol is already enabled.

## Current support

| Area                  | Current repository behavior                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| MCP SDK               | `@modelcontextprotocol/sdk` v1, currently locked to `1.29.0`                    |
| Default MCP revision  | `2025-11-25`                                                                    |
| HTTP era              | Legacy/sessionful                                                               |
| HTTP initialization   | `initialize` followed by `notifications/initialized`                            |
| HTTP session identity | `MCP-Session-Id`                                                                |
| HTTP session routing  | Per-session `McpServer` + `StreamableHTTPServerTransport` instances             |
| Stdio                 | `McpServer.connect(new StdioServerTransport())`                                 |
| MCP `2026-07-28`      | Not supported; `MCP_V2_EXPERIMENTAL` remains reserved and has no runtime effect |

The server intentionally accepts a missing `MCP-Protocol-Version` header for retained legacy
clients. If the header is present today, it must equal the configured legacy revision. A
`2026-07-28` request is therefore rejected before legacy session state is created.

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
`@modelcontextprotocol/core` are published at `2.0.0`. The repository must pin and verify the exact
v2 package set in a dedicated dependency change before any modern protocol path is enabled.

Primary references:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [TypeScript SDK protocol eras](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
- [TypeScript SDK v1-to-v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [TypeScript SDK 2026-07-28 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)

## Legacy-to-modern behavior map

Every row is a migration invariant. `Retain` means the current behavior remains on the legacy path;
`Replace` means the modern path needs a separate implementation; `Remove` means the behavior must
not leak into modern requests.

| Current behavior                                          | Legacy path                                | Modern `2026-07-28` path                                              | Migration rule                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` + `notifications/initialized`                | Retain                                     | Remove                                                                | Never emulate modern support by accepting an initialize request under a new version string.                                                 |
| `MCP-Session-Id`                                          | Retain                                     | Remove                                                                | Modern request handling must not depend on legacy session headers or the legacy session map.                                                |
| `Map<sessionId, McpHttpSession>`                          | Retain                                     | Replace                                                               | Build modern request state per request; do not share a legacy `McpServer`/transport instance with modern traffic.                           |
| POST without a session ID is accepted only for initialize | Retain                                     | Replace                                                               | Modern POST requests are self-contained and must be routed to the modern handler instead of the legacy initialize gate.                     |
| GET `/mcp` session stream routing                         | Retain                                     | Replace where the v2 handler requires streaming                       | Do not route a modern request through `sessionForRequest`.                                                                                  |
| DELETE `/mcp` session termination                         | Retain                                     | Remove from modern session semantics                                  | A modern request has no legacy MCP session to terminate.                                                                                    |
| Missing protocol header accepted                          | Retain for legacy compatibility            | Do not use as proof of modern era                                     | Era detection must be explicit and deterministic.                                                                                           |
| Single configured `MCP_PROTOCOL_VERSION` equality check   | Retain only as legacy compatibility policy | Replace                                                               | Modern negotiation must validate supported eras/versions rather than silently widening the legacy middleware.                               |
| Unsupported-version JSON response                         | Retain                                     | Replace with the modern SDK/protocol structured rejection             | Rejections must name supported protocol eras/versions and create no session/request state.                                                  |
| `createSessionServer()` factory                           | Retain for sessionful legacy HTTP          | Replace with an era-aware fresh server factory                        | Tool/resource/prompt registration must be deterministic in both eras.                                                                       |
| Direct `McpServer` + `StdioServerTransport`               | Retain                                     | Replace with `serveStdio(...)` when modern stdio is enabled           | Do not change stdio wire behavior merely by upgrading package imports.                                                                      |
| OAuth/JWKS verification                                   | Retain                                     | Retain                                                                | Era selection happens inside the same authenticated trust boundary; issuer, audience, signature, expiry, and scope checks stay fail closed. |
| Host validation / DNS-rebinding protection                | Retain                                     | Retain                                                                | Modern routing must not bypass the existing Host-header policy.                                                                             |
| Origin allowlist / CORS                                   | Retain                                     | Retain, with modern MCP headers added only as required                | Never use permissive CORS as protocol negotiation.                                                                                          |
| Rate limiting and security headers                        | Retain                                     | Retain                                                                | Apply before dispatch for both eras.                                                                                                        |
| Remote Relay authorization and invocation grants          | Retain                                     | Retain                                                                | Protocol-era changes must not weaken user/session isolation, approval requirements, or one-invocation grant scope.                          |
| `MCP_V2_EXPERIMENTAL` reserved/no-op                      | Retain until an implementation is complete | Replace only with an explicit, tested rollout control if still needed | Setting the variable must not silently activate a partial modern stack.                                                                     |

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

The SDK's 2026 authorization migration also adds requirements that are not satisfied merely by
changing the transport. Those SDK-level auth changes must be evaluated separately against the
server's existing JWT/JWKS enforcement before modern support is declared conformant.

## Delivery sequence

The compatibility work should remain reviewable as separate changes:

1. **Legacy baseline:** lock the current raw HTTP initialize/session/termination behavior and
   unsupported-modern-version rejection in tests. No production behavior changes.
2. **SDK v2 compile migration:** pin the stable v2 package set and migrate imports while preserving
   legacy wire behavior. No modern era enabled by default.
3. **Modern HTTP path:** add explicit era routing and `2026-07-28` request handling while keeping
   the existing sessionful route independent.
4. **Modern stdio path:** adopt the v2 stdio lifecycle behind an explicit compatibility boundary.
5. **Security and Remote Relay parity:** prove OAuth, origin/Host, rate-limit, scope, approval, and
   relay isolation on both eras with independent fixtures.
6. **Rollout:** document supported/experimental/deprecated states, verify rollback to the retained
   legacy path, then consider changing defaults only through a separate release decision.

Until those steps are complete, `2025-11-25` remains the supported MCP application protocol and
`MCP_V2_EXPERIMENTAL` remains non-effective.
