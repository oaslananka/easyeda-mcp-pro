# Remote MCP security model

**Current status:** this document specifies the required security model for the
pairing/relay routing path once it is wired to real MCP tool calls. That integration
does not exist yet — see `docs/REMOTE_RELEASE_READINESS.md`. Today, real tool calls
never traverse the Session Router/Relay boundary shown below; they go through the local
`BridgeManager` loopback connection instead. The controls below remain the bar that
integration must meet before it ships, so treat this as a design/acceptance spec, not a
description of a currently-enforced boundary.

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

### Tool risk and scope precedence

Remote tool authorization resolves risk metadata in this order:

1. `easyeda_execute` is always `destructive`.
2. Tools in the `export` group retain the explicit `export` policy.
3. Every remaining tool declared with `risk: high` is `destructive`, including tools that also set `confirmWrite: true`.
4. `risk: medium` and ordinary `confirmWrite: true` tools are `write`.
5. Remaining tools are `read`.

The resulting scopes are `easyeda.read`, `easyeda.write`, `easyeda.export`, and
`easyeda.project_admin`, respectively. `confirmWrite` is a mutation acknowledgement control; it must
never downgrade a high-risk tool from `destructive` to `write`. Consequently, an identity with only
`easyeda.write` cannot invoke a high-risk tool even when the user has supplied `confirmWrite: true`;
`easyeda.project_admin` and the applicable approval are required.

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
