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

| Code                        | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `IDENTITY_MISSING`          | No valid remote identity was propagated.                   |
| `IDENTITY_EXPIRED`          | Remote identity is expired.                                |
| `SCOPE_MISSING`             | Identity lacks the scope required by the risk level.       |
| `SESSION_UNPAIRED`          | User has no matching paired extension session.             |
| `SESSION_DISCONNECTED`      | Paired extension session is no longer connected.           |
| `SESSION_EXPIRED`           | Paired extension session exceeded its TTL.                 |
| `SESSION_AMBIGUOUS`         | Multiple sessions match and no explicit session was given. |
| `PROJECT_INACTIVE`          | A risky call has no confirmed active EasyEDA project.      |
| `APPROVAL_REQUIRED`         | Action requires an explicit approval id.                   |
| `APPROVAL_NOT_APPROVED`     | Approval is absent, invalid, expired, or already consumed. |
| `REMOTE_TOOL_UNSUPPORTED`   | Extension rejected the requested method as unsupported.    |
| `REMOTE_EXTENSION_TIMEOUT`  | Extension did not answer before the request deadline.      |
| `REMOTE_EXTENSION_ERROR`    | Extension or relay failed for a non-timeout reason.        |
| `RELAY_VERSION_UNSUPPORTED` | Relay protocol version mismatch.                           |

## Acceptance baseline

The first implementation should make remote routing debuggable without creating a sensitive design-data log sink.
