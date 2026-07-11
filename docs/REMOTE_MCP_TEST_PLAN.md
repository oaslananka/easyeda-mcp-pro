# Remote MCP test plan

Remote MCP tests should validate security boundaries before implementation is considered product-ready.

## Unit test matrix

| Area              | Required coverage                                                                     |
| ----------------- | ------------------------------------------------------------------------------------- |
| Auth              | missing, invalid, expired, insufficient-scope tokens.                                 |
| Pairing           | valid code, expired code, reused code, wrong user.                                    |
| Session router    | paired session, no session, disconnected session, cross-user access.                  |
| MCP HTTP sessions | two simultaneous clients, distinct session IDs, isolated close behavior.              |
| Relay protocol    | supported version, unsupported version, malformed envelope.                           |
| Approval policy   | read allowed, write blocked without approval, export approval, destructive rejection. |
| Observability     | event shape, redaction, error code mapping.                                           |

## Integration smoke tests

The integration smoke suite runs without live EasyEDA credentials by using a fake extension
relay fixture. Coverage is implemented in `tests/unit/remote/fake-extension-integration.test.ts`,
`tests/unit/remote/gateway.test.ts`, `tests/unit/tools/registry.test.ts`, and
`tests/unit/remote/http-mcp-integration.test.ts`. The last file uses the real SDK
Streamable HTTP client and `/mcp` transport rather than invoking registry callbacks directly.

Required scenarios:

1. User pairs fake extension session.
2. Remote read tool routes and returns a fixture response.
3. Remote write tool requests approval and succeeds after approval.
4. Remote write tool fails after rejection.
5. Cross-user session request is rejected.
6. Disconnected extension returns a safe error.
7. Two independent MCP clients can use the same paired extension session concurrently.
8. Calls targeting one EasyEDA session are serialized before extension dispatch.

## Manual validation

The CI-safe `/mcp`-to-relay route, remote-only control schemas, EasyEDA confirmation
callback, invocation-scoped grants, and rejection/timeout/replay behavior are implemented.
The remaining manual validation is a live hosted end-to-end run with a real EasyEDA
extension, production account linking, and polished project selection UX. Keep the
checklist below as the Beta gate.

Before public beta:

- hosted endpoint deployed under a test domain,
- extension connects in Remote Relay Mode,
- Claude Web connector can call at least one read tool,
- write action shows approval prompt,
- approval result is reflected in the remote MCP response,
- logs show structured events with redaction.
