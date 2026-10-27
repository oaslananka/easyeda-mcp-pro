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
