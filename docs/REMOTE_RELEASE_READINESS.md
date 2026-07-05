# Remote release readiness checklist

This document records the minimum evidence needed before remote MCP support is described as beta-ready.

## Status language

Use the following status terms consistently.

- **Planned**: design exists, but users cannot call it yet.
- **Experimental**: code exists behind explicit flags.
- **Beta**: users can test it with documented limits.
- **Production-ready**: CI, validation, security review, and runbooks are complete.

## Current status: Planned (pairing/relay/approval routing is not wired to real tool calls)

As of this writing, the pairing/session-router/approval-policy/relay subsystem in
`src/remote/` (`RemoteGateway`, `RemoteSessionRouter`, `ApprovalStore`) is implemented and
unit/HTTP-tested in isolation, and its REST/WebSocket surface (`/remote/pairing-codes`,
`/remote/pairings`, `/remote/tool-requests`, `/remote/audit`, `/remote/relay`) is mounted
and reachable whenever `TRANSPORT=http` — no separate flag gates it. However, **no code
path routes an actual MCP tool call (`POST /mcp`) through this subsystem.** Every real
tool invocation, on every transport, always dispatches through the local-loopback
`BridgeManager` WebSocket to whatever EasyEDA bridge extension is connected on the same
host. This means:

- A user can pair an extension session, create pairing codes, and drive
  `RemoteGateway.routeToolRequest()` directly against the `/remote/*` REST surface, but
  that has no effect on and no connection to what any MCP client sees when it calls a
  real tool via `/mcp`.
- The extension's `RemoteRelayClient` (Remote Relay Mode) genuinely connects to a relay
  URL and can execute real EasyEDA API calls when driven directly, but nothing on the
  server side feeds it MCP tool calls from `/mcp`.
- There is also no name mapping between the MCP tool ids used elsewhere in this repo
  (e.g. `easyeda_pcb_place_component`) and the extension's internal dispatch method ids
  (e.g. `schematic.placeComponent`) — a prerequisite for the two paths to ever line up.

Given the status vocabulary above, the pairing/relay/approval-routing feature described
in `REMOTE_GATEWAY_DESIGN.md`, `SELF_HOSTED_REMOTE_MCP.md`'s "Planned relay controls",
`docs/CLAUDE_WEB_CONNECTOR.md`, and `docs/CHATGPT_APP_INTEGRATION.md` is **Planned**, not
Experimental or Beta — closing this gap requires an explicit architecture decision (how
tool execution selects a backend per deployment mode) before further code is written.

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
