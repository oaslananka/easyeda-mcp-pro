# Remote MCP observability

Remote MCP sessions need enough telemetry to debug routing, safety, and reliability without logging secrets or raw project contents by default.

## Event categories

| Event                         | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `remote.session.registered`   | Extension session registered with relay.         |
| `remote.session.paired`       | User/client was paired to an extension session.  |
| `remote.session.disconnected` | Extension or gateway closed the session.         |
| `remote.tool.requested`       | Gateway received a tool call.                    |
| `remote.tool.dispatched`      | Gateway routed the call to an extension session. |
| `remote.tool.completed`       | Tool returned successfully.                      |
| `remote.tool.failed`          | Tool failed with a categorized error.            |
| `remote.approval.requested`   | A risky action required approval.                |
| `remote.approval.resolved`    | Approval was approved, rejected, or timed out.   |
| `remote.auth.rejected`        | Auth, scope, or token validation failed.         |

## Common fields

- timestamp,
- event name,
- deployment mode,
- user id or local operator id,
- session id,
- connection id,
- tool name,
- risk level,
- approval requirement,
- input hash,
- status,
- duration,
- error code.

## Redaction rules

Do not log by default:

- access tokens,
- pairing codes,
- project source payloads,
- full schematics or board documents,
- vendor credentials,
- raw BOM lines with private project identifiers.

Prefer hashes, counts, sizes, and structured status codes.

## Error taxonomy

| Code                        | Meaning                                       |
| --------------------------- | --------------------------------------------- |
| `AUTH_MISSING`              | No valid remote auth context.                 |
| `AUTH_INSUFFICIENT_SCOPE`   | Token lacks the required scope.               |
| `SESSION_UNPAIRED`          | User has no paired extension session.         |
| `SESSION_DISCONNECTED`      | Extension session is not connected.           |
| `PROJECT_INACTIVE`          | EasyEDA project cannot be detected.           |
| `APPROVAL_REQUIRED`         | Action requires approval.                     |
| `APPROVAL_REJECTED`         | User rejected the action.                     |
| `APPROVAL_TIMEOUT`          | Approval window expired.                      |
| `RELAY_VERSION_UNSUPPORTED` | Relay protocol version mismatch.              |
| `BRIDGE_EXECUTION_FAILED`   | EasyEDA bridge returned an execution failure. |

## Acceptance baseline

The first implementation should make remote routing debuggable without creating a sensitive design-data log sink.
