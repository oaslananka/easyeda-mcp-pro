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
paired. Real loopback MCP HTTP tests use locally signed RFC 9068-style resource
access tokens against the JWKS verifier in both legacy and 2026-07-28 modes;
they cover owner and scope isolation, expired tokens, session JWT rejection,
forged owner headers and cross-client legacy session replay. Legacy MCP sessions
are bound to the OAuth subject and authorized client; token refresh for the
same account/client can retain the session while a different client cannot use
or delete it. **These tokens are signed by the test fixture**, not issued by
an authenticated GitHub/Google production OAuth flow. Simulated WebSocket
tests cover disconnect, one-time-code replay
rejection, fresh pairing, project reselection, read dispatch, and revocation.
Periodic extension-originated heartbeats report the current project without
acknowledgement loops, and an extension-side dispatch guard rejects a switched
project before the EasyEDA tool is called. A changed project identity requires
reselection before remote tool routing; tampered/expired consent requests fail closed. Live GitHub/Google sign-in, full browser consent completion, real extension
pairing/project UX, hosted deployment and real EasyEDA relay acceptance are **not yet
verified or shipped**.

A separate end-to-end loopback test uses the **actual first-party Better Auth provider**,
not an independently signed access token. A test-only Better Auth utility creates the
owner's browser session in the same isolated SQLite database; it is **not** installed in the
production provider. From there, a native public MCP client is registered and the running
provider signs the consent query, receives explicit approval, issues a PKCE authorization
code, and exchanges it for a resource-bound `at+jwt` with the expected owner and client
claims. The official MCP SDK uses that **provider-issued token** over HTTP /mcp.
The extension fixture connects through a **real loopback WebSocket upgrade**
to /remote/relay, sends a single-use pairing code, handles actual JSON
tool_request and tool_response frames, and reports a project-switching
heartbeat. The old selected project then fails with actionable MCP
isError=true and PROJECT_INACTIVE without dispatch; explicitly reselecting
the new project restores reads. Closing the socket returns an explicit
SESSION_DISCONNECTED MCP error instead of a misleading successful empty
schematic. The common MCP registry preserves critical remote authorization,
session, project and timeout errors even when an individual read tool normally
returns a best-effort not_available result. **The WebSocket peer is a simulated
EasyEDA extension, not the live EasyEDA desktop process or public WSS service.**
The browser's **Revoke** control
now cuts off previously issued MCP bearer tokens on the very next protected
request: the hosted resource validates active user/client/scope/resource consent
and retains a SQLite revocation epoch so an old JWT cannot revive after
reauthorization. A newly consented token remains usable. These checks and the
SQLite deletion trigger apply only to explicitly enabled Hosted Cloud; Local
mode and custom relay configurations are unaffected. Code replay, tampered consent scopes,
explicit denial, and an incorrect S256 PKCE verifier are rejected. This is strong local
OAuth/MCP integration evidence, **not** GitHub/Google login, production identity
provisioning, browser-click acceptance, or live EasyEDA design acceptance.

Keep Cloud disabled until all mandatory live acceptance gates are satisfied.

### Native EasyEDA extension navigation and Local acceptance (not Cloud rollout)

On 2026-11-13, an isolated EasyEDA Pro 3.2.209 desktop session exposed a
user-facing navigation defect: MCP Bridge was available on the Start Page but
disappeared in the PCB and 3D PCB editors. The extension manifest now declares
consistent Local and optional Cloud controls in the `home`, `sch`, `pcb` and
`pcbView` contexts, with globally unique menu/item identifiers. An extension
regression test checks all four contexts and controls. A test-built
**1.15.4 candidate** was imported into the isolated editor; the extension
manager reported it enabled, and real GUI checks confirmed the Bridge menu
and its Cloud/Local actions appeared in PCB and 3D PCB views. The installed
package was then activated after a complete application restart.

The restarted 3.2.209 editor subsequently paired with a **temporary
loopback-only Local bridge** via its actual extension menu. The bridge
reported extension 1.15.4 with matching method registry/server version,
and read-only `system.getStatus` and `system.loaderStatus` succeeded.
With an explicitly disposable PCB focused, independent read-only native
project/document queries confirmed matching project identity, and
`pcb.listComponents` reported 33 components (30 returned in the first page).
The document identity remained unchanged after reading. **No design
writes, exports or saves were performed**; the temporary bridge listener
was closed and the diagnostic scripts removed. The previous published
extension 1.15.3 artifact was retained for local rollback.

These observations establish **real native extension Local connectivity
and menu navigation**, not a verified remote WSS connection, real GitHub
or Google sign-in, production OAuth, or hosted Cloud release.

### Local browser acceptance (test account only)

On 2026-11-13, real Chrome 157 interacted with the running Cloud portal on
loopback using a temporary Better Auth test account and **simulated** EasyEDA
extension. The browser selected an explicit schematic project, generated a
one-time pairing code, denied a signed OAuth consent (returned `access_denied`
without a code), then approved a new consent (received an authorization code).
After approval, the owner dashboard originally displayed an opaque client ID
rather than its recognisable application name. The portal now displays the
Better Auth-registered client name, with an authenticated, owner-scoped
`/cloud/api/clients` view; the actual Revoke button removed it from the list.
The same Chrome session exposed stale cached `app.js` after a code update;
HTML now references content-fingerprinted JS/CSS URLs so refreshed pages use the
current interface. All user-visible controls above were clicked in Chrome,
not merely asserted in DOM mocks.

This acceptance is **local, fake-identity/fake-extension evidence only**.
GitHub/Google callback login, the official DNS/domain, remote WSS connection
to a real EasyEDA Pro instance, and live design read/write/export/read-back
remain unverified.

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
