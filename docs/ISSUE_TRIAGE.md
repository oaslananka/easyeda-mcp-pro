# Issue Triage Policy

This project uses issue metadata to keep hardware-safety, release, and documentation work auditable.

## Required issue fields

Every actionable issue should include:

- Problem or context
- Evidence or reproduction path
- Expected behavior
- Acceptance criteria
- Area label
- Priority label
- Risk label when safety, security, write tools, or supply chain is involved

## Label taxonomy

| Label family | Purpose             | Examples                                                                |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| `area:*`     | Subsystem ownership | `area:docs`, `area:release`, `area:security`, `area:easyeda-bridge`     |
| `priority:*` | Triage priority     | `priority:P0`, `priority:P1`, `priority:P2`                             |
| `kind:*`     | Work type           | `kind:test`, `kind:research`, `kind:process`, `kind:security-hardening` |
| `risk:*`     | Risk class          | `risk:agent-safety`, `risk:supply-chain`                                |
| `status:*`   | Current state       | `status:needs-research`, `status:ready`, `status:blocked`               |
| `effort:*`   | Expected size       | `effort:S`, `effort:M`, `effort:L`, `effort:XL`                         |

## Priority definitions

- `P0`: blocks installation, release, security, or live bridge operation.
- `P1`: important product, safety, or supply-chain work for the next milestone.
- `P2`: roadmap, documentation, research, examples, or polish.

## Closure policy

Close an issue only when:

1. The implementation or documentation is merged to `main`.
2. The relevant CI/release checks pass.
3. The closing comment links the PR or release evidence.
4. Acceptance criteria are either satisfied or explicitly superseded.

Do not close large feature issues merely because a partial design note exists. Split them when needed.
