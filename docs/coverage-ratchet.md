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
