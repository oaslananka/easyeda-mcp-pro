# Claude Web Remote MCP connector setup

Claude Web can use EasyEDA MCP Pro through a public Remote MCP endpoint.

**Current status:** there is no hosted gateway deployment today. The pairing/relay path is
implemented behind `MCP_BRIDGE_BACKEND=remote_relay` and real Streamable HTTP MCP read/write
routing is CI-tested with a paired fake extension, including two simultaneous MCP clients sharing one paired extension session, but live EasyEDA and Claude Web dogfood
remain release gates. The established setup today is still the self-hosted tunnel path: run
the MCP server and EasyEDA Pro on the same always-on machine, expose only the OAuth-protected
HTTP transport, and use the local loopback bridge.

## Self-hosted mode (works today)

```text
Claude Web
  ↓
https://mcp.user-domain.example/mcp   (OAuth-protected, tunneled/reverse-proxied)
  ↓
Your MCP server (TRANSPORT=http, OAUTH_ENABLED=true)
  ↓
Local bridge extension (same machine, loopback WebSocket)
  ↓
Open EasyEDA Pro project
```

User flow:

1. Start the MCP server with `TRANSPORT=http`, `OAUTH_ENABLED=true`, and the other
   settings in `docs/SELF_HOSTED_REMOTE_MCP.md`'s "Minimum safe configuration".
2. Expose it through a safe domain, tunnel, reverse proxy, or VPS — see
   `docs/SELF_HOSTED_REMOTE_MCP.md` for a Cloudflare Tunnel example.
3. Install and activate the EasyEDA bridge extension on that same machine, open the
   target project, and connect it to the local server (MCP Bridge → Connect).
4. Add the public MCP URL as a Remote MCP connector in Claude Web.
5. Use read tools first; the extension's browser process is on the same machine, so
   there is no separate "active project" pairing step — whatever project is open in
   EasyEDA Pro on that machine is what tools operate on.

## Hosted mode (experimental runtime, no public deployment)

```text
Claude Web
  ↓
https://mcp.example.com/mcp
  ↓
Hosted Remote MCP Gateway
  ↓
Paired EasyEDA extension session
```

There is no hosted gateway deployment to connect to today. The runtime path is implemented:
`/mcp` can select a paired session, route read calls, and request an EasyEDA confirmation
dialog before risky calls. The remaining work is deployment, production account linking,
session/project UX, hosted multi-client load validation, and live EasyEDA/Claude Web validation. The intended user flow is:

1. Install and activate the EasyEDA bridge extension.
2. Open EasyEDA Web and the target project.
3. Enable Remote Relay Mode in the extension.
4. Sign in or pair against the hosted gateway.
5. Add the hosted Remote MCP connector URL in Claude Web.
6. Confirm the extension shows connected status and the active project.
7. Use read tools first; approve write/export actions in the extension.

## Troubleshooting (self-hosted mode)

| Problem               | Check                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Claude cannot connect | Public URL, TLS, auth config, and allowed endpoint path.                                           |
| Tool call rejected    | Missing/expired auth token, or missing required scope.                                             |
| No active project     | EasyEDA Pro on the server's machine has no project open, or the bridge extension is not connected. |

## Safety note

Remote tools can affect the active design. Review any confirmation prompts your MCP
client shows carefully, especially for write, export, overwrite, or delete operations.
