# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 24 July 2026 repository audit findings with regression tests, fail-closed release evidence, and reviewable issue-scoped commits.

**Architecture:** Apply small boundary fixes rather than a broad rewrite. Registry data remains the source of truth for capabilities, board primitives are normalized at the extension boundary, and release readiness is represented by executable policy checks rather than prose claims.

**Tech Stack:** TypeScript 6, Node.js 24.18.0, pnpm 11.5.1, Vitest 4, fast-check, VitePress, Docker, GitHub Actions.

## Global Constraints

- Node.js must remain `>=24 <25`; verification uses exactly `24.18.0`.
- pnpm must remain exactly `11.5.1`.
- No high or critical dependency advisory may be allowlisted.
- No live EasyEDA compatibility claim may be emitted without evidence bound to the tested commit SHA.
- Existing write confirmation, OAuth, pairing, scope, and human-approval controls must not be weakened.
- Changes are committed in issue-scoped units and final verification is run from a clean worktree.

---

### Task 1: Establish clean baseline and planning artifacts

**Files:**

- Create: `docs/superpowers/specs/2026-07-24-audit-remediation-design.md`
- Create: `docs/superpowers/plans/2026-07-24-audit-remediation.md`

**Interfaces:**

- Consumes: repository HEAD `04828be1e54230ab78a542bf39b84664ac1c9b3c`.
- Produces: a clean Node 24/pnpm 11 baseline and the implementation contract for later tasks.

- [ ] Run `pnpm install --frozen-lockfile` in Node.js 24.18.0 with the pnpm store outside the repository.
- [ ] Run `pnpm verify`; expected result is all existing checks passing.
- [ ] Commit the two planning documents with `docs: plan 24 July audit remediation`.

### Task 2: Remediate PostCSS advisory (#390)

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Test: `tests/unit/repository/dependency-audit-policy.test.ts`

**Interfaces:**

- Consumes: existing `pnpm.overrides` and strict dependency-audit script.
- Produces: a lockfile resolving every PostCSS path to a patched `8.5.x` release.

- [ ] Add a repository-policy test asserting the patched PostCSS override and lockfile resolution.
- [ ] Run the test and confirm it fails because the override is absent.
- [ ] Add `postcss: 8.5.23` to `overrides` and regenerate the lockfile with pnpm 11.5.1.
- [ ] Run the targeted policy test, `pnpm security:audit`, and `pnpm audit --prod`; expected results are pass, pass, and no production advisories.
- [ ] Commit with `security(deps): remediate PostCSS advisory (#390)`.

### Task 3: Fix board-outline detection (#389)

**Files:**

- Create: `easyeda-bridge-extension/src/pcb-primitive-state.ts`
- Modify: `easyeda-bridge-extension/src/board-inspection.ts`
- Modify: `easyeda-bridge-extension/tests/board-inspection.test.ts`

**Interfaces:**

- Produces: `readPrimitiveState(value, key)` and `isBoardOutlineLayer(value)` helpers used by board inspection.

- [ ] Add tests for numeric layer 11, string layer names, nested layer records, direct state fields, line endpoint fields, points arrays, and outline arcs.
- [ ] Run the board-inspection tests and confirm the new real-world shapes fail.
- [ ] Implement tolerant state lookup without coercing arbitrary objects to strings; recognize canonical `Board Outline` and `Board Outline Layer` names plus numeric layer 11.
- [ ] Include line endpoints when a primitive does not expose a points array and ignore non-finite coordinates.
- [ ] Run extension board tests and dispatcher regression tests; expected result is pass.
- [ ] Commit with `fix(pcb): detect board outlines across live primitive shapes (#389)`.

### Task 4: Add deterministic property-based protocol tests (#388)

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/unit/security/protocol-properties.test.ts`
- Modify: `docs/development/security-tooling.md`

**Interfaces:**

- Consumes: exported bridge/remote protocol parsers.
- Produces: deterministic bounded properties with fixed seeds and replay paths.

- [ ] Add pinned `fast-check` as a development dependency under repository release-age policy.
- [ ] Add a property proving malformed bridge messages never crash and fail closed.
- [ ] Add a property proving remote/session parser normalization is deterministic and size-bounded.
- [ ] Run the tests and confirm the initial properties fail for an identified unhandled shape or missing dependency.
- [ ] Make only the minimal parser hardening needed for the properties to pass.
- [ ] Document seed/replay commands and run the full security/unit suites.
- [ ] Commit with `security(test): add deterministic protocol property tests (#388)`.

### Task 5: Eliminate capability-count drift (#393)

**Files:**

- Modify: `scripts/generate-tools-doc.ts`
- Create: `scripts/update-capability-counts.mts`
- Modify: `README.md`
- Modify: `docs/security-architecture.md`
- Modify: `package.json`
- Create: `tests/unit/repository/capability-docs-policy.test.ts`

**Interfaces:**

- Consumes: `PROFILE_DEFINITIONS` and registered tool metadata.
- Produces: generated count markers and a `check:capability-docs` gate.

- [ ] Add a failing policy test detecting stale hand-written counts.
- [ ] Add generated markers and a script that writes/checks exact `71/98/110/115` values from source metadata.
- [ ] Replace the stale `60`, `77`, and `47/54/63/67` statements.
- [ ] Add the check to `verify` and run it in write then check mode.
- [ ] Commit with `docs: generate profile capability counts (#393)`.

### Task 6: Align export safety semantics (#394)

**Files:**

- Modify: `src/tools/types.ts`
- Modify: `src/tools/L1_export.ts`
- Modify: `src/tools/registry.ts`
- Modify: `docs/security-architecture.md`
- Modify: `docs/SAFETY_MODEL.md`
- Modify: `docs/TOOL_APPROVAL_POLICY.md`
- Modify: relevant registry/export tests.

**Interfaces:**

- Produces: explicit side-effect classification distinguishing `design-mutation`, `artifact-write`, and `read-only`.

- [ ] Add tests asserting exports are artifact writes, not design mutations, and remain subject to remote human approval where configured.
- [ ] Run tests and confirm metadata lacks the explicit classification.
- [ ] Add the minimal metadata field and registry mapping while preserving current `confirmWrite` behavior.
- [ ] Rewrite safety tables to match executable behavior.
- [ ] Run registry, export, and remote approval tests.
- [ ] Commit with `safety: classify export artifact side effects (#394)`.

### Task 7: Canonicalize Remote Relay readiness (#395)

**Files:**

- Create: `docs/REMOTE_RELAY_STATUS.md`
- Modify: `docs/REMOTE_GATEWAY_DESIGN.md`
- Modify: `docs/REMOTE_MCP_MODES.md`
- Modify: `docs/REMOTE_RELEASE_READINESS.md`
- Modify: `docs/SELF_HOSTED_REMOTE_MCP.md`
- Modify: `docs/.vitepress/config.ts`
- Create: `tests/unit/repository/remote-docs-policy.test.ts`

**Interfaces:**

- Produces: one canonical status page and machine-checked links from superseded documents.

- [ ] Add a failing docs-policy test requiring the canonical page and superseded notices.
- [ ] Write the status matrix from implemented routes/tests and clearly mark hosted deployment evidence separately.
- [ ] Add notices and navigation links.
- [ ] Run docs policy and VitePress build.
- [ ] Commit with `docs(remote): establish canonical relay status (#395)`.

### Task 8: Add Docker host-network smoke coverage (#396)

**Files:**

- Create: `scripts/e2e/docker-network-smoke.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/INSTALLATION.md`
- Modify: `docs/SELF_HOSTED_REMOTE_MCP.md`
- Create: `tests/unit/repository/docker-network-policy.test.ts`

**Interfaces:**

- Produces: a smoke script that calls `/healthz` from the host through a published port and verifies unsafe non-loopback startup fails closed.

- [ ] Add a failing repository-policy test requiring the host-network smoke step.
- [ ] Implement the smoke script with deterministic container cleanup.
- [ ] Add authenticated/reverse-proxy and local-only examples.
- [ ] Run the policy test and local Docker smoke.
- [ ] Commit with `ci(docker): test host-reachable deployment paths (#396)`.

### Task 9: Classify configuration maturity (#398)

**Files:**

- Modify: `src/config/env.ts`
- Modify: diagnostics output and tests.
- Modify: `docs/guide/configuration.md`
- Modify: `docs/agent-runtime-config.md`

**Interfaces:**

- Produces: `implemented | experimental | reserved` maturity metadata for user-visible configuration.

- [ ] Add failing diagnostics tests for AI, MCP Apps, Tasks, experimental protocol, and OTEL settings.
- [ ] Implement maturity metadata without changing runtime enablement.
- [ ] Update docs so reserved settings cannot be mistaken for active product features.
- [ ] Run config/diagnostics tests.
- [ ] Commit with `docs(config): expose feature maturity accurately (#398)`.

### Task 10: Isolate local package-manager artifacts (#400)

**Files:**

- Modify: `.gitignore`
- Modify: `.prettierignore`
- Modify: secret-hygiene and formatting policy tests.

**Interfaces:**

- Produces: ignored `.pnpm-store/` and cache paths that cannot pollute repository-wide scans.

- [ ] Add a failing policy test for local store exclusions.
- [ ] Add `.pnpm-store/` and documented cache paths to both ignore files where appropriate.
- [ ] Run format and secret-hygiene checks with a synthetic store directory present.
- [ ] Commit with `devex: isolate local pnpm store artifacts (#400)`.

### Task 11: Strengthen solo-maintainer governance and recovery (#407)

**Files:**

- Modify: `config/repository-governance.json`
- Modify: `docs/REPOSITORY_GOVERNANCE.md`
- Modify: `docs/MAINTAINER_CONTINUITY.md`
- Modify: `tests/unit/repository/governance-policy.test.ts`

**Interfaces:**

- Produces: an explicit activation condition and validation command for one required independent approval when a second eligible maintainer exists.

- [ ] Add a failing policy test for the activation condition and review settings.
- [ ] Encode the target branch-protection state and accountable activation procedure.
- [ ] Preserve the truthful current bus-factor-one statement.
- [ ] Run governance tests.
- [ ] Commit with `governance: define independent review activation (#407)`.

### Task 12: Add commit-bound compatibility and stabilization gates (#391, #392)

**Files:**

- Modify: `config/easyeda-compatibility.json`
- Modify: `scripts/generate-easyeda-compatibility.mjs`
- Create: `scripts/check-release-readiness.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/RELEASE_VERIFICATION.md`
- Modify: compatibility/release policy tests.

**Interfaces:**

- Produces: `pnpm release:readiness` that fails when extension changes postdate live evidence or any required gate is red.

- [ ] Add failing tests for stale compatibility evidence relative to extension source changes.
- [ ] Bind live evidence to tested commit/version and expose `current | stale | unavailable` state.
- [ ] Implement the release-readiness orchestration command.
- [ ] Add the command to CI and document exact live-smoke evidence required to clear stale state.
- [ ] Run policy tests and demonstrate stale evidence blocks readiness until a real live record is supplied.
- [ ] Commit with `release: enforce commit-bound stabilization evidence (#391 #392)`.

### Task 13: Focused maintainability extraction (#397)

**Files:**

- Modify only modules touched by Tasks 3–12 where extraction materially reduces responsibility.
- Test: existing targeted suites plus coverage.

**Interfaces:**

- Produces: bounded helpers with no public tool or bridge contract change.

- [ ] Identify duplicated parsing/classification logic introduced or exposed by remediation.
- [ ] Add characterization tests before extraction.
- [ ] Extract only cohesive helpers used by at least two call sites or required to keep modified files bounded.
- [ ] Run targeted suites and coverage.
- [ ] Commit with `refactor: bound remediation support modules (#397)`.

### Task 14: Final verification, PR, and issue disposition (#401)

**Files:**

- Modify: issue comments/state through GitHub API only.

**Interfaces:**

- Produces: a reviewable PR and evidence-based issue closures.

- [ ] Run `pnpm security:audit`, `pnpm verify`, `pnpm test:coverage`, extension verification, package dry-run, Docker network smoke, and `pnpm release:readiness` under the pinned runtime.
- [ ] Confirm the worktree is clean after generated artifacts are handled.
- [ ] Push the branch and open a PR referencing #388–#401.
- [ ] Close only issues whose acceptance criteria are fully met; comment exact remaining external blockers on live-runtime or maintainer-dependent issues.
- [ ] Update epic #401 with command outputs, test counts, PR link, and unresolved external evidence.
