# Claude Web Remote MCP connector setup

Claude Web can use EasyEDA MCP Pro through a public Remote MCP endpoint. The endpoint can be the hosted gateway or a user-managed self-hosted endpoint.

## Hosted mode

```text
Claude Web
  ↓
https://mcp.example.com/mcp
  ↓
Hosted Remote MCP Gateway
  ↓
Paired EasyEDA extension session
```

User flow:

1. Install and activate the EasyEDA bridge extension.
2. Open EasyEDA Web and the target project.
3. Enable Remote Relay Mode in the extension.
4. Sign in or pair against the hosted gateway.
5. Add the hosted Remote MCP connector URL in Claude Web.
6. Confirm the extension shows connected status and the active project.
7. Use read tools first; approve write/export actions in the extension.

## Self-hosted mode

```text
Claude Web
  ↓
https://mcp.user-domain.example/mcp
  ↓
User-managed Remote MCP endpoint
  ↓
Paired EasyEDA extension session
```

User flow:

1. Start the self-hosted EasyEDA MCP server with auth and pairing enabled.
2. Expose it through a safe domain, tunnel, reverse proxy, or VPS.
3. Add that public MCP URL in Claude Web.
4. Pair the extension session.
5. Confirm active project visibility before approving changes.

## Expected extension status

Before project-changing requests, the extension should show:

- mode: Hosted Remote or Self-hosted Remote,
- connection: connected,
- pairing: paired,
- active project: detected,
- approval policy: enabled for write/export actions.

## Troubleshooting

| Problem               | Check                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Claude cannot connect | Public URL, TLS, auth config, and allowed endpoint path.           |
| No active project     | EasyEDA tab/project is not open or extension cannot detect it.     |
| Tool call rejected    | Missing auth, missing pairing, missing scope, or approval timeout. |
| Wrong project risk    | Stop and re-pair after selecting the intended EasyEDA project.     |

## Safety note

Remote tools can affect the active design. Review approval prompts carefully, especially for write, export, overwrite, or delete operations.
