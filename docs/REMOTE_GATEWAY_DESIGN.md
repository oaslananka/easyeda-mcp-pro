# Hosted Remote MCP Gateway design

The hosted gateway is the public MCP entrypoint for managed remote usage. It receives MCP requests
from remote clients and dispatches validated tool calls to the user's paired EasyEDA bridge
extension session.

## Endpoint shape

```text
https://mcp.example.com/mcp
```

The endpoint should use the project's HTTP transport and remain separate from local-only stdio
workflows.

OAuth protected-resource discovery is available at:

```text
https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

Unauthenticated requests return a `WWW-Authenticate` challenge that points clients to that metadata
document.

## Request flow

> **Status: experimental and wired behind explicit configuration.** With the default
> `MCP_BRIDGE_BACKEND=local_bridge`, `/mcp` tool calls continue to use the local
> `BridgeManager`. With `MCP_BRIDGE_BACKEND=remote_relay`, the ToolRegistry replaces the
> per-request bridge call path with `RemoteGateway.routeToolRequest(...)`, so existing MCP
> tool handlers route through the paired extension session without being rewritten. The
> routing foundation is CI-tested, but production identity/session UX, approval creation,
> and live hosted relay dogfood are still required before Beta status.

```text
remote MCP request
  ↓
transport parser
  ↓
auth validation
  ↓
scope validation
  ↓
session router
  ↓
tool policy / approval gate
  ↓
relay dispatch
  ↓
extension response
  ↓
MCP response
```

## Current HTTP/OAuth configuration

These variables are implemented by the current runtime:

```env
TRANSPORT=http
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
ALLOWED_ORIGINS=https://client.example.com
OAUTH_ENABLED=true
OAUTH_ISSUER=https://auth.example.com
OAUTH_AUDIENCE=https://mcp.example.com/mcp
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
OAUTH_REQUIRED_SCOPES=easyeda.read
```

The existing safe production guardrails should remain active. Public binding must require OAuth and
an explicit origin allowlist.

## Experimental remote relay configuration

The routed MCP path is enabled explicitly. Local bridge mode remains the default.

```env
TRANSPORT=http
MCP_BRIDGE_BACKEND=remote_relay
MCP_REMOTE_SESSION_ID=session-id-if-fixed
OAUTH_ENABLED=true
```

`MCP_REMOTE_SESSION_ID` is optional when the MCP request supplies `remoteSessionId`.
Write/export/destructive bridge calls require a valid `remoteApprovalId` that matches the
user, session, method, and input hash. The `/remote/*` pairing, approval, audit, and relay
endpoints are mounted by the HTTP transport.

## Route responsibilities

| Layer          | Responsibility                                         |
| -------------- | ------------------------------------------------------ |
| Transport      | Parse MCP request and return protocol-shaped response. |
| Auth           | Validate identity, token status, and audience.         |
| Scope          | Confirm tool-specific permission.                      |
| Session router | Resolve user to exactly one active extension session.  |
| Policy         | Determine risk level and approval requirement.         |
| Relay          | Send a versioned request envelope to the extension.    |
| Audit          | Record structured events with redaction.               |

## Safe response states

The gateway must return safe, actionable errors for:

- unauthenticated request,
- insufficient scope,
- no paired session,
- expired pairing,
- disconnected extension,
- missing active project,
- approval required,
- approval rejected or timed out,
- unsupported extension method,
- remote extension deadline timeout,
- unsupported relay protocol version.

## Non-goals for MVP

- No cloud-hosted Chromium worker is required.
- No anonymous public tool endpoint.
- No direct inbound network access to user devices.
- No automatic destructive project actions.
