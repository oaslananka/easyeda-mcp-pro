# Remote MCP security model

Remote MCP must not be treated as a public wrapper around local tool execution. Every remote path must enforce identity, pairing, session isolation, approval policy, and auditable routing.

## Trust boundaries

```text
Remote MCP client
  │ untrusted prompts and tool arguments
  ▼
Remote MCP Gateway
  │ authenticated, authorized, policy-checked requests
  ▼
Session Router
  │ paired user/session mapping
  ▼
Relay
  │ versioned request envelopes
  ▼
EasyEDA bridge extension
  │ user-visible active project and approvals
  ▼
EasyEDA Web page
```

## Required controls

| Control           | Requirement                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Authentication    | Remote tool calls require a valid token or equivalent authenticated session.                |
| Pairing           | A remote user must be paired with exactly one active extension session before tool routing. |
| Session isolation | A user must never access another user's EasyEDA session.                                    |
| Authorization     | Tool scopes separate read, write, export, and project administration actions.               |
| Approval          | Write, export, and destructive actions require explicit approval according to policy.       |
| Origin validation | Public HTTP endpoints validate expected origins where applicable.                           |
| Safe defaults     | Public binding is not enabled without remote mode, auth, and allowed-origin configuration.  |
| Audit             | Remote requests record structured events without secrets or raw design payloads by default. |

## Scope model

Recommended initial scopes:

- `easyeda.read`
- `easyeda.write`
- `easyeda.export`
- `easyeda.project_admin`

Read tools require `easyeda.read`. Project-changing tools require the relevant stronger scope and approval.

## Hosted responsibilities

The maintainer-operated hosted gateway is responsible for TLS, token verification, pairing lifecycle, session routing, rate limiting, audit logging, and policy enforcement before relay dispatch.

## Self-hosted responsibilities

A self-hosted operator is responsible for their domain/tunnel/VPS, TLS, authentication, secrets, access control, logs, upgrades, and abuse prevention. Tunneling a local port is not a security control.

## Safe failures

The gateway must fail closed when:

- authentication is missing or invalid,
- the user is not paired,
- the extension session is expired or disconnected,
- the requested tool requires a missing scope,
- approval is required but not granted,
- the active EasyEDA project cannot be confirmed.

## Regression coverage

Security tests should cover:

- missing, invalid, expired, and insufficient tokens,
- unpaired and expired sessions,
- cross-user session access attempts,
- unsupported relay protocol versions,
- approval-required actions without approval,
- redaction of secrets and large raw design payloads.
