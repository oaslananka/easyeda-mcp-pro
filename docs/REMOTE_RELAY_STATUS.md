# Remote Relay implementation status

> **Canonical status source.** This page is the authoritative statement of Remote Relay maturity and implemented versus outstanding capabilities. Design documents and setup guides describe architecture or operation, but must link here instead of maintaining independent readiness claims.

## Current maturity: Experimental

`MCP_BRIDGE_BACKEND=remote_relay` is an implemented, explicitly selected runtime path. It is not the default and is not yet advertised as Beta or production-ready. Local bridge mode remains the supported default.

### First-party Cloud identity foundation (not a public service)

The issue #849 branch adds an opt-in hosted OAuth identity provider and MCP resource discovery. The
provider starts **only** when `CLOUD_HOSTED_ENABLED=true`, `TRANSPORT=http`,
`MCP_BRIDGE_BACKEND=remote_relay`, and `OAUTH_ENABLED=true`, with exact canonical
`OAUTH_ISSUER=<origin>/api/auth`, `OAUTH_AUDIENCE=<origin>/mcp`, and
`OAUTH_JWKS_URI=<origin>/api/auth/jwks`. The operator supplies `CLOUD_HOSTED_ORIGIN`,
`CLOUD_AUTH_SECRET`, and private GitHub/Google OAuth client ID/secret environment variables.
These hosted-only credentials are not part of the local MCP Registry configuration. Provider
state uses a dedicated `hosted-cloud.sqlite` database under `DATA_DIR`.

A loopback process test confirms OAuth discovery, JWKS, a rendered GitHub/Google sign-in
screen, a fake-credential GitHub OAuth redirect and SQLite startup with **fake provider
credentials**, not a real signed-in user. A separate cookie-authenticated browser portal
shows linked extensions, creates owner-bound pairing codes, revokes sessions and supports
explicit owner-selected extension/project binding. The extension's optional Connect Cloud menu asks only for a pairing code and
uses the official WSS relay URL; Custom Remote remains independent.
Cloud requires explicit project selection even when only one extension is
paired. Simulated WebSocket tests cover disconnect, one-time-code replay
rejection, fresh pairing, project reselection, read dispatch, and revocation.
Periodic extension-originated heartbeats report the current project without
acknowledgement loops, and an extension-side dispatch guard rejects a switched
project before the EasyEDA tool is called. A changed project identity requires
reselection before remote tool routing; tampered/expired consent requests fail closed. Live GitHub/Google sign-in, full browser consent completion, real extension
pairing/project UX, hosted deployment and real EasyEDA relay acceptance are **not yet
verified or shipped**. Keep Cloud disabled until all acceptance gates are satisfied.

## Implemented and continuously tested

| Capability                                                                                            | Evidence level                                                  | Current state |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| Versioned relay message schemas                                                                       | Unit and deterministic property tests                           | Implemented   |
| Pairing codes and user/session binding                                                                | Unit and fake-extension integration tests                       | Implemented   |
| Session router and one-extension-session serialization                                                | Concurrency and integration tests                               | Implemented   |
| Streamable HTTP client session isolation                                                              | HTTP MCP integration tests                                      | Implemented   |
| OAuth protected-resource metadata and scope normalization                                             | HTTP transport tests                                            | Implemented   |
| Read-tool routing through a paired fake extension                                                     | Streamable HTTP integration test                                | Implemented   |
| Write/export/destructive approval request, retry, rejection, timeout, mismatch, and replay protection | Registry, gateway, extension-client, and HTTP integration tests | Implemented   |
| Extension outbound relay client, heartbeat, and reconnect/backoff                                     | Extension unit tests                                            | Implemented   |
| Audit events with redaction boundaries                                                                | Gateway and observability tests                                 | Implemented   |

The fake-extension tests prove protocol and policy behavior without claiming compatibility with an untested EasyEDA desktop runtime.

## Available deployment paths

### Established self-hosted HTTP path

A user can run the MCP server and EasyEDA Pro on the same always-on machine, keep the EasyEDA bridge on loopback, and expose only the OAuth-protected HTTP MCP endpoint through a reverse proxy or tunnel. This path does not require Remote Relay pairing because the bridge remains local to the server.

### Experimental paired relay path

A server configured with `MCP_BRIDGE_BACKEND=remote_relay` routes MCP tool calls to an outbound, paired extension session. Risky calls require a human decision in the EasyEDA extension and a bound one-time approval retry. This path remains experimental until the gates below have current evidence.

## Outstanding Beta gates

| Gate                                | Required evidence                                                                                                                                              | Status       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Hosted service deployment           | Maintainer-operated TLS endpoint, production OAuth/account linking, operational runbook, and rollback evidence                                                 | Not complete |
| Identity-provider validation        | Real issuer/JWKS/audience/scopes tested through the public deployment                                                                                          | Not complete |
| Project/session selection UX        | User-visible selection and revocation flows tested with multiple projects and clients                                                                          | Not complete |
| Hosted multi-client load validation | Bounded load/concurrency report including disconnect and reconnect behavior                                                                                    | Not complete |
| Live EasyEDA relay dogfood          | Disposable-project read, approved write, export, rejection, timeout, reconnect, and cleanup report bound to exact EasyEDA/extension/server versions and commit | Not complete |
| Incident and support readiness      | Alerting, audit retention, token/session revocation, operator escalation, and status communication exercise                                                    | Not complete |

A release or README must not upgrade the maturity label while any mandatory Beta gate lacks evidence. Documentation or fake-extension tests alone cannot clear the live EasyEDA relay dogfood gate.

## Tracked evidence and continuity

- [#391 — patch-release stabilization](https://github.com/oaslananka/easyeda-mcp-pro/issues/391) records the completed v0.35.3 publication, rollback, and release evidence.
- [#392 — exact EasyEDA runtime compatibility](https://github.com/oaslananka/easyeda-mcp-pro/issues/392) records the completed disposable-project live validation for v0.35.3.
- [#407 — solo-maintainer continuity and release recovery](https://github.com/oaslananka/easyeda-mcp-pro/issues/407) tracks the remaining continuity, recovery, and ownership-transfer controls.

The release and compatibility records are closed evidence. Continuity remains separately tracked so Remote Relay maturity cannot imply operational redundancy that the solo-maintainer project does not have.

## Status vocabulary

- **Planned:** design only; no callable path.
- **Experimental:** callable behind explicit configuration with documented limitations.
- **Beta:** externally usable with current live-runtime and hosted operational evidence, but with known limits.
- **Production-ready:** Beta evidence plus security review, service objectives, incident response, load evidence, and maintained runbooks.

## Related documents

- [Gateway architecture](./REMOTE_GATEWAY_DESIGN.md)
- [Deployment modes](./REMOTE_MCP_MODES.md)
- [Release-readiness evidence checklist](./REMOTE_RELEASE_READINESS.md)
- [Self-hosted setup](./SELF_HOSTED_REMOTE_MCP.md)
- [Remote security model](./REMOTE_SECURITY_MODEL.md)
- [Relay protocol](./EXTENSION_RELAY_PROTOCOL.md)
- [Tool approval policy](./TOOL_APPROVAL_POLICY.md)
