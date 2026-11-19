# Remote MCP modes

> **Status authority:** [Canonical Remote Relay status](./REMOTE_RELAY_STATUS.md) is the
> authoritative source for current maturity and outstanding release gates. This document
> describes architecture, operation, or evidence requirements and must not be read as an
> independent readiness claim.

EasyEDA MCP Pro supports three deployment modes. The modes share the same tool semantics, but they have different network and security boundaries.

## Mode matrix

| Mode               | Primary use                         | Public endpoint            | EasyEDA runs in                | Recommended users                             |
| ------------------ | ----------------------------------- | -------------------------- | ------------------------------ | --------------------------------------------- |
| Local              | Desktop MCP clients and development | No                         | User browser                   | Local-only users and developers               |
| Hosted Remote      | Managed connector/app experience    | Maintainer-operated domain | User browser extension session | Claude Web, ChatGPT app, managed teams        |
| Self-hosted Remote | User-managed remote MCP server      | User domain/tunnel/VPS     | User browser extension session | Power users, enterprises, private deployments |

## Local Mode

Local Mode keeps the current workflow:

```text
MCP client
  ↓
localhost MCP server
  ↓
EasyEDA bridge extension
  ↓
Open EasyEDA Web project
```

This mode keeps safe local defaults and binds the EasyEDA bridge listener to loopback unless
the operator explicitly configures otherwise. It is the default fallback and is not started
when `MCP_BRIDGE_BACKEND=remote_relay` is selected.

## Hosted Remote Mode

Hosted Remote Mode is the product-grade remote path:

```text
Claude Web / ChatGPT / remote MCP client
  ↓
https://mcp.example.com/mcp
  ↓
Remote MCP Gateway
  ↓
Session Router
  ↓
Relay
  ↓
EasyEDA bridge extension
  ↓
Open EasyEDA Web project
```

The extension opens an outbound relay connection. The hosted gateway never connects directly to a user's local network.

### Cloud BOM export delivery

In Hosted Remote mode, call `easyeda_bom_export` with `format: "csv"` or
`format: "json"` and **omit `filePath`**. After the separate `easyeda.export`
scope and native project-session approval, the MCP response carries BOM
content, MIME type and a suggested filename directly to the authorized client.
The MCP client must save that content as a local file; this response does
**not** automatically download onto the editor's machine. CSV formula-like
part fields are neutralized. Inline payloads are limited to 256 KiB; larger
BOMs and `.xlsx` require an explicit local export workflow.

Local MCP keeps its existing artifact-directory path behavior. Hosted Cloud
does not accept a client Windows path or silently write private BOM artifacts
to the Oracle server's filesystem as a fallback.

## Self-hosted Remote Mode

Self-hosted Remote Mode lets the operator expose their own endpoint:

```text
Remote MCP client
  ↓
https://mcp.user-domain.example/mcp
  ↓
User-managed tunnel, reverse proxy, or VPS
  ↓
EasyEDA MCP server
  ↓
EasyEDA bridge extension
  ↓
Open EasyEDA Web project
```

Tunnels provide reachability only. They do not replace authentication, pairing, origin validation, rate limiting, or approval controls.

## Common user journey

1. The user opens EasyEDA Web in a browser window.
2. The user activates the EasyEDA bridge extension.
3. The extension is placed in Local, Hosted Remote, or Self-hosted Remote mode.
4. The user pairs the extension session with the remote MCP client or hosted account.
5. Remote tool calls route to the paired EasyEDA project.
6. Read operations can run after auth and pairing.
7. Allowlisted routine project edits and local artifact exports first require a native EasyEDA
   confirmation scoped to the authenticated OAuth client, paired session and native project UUID,
   and lasting at most 30 minutes (separate write/export grants). Destructive, high-risk,
   unrecognized and external operations retain their per-action confirmation.
8. After the initial approval, the client retries the identical MCP invocation with
   `remoteApprovalId`. Subsequent eligible routine calls can reuse their short-lived
   project-session approval without further prompts; rejection, timeout, mismatched client/project,
   changed input, replay and expired approvals still fail closed. `confirmWrite=true` remains
   mandatory for design mutation tools.

## Security responsibilities

| Responsibility              | Local                  | Hosted Remote      | Self-hosted Remote                  |
| --------------------------- | ---------------------- | ------------------ | ----------------------------------- |
| Keep local binding safe     | Project                | Project            | Operator                            |
| Operate public TLS endpoint | N/A                    | Maintainer         | Operator                            |
| Enforce auth                | Optional local profile | Maintainer gateway | Operator server                     |
| Enforce pairing             | Optional local profile | Required           | Required                            |
| Approve risky actions       | User                   | User + gateway     | User + operator server              |
| Audit remote calls          | Optional               | Required           | Recommended/required for production |

## Related documents

- [Remote security model](./REMOTE_SECURITY_MODEL.md)
- [Relay protocol](./EXTENSION_RELAY_PROTOCOL.md)
- [Tool approval policy](./TOOL_APPROVAL_POLICY.md)
- [Self-hosted setup](./SELF_HOSTED_REMOTE_MCP.md)
- [Claude Web connector setup](./CLAUDE_WEB_CONNECTOR.md)
- [ChatGPT app integration plan](./CHATGPT_APP_INTEGRATION.md)
- [Observability model](./REMOTE_OBSERVABILITY.md)

## Official and Custom Cloud in the EasyEDA extension

The **MCP Bridge** menu is available in the Start Page, schematic and PCB editors:

- **Connect Local MCP** uses the local loopback MCP bridge (the default), including in EasyEDA Pro Web. A locally running MCP server is still required. No domain or Tunnel is needed when both run on the same computer.
- **Connect EasyEDA MCP Pro Cloud** requests a one-time pairing code from the signed-in Cloud portal at https://easyeda-mcp-pro.oaslananka.dev/cloud. Choose **Generate pairing code**, then **Copy code** (or manually select it if clipboard access is unavailable); paste it into the EasyEDA MCP Bridge input. The dashboard shows a countdown and hides expired codes; generate a new one if it expires. While the pairing code is valid, Cloud automatically refreshes the device list every few seconds. When a newly paired device is identified against the previously loaded device list, Cloud stops polling, hides the used one-time code and shows **Connected**. Choose **Use this PCB** or **Use this schematic** for the currently focused document; **Refresh connections** remains available if the automatic refresh fails. If the earlier device list could not be loaded, Cloud must not mistake an existing device for a new pairing. Switching documents within the same project requires selecting the new document again. The official relay endpoint is wss://easyeda-mcp-pro.oaslananka.dev/remote/relay **and is preconfigured**; users never enter this WSS URL for the official Cloud. ChatGPT, MCPJam and other MCP clients instead use https://easyeda-mcp-pro.oaslananka.dev/mcp. **Connect Custom Cloud (WSS)…** accepts a user-supplied secure wss:// endpoint (for example wss://my-cloud.example/remote/relay) plus that server's one-time pairing code; Custom never silently overwrites the official Cloud endpoint. Cloud access is always opt-in and **Local MCP remains the default**. After entering a one-time Hosted Cloud pairing code, EasyEDA asks separately whether to **Remember Cloud on this device for 23 hours** or **This session only** (the default on decline or if the native confirmation UI is unavailable). Only an explicit Remember choice lets a rotating, owner-bound device-resume credential survive an EasyEDA process restart in that EasyEDA profile's **extension user settings**. This profile storage is **not an OS keychain**: someone who can read the profile data may reuse the device credential until it expires or is revoked. Treat shared/untrusted profiles as session-only. The server hashes the rotating device credential in Hosted Cloud SQLite, limits it to 24 hours, and atomically rotates it on each authenticated resume; the extension's stored copy expires sooner (23 hours). A remembered credential only reconnects the owner-bound **device**, never selects a native project, grants MCP OAuth scopes or bypasses the original EasyEDA write/export approval policy. The owner must still choose **Use this schematic/PCB** on the Cloud dashboard after a cold restart, and may revoke the device there at any time. An explicit Disconnect/Connect Local erases remembered trust when native storage allows it; if clearing fails, revoke the device on the Cloud portal. Expired or revoked credentials fail closed and require a fresh one-time code. Custom Cloud stays session-only. A real owner-only 2026-11-14 pilot passed native code pairing, Google login,
  PKCE `easyeda.read`, owner-selected PCB and a remotely routed MCP read of an
  **empty** disposable PCB (0 components); consent revocation also passed.
  A separate populated PCB passed 33/33 reads in **Local mode**, and
  a subsequent real Hosted WSS / OAuth `easyeda.read` pilot using the
  same disposable design returned **33/33 actual components with IDs
  and coordinates**. Wrong-project and missing-authentication calls
  were rejected; grant revocation also invalidated the old bearer token.
  Cross-owner/multi-client isolation, document switching/reconnect and
  GitHub login remain unverified; the public rollout is on HOLD.
- **Connect Custom Remote... (Experimental)** requests a self-hosted WSS Relay URL and a short-lived EDA-XXXXXXXX pairing code previously obtained from an authenticated Relay gateway. This uses the existing remote session/approval protocol; it does **not** accept a public MCP /mcp URL as a WebSocket Relay endpoint.
- **Disconnect Cloud**, **Cloud Connection Status...** and **Connect Local MCP** let the user inspect or return from the experimental mode. Switching modes closes the previous transport. **The one-time pairing code is never persisted** in extension settings or placed in the relay URL. After explicit Disconnect, expired device trust, or a session-only editor restart, generate a fresh code. A device remembered through explicit native consent may automatically resume on editor restart within its local 23-hour expiry, while the owner must still select the active schematic/PCB; no write/export approval is automatically restored. Cloud revocation immediately invalidates the server-side credential, regardless of whether EasyEDA's local storage clearing succeeds.

**After installing or updating MCP Pro Bridge:** save any unsaved EasyEDA edits and reload the editor tab before pairing. EasyEDA may keep the previous extension code running until the editor is reopened, even if Extension Manager displays the newly imported version. An extension previously used in session-only mode needs a fresh one-time Cloud pairing code; an explicitly remembered and still valid Hosted device can resume once its updated extension is activated. In either case, explicitly choose the active PCB or schematic again before MCP calls. Do not mistake a connected device for authorization to a specific design.

Only endpoints with the secure WSS scheme, a hostname, optional valid port and path are accepted; credential-bearing URLs, fragments and query parameters are rejected. The extension first uses EasyEDA's native `sys_Dialog.showInputDialog` for the one-time code, and `sys_WebSocket.register/send/close` for the outbound WSS connection; neither requires browser `prompt()` or a browser `WebSocket` constructor in the main extension process. `showInputDialog` is a version-sensitive **beta API** and is capability-checked; older browser-based test clients may use their native browser fallback. A cancelled code dialog or one whose answer arrives after switching to Local never connects. External Interactions permission must be enabled in the EasyEDA Extension Manager; if permission is rejected, the extension returns to Local selection instead of endlessly retrying.

EasyEDA Pro 3.2.209's native WebSocket uses the fixed desktop Origin https://client. The gateway accepts only this exact native Origin on the /remote/relay endpoint, not on the generic /session path. Other external origins still require an explicit allowlist and a valid Host. This is transport compatibility, not authentication: an unpaired session cannot read or mutate a project, and owner identity, single-use pairing, scopes, selected native document and approvals remain mandatory.

The official Cloud currently runs as an **owner-restricted Oracle Always Free
pilot**, not a general-availability service. Real EasyEDA Pro 3.2.209
acceptance verified native WSS pairing, Google sign-in, selected-PCB reads
(33/33 components), an approved disposable schematic write with saved
read-back, and a per-action-approved native Gerber export. The exported ZIP
contained 13 nonempty files; an independently rejected export failed closed.
The same live device rejected read requests naming two non-active project UUIDs
with a project-identity mismatch; neither response disclosed PCB components.
This does **not** establish manufacturability or general release readiness.
See [the acceptance record](https://github.com/oaslananka/easyeda-mcp-pro/pull/1057#issuecomment-6933371245)
and [Remote Relay maturity](./REMOTE_RELAY_STATUS.md).

Real standalone Electron revocation/no-retry and cold restart, the GitHub
provider callback, genuine independent second-account isolation, and
historic OAuth credential disposition remain unverified for public
launch. Existing local MCP remains account-free and the default.
