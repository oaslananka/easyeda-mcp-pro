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
7. A write/export/destructive call first requests approval in an EasyEDA confirmation dialog.
8. After approval, the client retries the identical MCP invocation with the returned
   `remoteApprovalId`; rejection, timeout, changed input, and replay fail closed.

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

## Custom Remote in the EasyEDA extension (experimental)

The **MCP Bridge** menu is available in the Start Page, schematic and PCB editors:

- **Connect** or **Connect Local** uses the local loopback MCP bridge (the default), including in EasyEDA Pro Web. A locally running MCP server is still required. No domain or Tunnel is needed when both run on the same computer.
- **Connect Cloud... (Experimental)** requests a one-time pairing code from the signed-in Cloud portal at https://easyeda-mcp-pro.oaslananka.dev/cloud. Choose **Generate pairing code**, then **Copy code** (or manually select it if clipboard access is unavailable); paste it into the EasyEDA MCP Bridge input. The dashboard shows a countdown and hides expired codes; generate a new one if it expires. After connecting, choose **Refresh connections** in Cloud, then **Use this PCB** or **Use this schematic** for the currently focused document. Switching documents within the same project requires selecting the new document again. The official relay endpoint is wss://easyeda-mcp-pro.oaslananka.dev/remote/relay. This is an explicit one-editor-session opt-in; Local remains the default and Cloud does not auto-resume on restart. A real owner-only 2026-11-14 pilot passed native code pairing, Google login,
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
- **Disconnect Remote Relay**, **Remote Relay Status...** and **Connect Local** let the user inspect or return from the experimental mode. Switching modes closes the previous transport. The pairing code is never persisted in extension settings or placed in the Relay URL. After a disconnect the one-time code cannot be reused: generate a fresh code in the Cloud account and choose Connect Cloud again; the extension clearly reports this recovery step. Remote mode does not automatically resume after editor restart.

Only endpoints with the secure WSS scheme, a hostname, optional valid port and path are accepted; credential-bearing URLs, fragments and query parameters are rejected. The extension first uses EasyEDA's native `sys_Dialog.showInputDialog` for the one-time code, and `sys_WebSocket.register/send/close` for the outbound WSS connection; neither requires browser `prompt()` or a browser `WebSocket` constructor in the main extension process. `showInputDialog` is a version-sensitive **beta API** and is capability-checked; older browser-based test clients may use their native browser fallback. A cancelled code dialog or one whose answer arrives after switching to Local never connects. External Interactions permission must be enabled in the EasyEDA Extension Manager; if permission is rejected, the extension returns to Local selection instead of endlessly retrying.

EasyEDA Pro 3.2.209's native WebSocket uses the fixed desktop Origin https://client. The gateway accepts only this exact native Origin on the /remote/relay endpoint, not on the generic /session path. Other external origins still require an explicit allowlist and a valid Host. This is transport compatibility, not authentication: an unpaired session cannot read or mutate a project, and owner identity, single-use pairing, scopes, selected native document and approvals remain mandatory.

Two short owner-operated pilots verified gateway HTTPS, native WSS
pairing, Google OAuth and real MCP reads of both an **empty PCB
(0 components)** and a **populated PCB (33 components)**, then rolled
back. There is **no currently deployed public Hosted service**.
Cross-owner/client isolation, project/document switching,
disconnect/reconnect and other release gates still require real
acceptance; successful read-only calls and native-API simulations
do **not** prove those remaining Hosted capabilities.
