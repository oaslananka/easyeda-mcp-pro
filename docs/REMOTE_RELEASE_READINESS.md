# Remote release readiness checklist

This document records the minimum evidence needed before remote MCP support is described as beta-ready.

## Status language

Use the following status terms consistently.

- **Planned**: design exists, but users cannot call it yet.
- **Experimental**: code exists behind explicit flags.
- **Beta**: users can test it with documented limits.
- **Production-ready**: CI, validation, security review, and runbooks are complete.

## Current status: Experimental foundation (explicit `MCP_BRIDGE_BACKEND=remote_relay` flag)

As of this writing, the pairing/session-router/approval-policy/relay subsystem in
`src/remote/` (`RemoteGateway`, `RemoteSessionRouter`, `ApprovalStore`) is implemented and
unit/HTTP-tested in isolation, and its REST/WebSocket surface (`/remote/pairing-codes`,
`/remote/pairings`, `/remote/tool-requests`, `/remote/audit`, `/remote/relay`) is mounted
and reachable whenever `TRANSPORT=http` — no separate flag gates it.

The MCP tool path now has an explicit backend selector. With the default
`MCP_BRIDGE_BACKEND=local_bridge`, every real tool invocation keeps using the existing
local-loopback `BridgeManager` WebSocket. With `MCP_BRIDGE_BACKEND=remote_relay`, the
ToolRegistry creates a per-request bridge context that routes `ctx.bridge.call(...)`
through `RemoteGateway.routeToolRequest(...)`, preserving the existing tool handlers
without rewriting every tool. This is an integration foundation, not beta-ready remote
support yet. This means:

- A read-only tool whose handler calls `ctx.bridge.call(...)` can route through a paired
  Remote Relay session when the MCP request carries a remote identity and either
  `remoteSessionId` or `MCP_REMOTE_SESSION_ID` identifies the session.
- Write/export calls can pass `remoteApprovalId` into the gateway and fail closed if the
  approval is absent, rejected, expired, or mismatched.
- The extension's `RemoteRelayClient` (Remote Relay Mode) genuinely connects to a relay
  URL, includes reconnect/backoff and heartbeat liveness, and can execute real EasyEDA
  API calls when driven directly.
- Remaining gap: production identity propagation, UX/session selection, approval request
  creation from MCP clients, and live EasyEDA relay dogfood still need end-to-end
  validation before this should be described as Beta.

Given the status vocabulary above, the pairing/relay/approval-routing feature described
in `REMOTE_GATEWAY_DESIGN.md`, `SELF_HOSTED_REMOTE_MCP.md`'s "Planned relay controls",
`docs/CLAUDE_WEB_CONNECTOR.md`, and `docs/CHATGPT_APP_INTEGRATION.md` is **Experimental**
behind explicit configuration, not Beta.

**What already works today without this subsystem:** OAuth-protected HTTP transport
(`TRANSPORT=http`, `OAUTH_ENABLED=true`) reachable through a tunnel/reverse proxy is
real and production-quality — see "Current HTTP/OAuth configuration" in
`REMOTE_GATEWAY_DESIGN.md`. A self-hosted user who runs the MCP server and EasyEDA Pro
on the same always-on machine and tunnels only the HTTP port already has a working
remote MCP setup; they do not need pairing/relay/approval routing for that to function,
since the bridge extension stays local to that machine regardless of where the calling
MCP client sits on the network.

## Gateway release gate

A release candidate should verify the following items.

- HTTP transport is intentional for remote mode.
- A canonical public base URL is configured.
- Public endpoints use TLS except loopback-only development URLs.
- User authentication is enabled for remote endpoints.
- Extension pairing is required before remote tool routing.
- Read calls fail safely when no paired active project is available.
- Write and export calls require explicit user approval before dispatch.
- Origin allowlist, rate limits, and redacted logs are configured.

## Fake extension integration evidence

CI-safe integration tests should run without live EasyEDA credentials and prove these cases.

- Session registration and heartbeat work.
- Pairing rejects expired, reused, and wrong-user codes.
- Remote read requests route only to the paired session.
- Write and export requests wait for approval before dispatch.
- Rejection, timeout, mismatched input hash, and disconnect cases fail closed.
- User A cannot route a request to user B's session.

## Live EasyEDA compatibility evidence

Before claiming support for a new EasyEDA Pro runtime version, record the following evidence.

- Capture a runtime inventory snapshot from a disposable project.
- Record EasyEDA Pro version, bridge version, snapshot path, and method registry hash.
- Diff the snapshot against the previous compatible baseline.
- Review removed or renamed runtime methods before release.
- Run live smoke tests against a disposable project.
- Link the diff and smoke report from release notes or release verification docs.

## Release evidence

Release verification should confirm these items.

- Package and metadata versions are aligned.
- Release artifact checksums are published.
- SBOM and provenance evidence are attached where supported.
- Registry metadata validation or dry-run result is recorded before remote metadata is advertised.
- OpenSSF and Scorecard evidence reflects live repository state.
- Signed tag or signed release policy is implemented or tracked with a concrete blocker.
