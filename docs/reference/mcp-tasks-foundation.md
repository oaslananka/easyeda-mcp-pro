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

CRITICAL: No MCP Tasks wire handlers, task-aware tool interception or worker
are registered yet. MCP_TASKS_ENABLED remains reserved and ineffective.
The state store is not imported by the runtime; it MUST NOT be described as
working asynchronous tool execution or as crash-resumable work. The future
wire adapter must derive owner identity from already validated OAuth or the
local trusted session, enforce client capability opt-in, validate per-tool
scopes on create and all task requests, and account for Remote Relay approvals.
It also needs end-to-end modern protocol conformance tests, durable worker
ownership and cross-process recovery semantics before exposing this gate.
Never allow a background worker to perform native CAD design writes without
fresh explicit authorization, transaction preview and readback.

## 2026-07-28 Tasks protocol staging adapter

The isolated src/tasks/task-protocol.ts registers custom-schema handlers for
three 2026-era polling operations: tasks/get, tasks/update, tasks/cancel.
Each request must declare per-request Tasks capability and an injected validated
principal whose current allowed operations include the original read-only task.
Cross-tenant task existence is never disclosed. This adapter is NOT used by the
production factory and does not advertise a Tasks capability; no task producer
or durable worker exists. MCP_TASKS_ENABLED remains reserved and ineffective.
