# Hosted Remote MCP Gateway design

The hosted gateway is the public MCP entrypoint for managed remote usage. It receives MCP requests from remote clients and dispatches validated tool calls to the user's paired EasyEDA bridge extension session.

## Endpoint shape

```text
https://mcp.example.com/mcp
```

The endpoint should use the project's HTTP transport and remain separate from local-only stdio workflows.

## Request flow

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

## Required configuration

```env
REMOTE_MODE=hosted
TRANSPORT=http
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
PUBLIC_BASE_URL=https://mcp.example.com
AUTH_REQUIRED=true
PAIRING_REQUIRED=true
REQUIRE_APPROVAL_FOR_WRITE=true
REQUIRE_APPROVAL_FOR_EXPORT=true
```

The existing safe production guardrails should remain active. Public binding must require auth and explicit origin/base URL configuration.

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
- unsupported relay protocol version.

## Non-goals for MVP

- No cloud-hosted Chromium worker is required.
- No anonymous public tool endpoint.
- No direct inbound network access to user devices.
- No automatic destructive project actions.
