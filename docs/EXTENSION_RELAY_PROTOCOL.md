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

### `toolName` convention

`toolName` is a **bridge method name** — the same vocabulary `dispatch()`
already accepts for local bridge requests (`schematic.listNets`,
`pcb.placeComponent`, `export.pdf`, ...), not an MCP tool name
(`easyeda_schematic_nets`). This keeps a single source of truth for "what
can the bridge do" instead of maintaining a second name mapping inside the
extension bundle. A gateway translating an MCP tool call into a
`tool_request` is responsible for mapping the MCP tool name to its
underlying bridge method(s) before sending the envelope.

### Extension-side dispatch (implemented)

`easyeda-bridge-extension/src/remote-client.ts`'s `handleToolRequest`
executes every `tool_request` through the same `dispatch()` function used
for local bridge requests, with the following gates, independent of
whatever a (not yet implemented) upstream gateway may claim:

1. **Risk classification** (`src/remote-risk.ts`) — every bridge method is
   classified as `read`, `write`, `export`, or `destructive` from a fixed
   table derived from `dispatch()`'s own method list. If the envelope
   declares a `riskLevel`, the extension takes the **stricter** of the two;
   a declared risk level can never downgrade a method the extension itself
   considers more dangerous.
2. **`read`** — dispatched immediately through the bridge, against
   whichever project/document is currently open in that browser tab (the
   extension has no separate "target project" selection; `dispatch()`
   always operates on the active document).
3. **`write` / `export`** — only dispatched if the local EasyEDA Pro user
   has explicitly called `setRemoteWriteApproval(true)` for the current
   relay session (exposed on `eda`/`globalThis`, fail-closed default,
   reset on every new `connectRemoteRelay()`/`disconnectRemoteRelay()`
   call). Otherwise the extension returns `REMOTE_APPROVAL_REQUIRED` and
   does not call `dispatch()`.
4. **`destructive`** (including the raw `api.call`/`api.execute` escape
   hatches) — always rejected with `REMOTE_DESTRUCTIVE_BLOCKED`; there is
   no approval toggle that can enable a destructive action over the remote
   relay path in this build.
5. **Unsupported methods** — `dispatch()`'s own `switch` already throws
   `METHOD_NOT_ALLOWED` for anything it doesn't recognize, so unsupported
   `toolName` values fail closed without any extension-side allowlist
   duplication.

This satisfies the extension's half of the contract. The gateway/session-
router/approval-policy layer this document describes above `tool_request`
(auth, pairing, scope, a full interactive approval UI) is tracked
separately — see the Remote MCP Gateway epic.

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
