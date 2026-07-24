# 24 July 2026 Audit Remediation Design

## Objective

Resolve the actionable findings tracked by issues #388–#400 without weakening existing safety, compatibility, supply-chain, or release gates. Work is delivered as one reviewable branch with isolated commits per concern and a final full verification pass.

## Chosen approach

Three approaches were considered:

1. **One large rewrite:** fastest to type but difficult to review, bisect, and verify. Rejected.
2. **Independent branches for every issue:** strongest isolation but duplicates setup and creates ordering conflicts across shared docs and CI. Rejected for this remediation batch.
3. **One branch with dependency-ordered, issue-scoped commits:** preserves atomic review boundaries while allowing shared generated artifacts and release checks to evolve together. Selected.

## Work streams

### Release blockers

- Upgrade the vulnerable PostCSS resolution to a patched release while preserving frozen-lockfile and release-age policy checks.
- Reproduce the board-outline failure with fixtures that use real-world layer/type representations, then normalize layer identity and primitive state at the board-inspection boundary.
- Add a deterministic stabilization command and documented release gate that includes dependency audit, full verification, packaging, and compatibility evidence checks.

### Security and correctness

- Add deterministic `fast-check` properties for bridge and remote protocol/parser boundaries.
- Generate profile counts and capability statements from registry-backed data instead of hand-maintained numbers.
- Separate design mutation, filesystem artifact creation, and remote approval semantics in tool metadata and public safety documentation.
- Establish a canonical Remote Relay readiness document and point older documents to it.
- Add host-to-container network smoke coverage for authenticated/non-loopback Docker deployment.

### Maintainability and product truthfulness

- Extract cohesive board-outline normalization from `board-inspection.ts`; avoid broad unrelated rewrites.
- Classify configuration keys as implemented, experimental, or reserved and expose that status consistently in diagnostics/docs.
- Prevent local pnpm stores and generated caches from entering repository-wide formatting/hygiene scans.
- Strengthen the governance policy so independent-review enforcement is activated automatically when an eligible second maintainer exists, while retaining an honest solo-maintainer limitation.

## Compatibility strategy

Automated compatibility evidence is commit-bound and must never claim that a changed extension HEAD was live-tested unless a recorded live run matches that SHA. The remediation adds stale-evidence detection and a reproducible live-smoke checklist. Actual GUI validation is performed only when an EasyEDA runtime is available; otherwise the release gate remains blocked rather than fabricating evidence.

## Testing strategy

Every behavior change follows red-green TDD. Targeted tests run first, then relevant package suites, then the full project gate under Node.js 24.18.0 and pnpm 11.5.1. Dependency, package, documentation, secret-hygiene, and Docker network checks are included in final verification.

## Delivery and issue closure

Each issue is closed only when its acceptance criteria are evidenced by committed code, tests, documentation, or an externally verifiable governance/runtime result. Issues requiring a human maintainer or live GUI remain open with precise blocker evidence; they are not marked complete by documentation alone.

## Maintainability outcomes

The remediation used bounded extractions instead of broad rewrites:

- `easyeda-bridge-extension/src/pcb-primitive-state.ts` owns live-wrapper state lookup, board-outline
  layer normalization, and finite-number handling. `board-inspection.ts` remains responsible for
  board-level aggregation and public result shaping.
- `src/tools/diagnostics-feature-report.ts` owns the three public diagnostics flag views.
  `L0_diagnostics_core.ts` remains responsible for registering tools and composing diagnostics
  payloads.

No public MCP tool name, input schema, output schema, or relay envelope changed. Existing extension
method parity, registry coverage, package-size budgets, and generated references remained green.

### Remaining hotspot register

The following large modules remain intentional follow-up candidates rather than being mixed into this
security/release remediation:

- `easyeda-bridge-extension/src/dispatcher.ts` — dispatcher orchestration and compatibility routing;
- `src/tools/L2_workflows.ts` — compound workflow definitions;
- `src/tools/L1_schematic_read.ts` and `src/tools/L1_schematic_write.ts` — schematic tool families;
- `easyeda-bridge-extension/src/index.ts` — loader and connection lifecycle;
- `src/remote/gateway.ts` — relay orchestration and approval lifecycle.

Future decomposition must begin with characterization tests, preserve bridge/MCP contracts, and avoid
splitting code solely to satisfy a line-count target.
