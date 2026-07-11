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

The MCP tool path has an explicit backend selector. With the default
`MCP_BRIDGE_BACKEND=local_bridge`, tool invocations use the existing local-loopback
`BridgeManager` WebSocket. With `MCP_BRIDGE_BACKEND=remote_relay`, the server does not
open a local bridge listener; ToolRegistry routes bridge calls through the selected paired
Remote Relay session instead. Existing tool handlers remain unchanged. This is a tested
experimental path, not beta-ready remote support. In particular:

- A read-only MCP tool can route through a paired Remote Relay session when the request
  carries a remote identity and either `remoteSessionId` or `MCP_REMOTE_SESSION_ID`
  identifies the session.
- Remote-only MCP input schemas advertise `remoteSessionId` and `remoteApprovalId`; local
  mode keeps the original public schemas unchanged.
- A risky MCP tool invocation first returns a structured `APPROVAL_REQUIRED` result with
  an approval ID and sends an `approval_request` to the paired extension. The extension
  presents an EasyEDA confirmation dialog and returns approved, rejected, or timeout.
- Approval is bound to the user, session, MCP tool, and effective parsed input. An approved
  retry receives a private server-side invocation grant, allowing all bridge calls made by
  that one handler; the grant is revoked when the handler completes. Rejection, timeout,
  mismatch, and approval-ID replay fail closed before dispatch.
- Remote dispatch enforces deadlines and reports unsupported extension methods separately
  from generic extension failures.
- The HTTP transport creates an isolated MCP server/transport for each `Mcp-Session-Id`; two simultaneous clients can route through the same paired extension, and closing one client leaves the other operational. Calls targeting one EasyEDA extension session are serialized before dispatch.
- A real Streamable HTTP MCP client integration test covers one built-in read tool and one
  approval-gated built-in write tool through a paired fake extension, including rejection,
  timeout, and one-time approval behavior.
- The extension's `RemoteRelayClient` connects to a relay URL, includes reconnect/backoff
  and heartbeat liveness, and can execute EasyEDA API bridge methods.
- Remaining Beta gates include production account linking and identity-provider validation,
  polished project selection UX and hosted multi-client load validation, a deployed hosted broker, and live EasyEDA
  relay dogfood against a disposable project.

Given the status vocabulary above, the pairing/relay/approval-routing feature described
in `REMOTE_GATEWAY_DESIGN.md`, `SELF_HOSTED_REMOTE_MCP.md`,
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
- Two MCP clients receive distinct HTTP session IDs and one client can disconnect without affecting the other.
- Concurrent calls to one extension session never overlap in the extension dispatcher.

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
