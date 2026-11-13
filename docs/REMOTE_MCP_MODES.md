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
- **Connect Cloud... (Experimental)** requests only the one-time pairing code from the signed-in Cloud portal at `https://easyeda-mcp-pro.oaslananka.dev/cloud`. It targets the official `wss://easyeda-mcp-pro.oaslananka.dev/remote/relay` endpoint. This is an explicit one-editor-session opt-in; Local stays the default and Cloud does not auto-resume on restart. The public hosted service and live EasyEDA acceptance remain unverified.
- **Connect Custom Remote... (Experimental)** requests a self-hosted WSS Relay URL and a short-lived EDA-XXXXXXXX pairing code previously obtained from an authenticated Relay gateway. This uses the existing remote session/approval protocol; it does **not** accept a public MCP /mcp URL as a WebSocket Relay endpoint.
- **Disconnect Remote Relay**, **Remote Relay Status...** and **Connect Local** let the user inspect or return from the experimental mode. Switching modes closes the previous transport. The pairing code is never persisted in extension settings or placed in the Relay URL. After a disconnect the one-time code cannot be reused: generate a fresh code in the Cloud account and choose Connect Cloud again; the extension clearly reports this recovery step. Remote mode does not automatically resume after editor restart.

Only endpoints with the secure WSS scheme, a hostname, optional valid port and path are accepted; credential-bearing URLs, fragments and query parameters are rejected. A working gateway, pairing, compatible runtime WebSocket implementation and real project-specific live acceptance are still needed. The earlier local Web PCB tests do not constitute hosted Remote Relay acceptance. If the EasyEDA runtime cannot show the configuration input prompt or cannot create an outbound WebSocket, the extension leaves Local available and reports the limitation.
