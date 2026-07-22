# Coverage ratchet

This document records the coverage baseline used to ratchet CI thresholds for safety-sensitive code paths.

## 2026-07-04 baseline

Measured with:

```bash
pnpm exec vitest run --coverage
```

Result:

| Metric     | Baseline | Previous threshold | New threshold |
| ---------- | -------- | ------------------ | ------------- |
| Statements | 87.26%   | 70%                | 80%           |
| Branches   | 73.82%   | 55%                | 70%           |
| Functions  | 90.78%   | 70%                | 80%           |
| Lines      | 88.47%   | 70%                | 80%           |

The branch threshold is the primary safety ratchet. The repo now keeps enough error-path and guard-branch coverage to require at least 70% branch coverage in CI.

## Risk modules already covered by targeted tests

The current suite includes targeted coverage for:

- schematic write guardrails, dry-run placement preview, collision warning, and write read-back verification,
- bridge manager/protocol behavior and error handling,
- runtime safety checks,
- HTTP transport, auth metadata, remote gateway routing, and scope normalization,
- vendor API error handling for DigiKey, Mouser, LCSC, JLCPCB, and shared HTTP client paths.

Future changes should raise thresholds gradually and only after adding tests for real error/guard branches. Do not lower coverage thresholds to ship a feature; add focused tests or split the change.

## 2026-07-23 extension baseline

Measured on Node.js 24 with the same command used by the Ubuntu quality job:

```bash
pnpm test:extension:ci
```

Result and enforceable floor:

| Metric     | Measured baseline | Blocking threshold | Next target |
| ---------- | ----------------- | ------------------ | ----------- |
| Statements | 51.49%            | 51%                | 65%         |
| Branches   | 46.41%            | 46%                | 50%         |
| Functions  | 61.35%            | 61%                | 70%         |
| Lines      | 52.15%            | 52%                | 65%         |

The thresholds deliberately round down the measured result instead of claiming coverage that the current harness cannot attribute. The extension build tests execute the bundled loader, but V8 does not map that generated bundle execution back to `src/index.ts`; therefore the loader currently remains visible as uncovered source.

Do not exclude `src/index.ts`, `src/dispatcher-entry.ts`, or other executable trust-boundary code to inflate the percentage. The only exclusion is non-executable TypeScript declaration files. The JSON summary, LCOV report, and JUnit results remain separate from the server suite and are uploaded under the extension Codecov flags.

Issue #337 owns direct lifecycle, approval, timeout, reconnect, and shutdown tests for the loader. Those behavior tests should raise this ratchet toward the 65% statements/lines, 70% functions, and 50% branches target. Thresholds may increase when supported by measured coverage; lowering them requires a public regression rationale and must not be used to ship an uncovered feature.

## 2026-07-23 extension lifecycle ratchet

Issue #337 added direct source-level tests for the extension loader and Remote Relay lifecycle instead of relying only on generated-bundle VM execution. The suite now exercises auto-connect state transitions, complete port exhaustion and recovery, silent `SYS_WebSocket.register` fallback, duplicate connect suppression, heartbeat-stale cleanup, protocol/contract mismatch diagnostics, approval timeout and rejection, reconnect session binding, and unload cleanup.

Measured on Node.js 24 with:

```bash
pnpm test:extension:ci
```

| Metric     | Previous measured | New measured | Previous threshold | New threshold |
| ---------- | ----------------- | ------------ | ------------------ | ------------- |
| Statements | 51.49%            | 67.22%       | 51%                | 65%           |
| Branches   | 46.41%            | 55.20%       | 46%                | 50%           |
| Functions  | 61.35%            | 81.51%       | 61%                | 70%           |
| Lines      | 52.15%            | 68.93%       | 52%                | 65%           |

The direct loader harness raises `src/index.ts` itself to 63.47% statements, 45.64% branches, 72.54% functions, and 64.67% lines. `src/remote-client.ts` reaches 81.97% statements, 68.69% branches, 93.10% functions, and 85.43% lines.

The tests also exposed and fixed two lifecycle/security defects:

- extension deactivation closed the local bridge but left the Remote Relay socket and timers alive;
- an approval or tool request started on an old relay socket could complete after reconnect and send its result on the replacement session.

Remote approval and tool responses are now bound to the socket that received the request and are dropped if that socket is no longer active. Deactivation closes both local and remote transports and clears their timers. Executable loader sources remain in the coverage denominator; no source exclusion was added to obtain the increase.

## 2026-07-23 remote gateway ratchet

Issue #338 added a real WebSocket relay harness plus multi-session concurrency tests for `src/remote/gateway.ts`. The suite now verifies malformed JSON/schema rejection, registration requirements, same-socket session replacement, user/session isolation, parallel execution across independent sessions, per-session serialization, approval metadata binding, cross-session response rejection, duplicate response rejection, timeout quarantine, and immediate in-flight cleanup when a session or socket closes.

Measured with the server CI command on Node.js 24:

```bash
pnpm test:coverage:ci
```

| Metric     | Previous measured | New measured | Blocking module threshold |
| ---------- | ----------------- | ------------ | ------------------------- |
| Statements | 63.14%            | 83.18%       | —                         |
| Branches   | 57.72%            | 72.22%       | 70%                       |
| Functions  | 83.05%            | 92.85%       | —                         |
| Lines      | 64.78%            | 86.12%       | 80%                       |

Vitest now enforces the line and branch floors directly for `src/remote/gateway.ts`, in addition to the repository-wide thresholds. The tests exposed and fixed these relay boundary defects:

- registering a second session on the same socket left the previous session connected;
- approval and tool responses were accepted even when their `sessionId` did not match the socket's active session;
- duplicate or unknown tool responses were silently ignored;
- `session_closed` and socket close rejected in-flight requests with a generic extension error or only after their deadline.

Re-registration now disconnects and rejects the old session before replacement. Relay responses must match the active session, unknown request IDs return `REQUEST_NOT_FOUND`, and socket/session teardown rejects pending requests immediately as `SESSION_DISCONNECTED` with HTTP-equivalent status 424. Different sessions remain concurrently dispatchable while requests targeting the same session remain serialized.
