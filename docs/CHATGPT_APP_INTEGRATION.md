# ChatGPT app integration plan

**Current status: Planned app, experimental runtime.** There is no live hosted gateway or
published ChatGPT app. The underlying pairing/session-router/relay path is implemented behind
`MCP_BRIDGE_BACKEND=remote_relay`; real Streamable HTTP MCP read/write calls and fail-closed
approval behavior are CI-tested with a paired fake extension. Production account linking,
app distribution, multi-session UX, hosted deployment, and live EasyEDA/ChatGPT validation
remain open. The established self-hosted tunnel path in `docs/SELF_HOSTED_REMOTE_MCP.md`
continues to work for clients that support an arbitrary remote MCP URL.

ChatGPT integration should use the hosted Remote MCP architecture as the primary app path. Self-hosted endpoints remain an advanced/developer path for clients that can connect to arbitrary remote MCP URLs.

## Target architecture

```text
ChatGPT app
  ↓
Hosted Remote MCP Gateway
  ↓
Session Router
  ↓
Extension Relay
  ↓
EasyEDA bridge extension
  ↓
Open EasyEDA Web project
```

## Integration requirements

- Hosted MCP endpoint and app metadata.
- User authentication and account/session linking.
- Pairing flow between ChatGPT user and extension session.
- Tool descriptors with clear read/write/export risk classification.
- UX for active project visibility.
- Approval prompts for write/export/destructive operations.
- Test flow for a connected extension session.

## State model

| State            | Description                                               |
| ---------------- | --------------------------------------------------------- |
| Unauthenticated  | User has not connected the hosted service.                |
| Authenticated    | User is known but no EasyEDA extension session is paired. |
| Paired           | User has one active extension session.                    |
| Project active   | Extension can identify the open EasyEDA project.          |
| Approval pending | A risky action is waiting for user approval.              |
| Disconnected     | The extension or relay session is no longer active.       |

## Hosted mode is primary

The public ChatGPT app should not require each user to provide their own tunnel URL. The hosted gateway provides the stable app entrypoint, while pairing routes requests to the user's browser extension session.

## Advanced self-hosted path

Self-hosted remote endpoints can be documented for developer workflows and MCP clients that support arbitrary remote MCP URLs. This path must keep auth, pairing, approval, and logging responsibilities explicit.

## Open risks

- Final app distribution and review requirements.
- Exact production auth provider and account-linking model.
- Polished UI for selecting the active EasyEDA session/project and reviewing approval history.
- Handling multiple simultaneous EasyEDA tabs or projects.
- Long-running export/manufacturing operations.
