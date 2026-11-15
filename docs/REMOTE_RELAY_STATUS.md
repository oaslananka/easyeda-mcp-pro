# Remote Relay implementation status

> **Canonical status source.** This page is the authoritative statement of Remote Relay maturity and implemented versus outstanding capabilities. Design documents and setup guides describe architecture or operation, but must link here instead of maintaining independent readiness claims.

## Current maturity: Experimental

`MCP_BRIDGE_BACKEND=remote_relay` is an implemented, explicitly selected runtime path. It is not the default and is not yet advertised as Beta or production-ready. Local bridge mode remains the supported default.

### First-party Cloud identity foundation (owner-only live pilot, not public release)

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
reselection before remote tool routing; tampered/expired consent requests fail closed. These tests alone do not prove real provider sign-in, owner consent or native
desktop pairing. The separate 2026-11-14 owner-only live pilot below verified
Google sign-in, actual native pairing, owner-approved PKCE OAuth and a real
read-only MCP call; GitHub provider callback and production rollout are still
unverified.

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
returns a best-effort not_available result. The same first-party provider
test now also authorizes a **separate read/write/export OAuth client** via
actual PKCE and signed owner consent. Its `at+jwt` includes all requested
scopes; the original read-only token is denied both write and export before
approval. Over the loopback WebSocket, write approval requests are owner/session/
tool bound: rejection blocks dispatch, approval permits one simulated tool
result, and replay is denied. Export produces a separate approval request,
and rejecting it prevents any simulated export dispatch. The account page
also distinguishes read-only from write/export-authorized clients and
explains that the **MCP client must request missing scopes again**; an
existing read-only bearer cannot be upgraded silently. **The WebSocket
peer is a simulated EasyEDA extension, not the live EasyEDA desktop process
or public WSS service, and no native design mutation or file export was
performed in this test.**
Cloud's project identity now uses the native EasyEDA Pro
`dmt_Project.getCurrentProjectInfo` project UUID and
`dmt_SelectControl.getCurrentDocumentInfo` focused document UUID rather
than a window title/URL guess. These are read-only calls, and the focus
API is an EasyEDA beta capability: **if either UUID or the document's
parent-project relationship is unavailable or inconsistent, Cloud cannot
select or execute that document**. The extension refreshes the pair on
registration, heartbeat, approval and immediately before remote tool
execution; changing focus to another PCB in the _same_ project invalidates
the previous document selection. The relay and owner selection require
both UUIDs in Hosted mode. Custom Remote retains its historical fallback
for older editors; Local MCP does not need an account.

This is verified by negative-path tests against the real protocol and
simulated native identity getters. Real EasyEDA Pro 3.2.209 read-only
acceptance confirmed both identity getters on disposable PCBs, and the
2026-11-14 owner-operated pilot independently verified a real Hosted WSS
pairing. A subsequent populated-board Hosted read also succeeded on
2026-11-14; genuine cross-owner isolation remains outstanding.

The experimental extension now uses the EasyEDA-native `sys_Dialog.showInputDialog`
and `sys_WebSocket.register/send/close` APIs in its main process, avoiding
browser `prompt()`/`WebSocket` assumptions that do not hold in the native
sandbox. The input API is beta and capability-checked; missing or denied
External Interactions permission fails without silently connecting. The
native socket adapter uses independent IDs per attempt, a bounded open
timeout and the existing server-heartbeat liveness watchdog. Native
callback, timeout, cancellation and denied-permission cases are tested
with **simulated EasyEDA SDK implementations**. Actual native outbound Hosted WSS pairing with the official domain
was observed in the 2026-11-14 owner pilot; the automated
permission/cancellation tests remain a separate, simulated evidence level.

The browser's **Revoke** control
now cuts off previously issued MCP bearer tokens on the very next protected
request: the hosted resource validates active user/client/scope/resource consent
and retains a SQLite revocation epoch so an old JWT cannot revive after
reauthorization. A newly consented token remains usable. These checks and the
SQLite deletion trigger apply only to explicitly enabled Hosted Cloud; Local
mode and custom relay configurations are unaffected. Code replay, tampered consent scopes,
explicit denial, and an incorrect S256 PKCE verifier are rejected. These automated
checks alone are not provider login or native-user acceptance; the separate
2026-11-14 live owner pilot verified real Google login, browser-click consent,
MCP reads on an empty disposable PCB and revocation.

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
and menu navigation**. The later separate owner-operated Hosted pilot validated
real WSS pairing and Google OAuth, but did not authorize a production rollout.

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

This **2026-11-13** acceptance was local, fake-identity/fake-extension
evidence only. The separate 2026-11-14 owner pilot below superseded its
limitations for real Google sign-in, real native WSS pairing and one
read-only remote MCP call, but not live writes, exports or public rollout.

### 2026-11-14 — real owner-assisted Hosted pilots, populated Local and Hosted PCB acceptance

On existing draft [PR #1057](https://github.com/oaslananka/easyeda-mcp-pro/pull/1057)
at source commit `5726f77eb0bf9e2f787ffc81f57635e7946adf26`, the maintainer
entered a fresh single-use code **personally** into the actual isolated
EasyEDA Pro **3.2.209** extension **1.15.4**. The official HTTPS Cloud
application temporarily ran with owner-only access to the account panel
and an explicit disposable **Z480/PCB1** selected. The native WSS
session appeared **Connected / Selected PCB** in the authenticated
dashboard. The separate browser completed **real Google sign-in**,
registered a native public MCP client, and approved `easyeda.read`
through the real consent screen. An OAuth **PKCE S256** authorization
code exchanged successfully; the provider-issued bearer token was
accepted by `/mcp`, the MCP SDK listed **82** tools and its
`easyeda_pcb_components` call was successful, with **0 components**
because this selected PCB was empty. The browser's **Revoke** control
caused reuse of the same token to fail with `consent_revoked`;
**Remove access** removed the native session.

The short pilot was then **stopped and rolled back**. The original
Cloud source pin, local design data and persistent hosted storage were
preserved; temporary owner-only access was deleted. The working pilot
does **not** imply that a public Hosted service is currently online.
See [live owner acceptance evidence](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6875143319).

Separately, another disposable copy of the shipped **Quick Start**
PCB was opened in the real editor against the same PR source. A Local
MCP server first started its loopback listener and the native
**MCP Bridge > Connect** menu established the connection; native
project and document UUIDs matched. The actual
`easyeda_pcb_components` call returned **33/33 components**, all
with identifiers and observable coordinates, with **no native
design writes, saves or exports**. This proves a **populated LOCAL**
PCB read, **not** a populated Hosted relay result. See
[populated native Local read evidence](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6876884760).

A second, independent owner-controlled pilot used the **same real
populated disposable Quick Start PCB** and the updated reviewed source
commit `587e62976ca34c17b2e18c5ceac56db13f258c41`. The operator
used the existing authenticated Cloud portal to generate a fresh
single-use pairing code and enter it into the native EasyEDA Pro
3.2.209 extension 1.15.4 on the authorized test workstation.
The dashboard again showed **Connected / Selected PCB**.
A separate public-native MCP test client obtained an actual
owner-approved `easyeda.read` OAuth code using **PKCE S256**.
The bearer-authorized `/remote/sessions` returned the focused PCB
project **and document** UUIDs; MCP `initialize` using protocol
`2025-11-25` succeeded over the official Hosted HTTP transport.
The real `tools/call` to `easyeda_pcb_components` was dispatched to
the native paired extension over WSS and returned
`isError=false`, `not_available=false`, `total=33`, and **33
components with 33/33 identifiers and 33/33 coordinate values**.
A mismatched project UUID was denied with no component payload,
and a call without OAuth authorization was rejected with HTTP
**401**. Revoking the client consent made the previously valid token
fail with HTTP **403**. The owner dashboard's **Remove access**
disconnected the device and left no approved clients. This is real
**populated HOSTED** acceptance, not simulated or merely Local.
The short test was then fully stopped and rolled back to the original
production source pin; the existing stored data was preserved, the
temporary Cloudflare Access rule was removed and the test client was
cleaned up. No live PCB write or export occurred. See
[real populated Hosted Cloud acceptance](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6877504456).

**Remaining Hosted acceptance:** verify wrong-owner/client isolation under
real multi-client conditions, project/document reselection and
connect/disconnect/reconnect, final GitHub identity-provider callback,
and any required write/export approval and operational gates. Keep
`#850` **production HOLD**, `#1057` **DRAFT**, and the maturity
level **Experimental** until those are satisfied. The first
real design mutation still requires separate owner approval.

### 2026-11-15 — real owner MCPJam web OAuth; production still HOLD

The owner-only reviewed candidate at #1057 source `36fc628e46dd54ba4e8a48f898dd2c706d92929f`
passed a **real MCPJam web Inspector** OAuth/CIMD/PKCE login on the official
HTTPS `/mcp` URL. The initial request for read/write/export/project-admin
scopes was **denied**; an `easyeda.read`-only request was approved and
connected. MCPJam discovered **83 tools**, loaded the MCP Apps resource and
successfully invoked `easyeda_health_check` (`status: ok`, version 1.15.5).
The live owner portal was accessible, but **no native EasyEDA design was
paired** during this MCPJam test. Its earlier health output incorrectly
showed the bridge as connected: the remote diagnostic adapter assumed
connectivity before checking the owner's selected editor. The subsequent
candidate now reports `degraded` until an owned, paired, selected editor
is reachable; fixture JWT/WSS and both MCP protocol eras pass regression
tests. **At the time of that earlier pilot, the corrected diagnostic had not yet passed a live Cloud retest.**
A later database inspection found the
MCPJam consent had been revoked; reuse of its old token **after** revocation
was not tested during the short live pilot.

Coolify's initial Docker build exposed OAuth credential values in image
history. The candidate was stopped, build secrets were enabled and a clean
image was confirmed free of those values in its final Docker metadata.
Preview and unused legacy images were removed, Coolify restored its original
main source pin, and temporary Cloudflare Access removed. The public health
route returned HTTP 503 again. See [issue #849 live results](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6886979844).

**At the time of that earlier pilot**, independent second-owner isolation,
new native paired read, post-revoke live replay, and write persistence were
NOT VERIFIED. The later live acceptance below supersedes the read and revoke
gaps but not the independent-owner or durable write gates.

### 2026-11-15 — MCPJam current-head live owner acceptance: 33 PCB + 34 schematic records

**Current reviewed candidate:** Draft PR [#1057](https://github.com/oaslananka/easyeda-mcp-pro/pull/1057)
at exact commit `f1c9b700baa3b362f1ef19c80f72a6f48673339f`
(30/30 terminal CI checks: 28 successful, one neutral, one skipped).
The earlier unpaired-health diagnostic was corrected on this commit.
During the bounded owner-authorized HTTPS pilot, the **real MCPJam web
Inspector** completed OAuth (CIMD/PKCE) with precisely `easyeda.read`,
discovered **83 MCP tools**, and received the correct `degraded` /
`bridge_connected: false` health result while no editor was paired.
The owner's previously authorized MCPJam consent was revoked, and reuse
of the old bearer failed with **HTTP 403**.

The operator then used a separately isolated **real EasyEDA Pro 3.2.209**
instance with the reviewed **MCP Bridge 1.15.5** package, paired it using
a one-time Cloud code, opened disposable
`QS_33_COMPONENT_CLOUD_PILOT_DISPOSABLE_20261114` and clicked
**Use this PCB** on the owner dashboard. A real OAuth-authorized MCPJam
`tools/call easyeda_pcb_components` returned **33 actual PCB components**
(`total: 33`, **33 unique designators**), with identifiers, footprints,
coordinates, rotations and layers. In the **same session**, the operator
focused the native schematic, selected **Use this schematic**, and the real
MCPJam `easyeda_schematic_components` returned **34 schematic records**
(`total: 34`, 33 unique references including one multi-unit duplicate),
component values, footprints and native positions. Its consistency report
was `stable: true` with two attempts. These are **live, populated Hosted
Cloud results**, not local-only results or mocked fixtures.

After selecting **Remove access** for that disposable native session,
the owner portal displayed **zero paired devices**. The already-connected
MCPJam client immediately received `isError: true` and
`SESSION_UNPAIRED` on a repeat schematic read. The remaining test
`easyeda.read` consent was then revoked, leaving **zero owner consents**
at the end of that pilot. The isolated editor was closed normally.
No native writes, exports or production design edits were performed.

The deployed image was independently checked to contain **no actual OAuth
credential values in image history or image environment**, while all
three credentials were available at runtime. The three OAuth secrets in
both production and preview Coolify settings (six entries) were changed
to **runtime-only**, and the BuildKit/ARG-injection safeguards remain.
The temporary candidate was stopped and reverted to the existing `main`
source pin; **zero Cloud containers were running** and public health
returned HTTP **503** afterward. The temporary MCP feature flags and
Access gate were removed. The earlier initial Docker build-history
exposure still needs scoped cache/registry assessment and credential
rotation disposition before public release.

**Remaining NOT VERIFIED:** two truly independent owner identities with
real cross-account isolation; **actual** ChatGPT, Claude and eligible
Gemini host connectors; a separately owner-approved and cold-reopen
verified Cloud WRITE/export path; the beta native text-deletion durability
issue [#1060](https://github.com/oaslananka/easyeda-mcp-pro/issues/1060);
and earlier credential-exposure disposition. Keep **PR #1057 Draft**,
**issue #850 production HOLD**, and Hosted maturity **Experimental**.

[Full live acceptance evidence](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6888075039).

## Implemented and continuously tested

| Capability                                                                                            | Evidence level                                                  | Current state                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Versioned relay message schemas                                                                       | Unit and deterministic property tests                           | Implemented                                |
| Pairing codes and user/session binding                                                                | Unit and fake-extension integration tests                       | Implemented                                |
| Session router and one-extension-session serialization                                                | Concurrency and integration tests                               | Implemented                                |
| Streamable HTTP client session isolation                                                              | HTTP MCP integration tests                                      | Implemented                                |
| OAuth protected-resource metadata and scope normalization                                             | HTTP transport tests                                            | Implemented                                |
| Read-tool routing through a paired fake extension                                                     | Streamable HTTP integration test                                | Implemented                                |
| Write/export/destructive approval request, retry, rejection, timeout, mismatch, and replay protection | Registry, gateway, extension-client, and HTTP integration tests | Implemented                                |
| Extension outbound relay client, heartbeat, and reconnect/backoff                                     | Extension unit tests                                            | Implemented                                |
| Owner-scoped persistent completed-call usage dashboard and sanitized terminal outcome log             | SQLite, authenticated portal, browser fixture and relay tests   | Implemented; live Cloud acceptance pending |
| Audit events with redaction boundaries                                                                | Gateway and observability tests                                 | Implemented                                |

The Cloud preview also maintains a persistent **per-owner MCP usage counter** in the existing
`hosted-cloud.sqlite` database. The account workspace shows total, successful and failed
**completed native-relay tool calls** and refreshes every 30 seconds while the
signed-in page is visible, with manual refresh still available. Concurrent
refreshes are deduplicated and the timer stops when the page is closed. One
sanitized terminal line reports each outcome and elapsed time. The counter does not count denied OAuth,
unpaired, insufficient-scope or approval-pending calls, and it does not store design
content, raw tool arguments, account tokens, project names or individual call history.
Native-tool errors/timeouts are counted as failed; a timeout does **not** prove
that an attempted write left EasyEDA unchanged. The first-party account-isolation,
persistence, dashboard and simulated relay tests pass, but the new usage display has
**not** yet undergone actual Hosted owner browser acceptance. It is not a billing meter.

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
