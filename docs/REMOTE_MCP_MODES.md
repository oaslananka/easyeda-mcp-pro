# Remote MCP modes

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

This mode must keep safe local defaults. It should bind to localhost unless the operator explicitly enables a public remote mode.

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
7. Write/export/destructive operations follow the approval policy.

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
