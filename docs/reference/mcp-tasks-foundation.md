# MCP Tasks durability foundation (not a live protocol feature)

The Tasks extension for MCP 2026-07-28 uses server-directed task creation on
an explicit client opt-in, with tasks/get, tasks/update and tasks/cancel. It is
not the same as the legacy 2025 task methods, and the official TypeScript
ext-tasks v0.2.2 runtime currently concentrates on the client requester and a
legacy sampling/elicitation receiver, not a server tool-execution engine.

The internal DurableTaskStore provides a SQLite WAL task-state substrate:

- Unpredictable IDs, explicit server-validated owner scoping and a strict
  read-only operation allowlist (BOM and PCB component listing only).
- Bounded payload sizes, per-owner quotas, 1 minute to 24 hour expiration and
  explicit cleanup of retained CAD data.
- Atomic terminal transitions, cooperative cancel-request persistence and
  fail-interrupted-on-restart recovery. No process-memory-only task IDs.
- Cancel/complete races never overwrite terminal results.

CRITICAL: No MCP Tasks handlers, task-aware tool interception or worker
are registered in the production runtime. MCP_TASKS_ENABLED remains reserved
and ineffective. Testable, isolated protocol polling and executor modules
exist, but neither is imported by the factory. They MUST NOT be described as
working production asynchronous execution or crash-resumable work. The future
adapter must derive identity from validated OAuth or a trusted local session,
check tool scopes and relay approvals, and implement durable worker leases,
crash recovery and cross-OS modern protocol acceptance before exposing the gate.
Never allow a background worker to perform native CAD design writes without
fresh explicit authorization, transaction preview and readback.

## Read-only executor substrate (staging only, 2026-10-28)

A separate single-process task runner first commits a bounded durable task
record, then schedules only allowlisted read-oriented work with a test-injected
executor, concurrency/queue limits, timeout and owner-scoped cancellation.
Arbitrary exception details are never stored because they may include secrets.
The runner is NOT registered in the product and has no cross-process lease or
crash-resume. MCP_TASKS_ENABLED stays reserved; authorization, relay routing,
worker-ownership and end-to-end integration remain required before activation.

## 2026-07-28 Tasks protocol staging adapter

The isolated src/tasks/task-protocol.ts registers custom-schema handlers for
three 2026-era polling operations: tasks/get, tasks/update, tasks/cancel.
Each request must declare per-request Tasks capability and an injected validated
principal whose current allowed operations include the original read-only task.
Cross-tenant task existence is never disclosed. This adapter is NOT used by the
production factory and does not advertise a Tasks capability; no task producer
or production durable worker exists. MCP_TASKS_ENABLED remains reserved and ineffective.

## Multi-process lease and fencing substrate (staging only)

The isolated task-leases module maintains an additional SQLite WAL table for
worker ownership using unpredictable tokens and atomic transactions.
Independent SQLite connections cannot hold the same unexpired lease, and an
expired or superseded worker cannot renew, complete or release the newer lease.
Commit requires the latest unexpired token and a current uncancelled,
authorized-owner task, checked atomically. Expired work may be marked failed
without replay; there is NO production worker or lease management integration
yet and MCP_TASKS_ENABLED stays reserved/inactive. No native design writes.

## Verified-OAuth scope policy staging (not wired)

The isolated task-authorization module derives a non-reversible owner key from
verified OAuth issuer, subject and client ID. It checks live enabled tool
profile/side-effect metadata, both current OAuth and TOOL_SCOPES permissions,
expiry, and the tool input Zod schema **before enqueueing**. Remote Relay is
**denied**, not bypassed, until its existing session/grant policy can be passed
through a real task dispatcher. An HTTP handler must obtain identity solely
from the already-verified OAuth middleware, never from untrusted headers or
caller-provided tokens. No product server imports this staging evaluator yet.

## Registered-tool dispatch staging (not wired)

The separate src/tasks/task-dispatch.ts module reuses the existing ToolRegistry
MCP handler instead of calling bridge methods or tool handlers directly. It
checks that live context scopes match the trusted policy, revalidates the OAuth
principal and owner before and after a read-only invocation, rejects cancellation
and excludes tool error details from background task results. The caller must
supply genuinely verified OAuth identity; no token is stored in the task record.
Abort is checked at both ends but cannot interrupt an already-running bridge
read. Production Tasks remains disabled until the trusted context and durable
lease worker lifecycle are proven end-to-end.

## Local stdio sessions — no OAuth and no login (staging only)

The local identity path is separate from remote OAuth: a trusted stdio process
bootstrap may mint an opaque in-memory task owner identity. No browser,
username, token, or account sign-in is required for local users. WeakMap
ownership prevents request data or copied JSON from impersonating a session.
Every resolver call rechecks the current enabled ToolRegistry profile, the
actual server scope parser, and conservative read-only tool metadata. HTTP
and Remote Relay are rejected. A new process receives a distinct owner ID,
so unfinished tasks from a dead process are not replayed or accessible to a
new process using an old task handle.

This is a staging module, not yet installed in the production factory.
MCP_TASKS_ENABLED remains reserved. Future stdio-only integration must mint
the identity inside process bootstrap, never from request parameters, and
bind task creation and polling to that process. HTTP must independently use
verified OAuth if Tasks are enabled there.

## Local 2026 Tasks producer (staging only)

The isolated src/tasks/task-local-producer.ts offers a test-only low-level
modern tools/call task producer for two allowlisted read-only tools. It reuses
the owner-scoped status/cancel handlers. Before returning a task handle it
verifies per-request 2026-07-28 Tasks capability, trusted in-process stdio
identity, current ToolRegistry/profile/scopes and original Zod input schema.
SQLite state is committed before acknowledgement and the bounded runner is
scheduled. Cancellation is forwarded to the runner, not merely stored as
intent. It is NOT installed in createServer, does not advertise Tasks in
production and does not replace ordinary synchronous tools/call. Tests run
an injected mock read-only worker, not native EasyEDA acceptance.

**Known compatibility limit:** the installed high-level @modelcontextprotocol/client 2.4.0 codec currently rejects resultType=task on tools/call. The staged wire acceptance uses the genuine SDK StdioClientTransport without its higher-level result decoder. Until a supported extension codec/client route is available and tested, this producer cannot be advertised as production interoperable.
