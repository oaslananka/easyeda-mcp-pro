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
