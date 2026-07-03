# Extension relay protocol

The relay protocol carries authenticated gateway requests to an opted-in EasyEDA bridge extension session. The extension uses an outbound connection and does not expose a local listener to the public internet.

## Goals

- Route tool requests to the correct active EasyEDA session.
- Keep the extension connection user-visible and opt-in.
- Support protocol versioning and safe rejection of unsupported messages.
- Carry approval requests and tool responses with consistent envelopes.

## Connection lifecycle

```text
extension starts Remote Relay Mode
  ↓
register_session
  ↓
gateway validates pairing/auth state
  ↓
heartbeat loop
  ↓
tool_request / approval_request / tool_response
  ↓
session expires, disconnects, or user disables remote mode
```

## Envelope shape

Every relay message should include:

```json
{
  "protocolVersion": "2026-07-remote-relay-v1",
  "messageId": "msg_...",
  "type": "tool_request",
  "sessionId": "sess_...",
  "timestamp": "2026-07-03T00:00:00.000Z"
}
```

## Message types

| Type                 | Direction                   | Purpose                                                       |
| -------------------- | --------------------------- | ------------------------------------------------------------- |
| `register_session`   | Extension → Gateway         | Register extension version, mode, and active EasyEDA context. |
| `session_registered` | Gateway → Extension         | Confirm registration and pairing state.                       |
| `heartbeat`          | Both                        | Keep connection alive and measure liveness.                   |
| `tool_request`       | Gateway → Extension         | Request a tool action after auth, routing, and policy checks. |
| `tool_response`      | Extension → Gateway         | Return success, structured output, or safe error.             |
| `approval_request`   | Gateway/Extension → User UI | Present a risky action for explicit approval.                 |
| `approval_result`    | Extension → Gateway         | Return approve/reject/timeout.                                |
| `session_closed`     | Both                        | Close a session intentionally.                                |
| `error`              | Both                        | Return protocol, routing, or execution errors.                |

## Tool request fields

A `tool_request` should include:

- `toolName`
- `riskLevel`
- `requiresApproval`
- `input`
- `inputHash`
- `activeProjectHint`
- `deadlineMs`

## Failure handling

The extension and gateway must reject:

- unsupported protocol versions,
- messages for unknown sessions,
- tool requests before pairing,
- approval-required actions without approval,
- messages with malformed envelopes,
- requests after user disables Remote Relay Mode.

## Compatibility

Protocol changes must be versioned. The gateway should keep a small compatibility window when practical, but unsupported versions must fail safely with an actionable error.
