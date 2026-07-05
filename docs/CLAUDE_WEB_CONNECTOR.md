# Claude Web Remote MCP connector setup

Claude Web can use EasyEDA MCP Pro through a public Remote MCP endpoint.

**Current status:** there is no hosted gateway deployment today, and the pairing/relay
flow described below as "target design" is not yet wired to real MCP tool calls — see
`docs/REMOTE_RELEASE_READINESS.md` for the tracked gap. The setup that works today is
the self-hosted tunnel path: run the MCP server and EasyEDA Pro on the same always-on
machine, expose only the OAuth-protected HTTP transport through a tunnel/reverse proxy,
and add that URL as a Claude Web connector. The bridge extension always talks to the MCP
server over local loopback, so it does not need "pairing" in that setup — it just needs
to be connected to the same EasyEDA Pro instance the server's bridge is listening for.

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

## Hosted mode (target design, not usable yet)

```text
Claude Web
  ↓
https://mcp.example.com/mcp
  ↓
Hosted Remote MCP Gateway
  ↓
Paired EasyEDA extension session   ← not wired to real tool calls yet
```

There is no hosted gateway deployment to connect to today. The pairing/session-router/
approval-policy subsystem this diagram depends on exists in `src/remote/` and is
unit/HTTP-tested in isolation, but no code path routes an actual `/mcp` tool call
through it yet. Once that integration lands, the intended user flow is:

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
