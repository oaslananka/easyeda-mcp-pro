# Security Local Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic Semgrep pre-commit/CI scanning, version-pinned Snyk pre-push commands, and SonarQube Cloud Connected Mode guidance.

**Architecture:** The Python pre-commit framework orchestrates fast local checks. Repository-owned Semgrep rules run without cloud credentials, Snyk Open Source runs only before push, and cloud-native SonarQube/Snyk checks remain authoritative on pull requests.

**Tech Stack:** pre-commit, Semgrep CE 1.170.0, Snyk CLI 1.1306.1, pnpm, Vitest, GitHub Actions, SARIF.

## Global Constraints

- Do not commit secrets or require cloud credentials for Semgrep.
- Keep commit-time checks fast and staged-file scoped.
- Keep Snyk network/authentication work at pre-push or explicit command scope.
- Preserve the existing CodeQL, Dependency Review, Snyk App, and SonarQube Cloud integrations.
- Pin third-party tool versions.

---

### Task 1: Repository security-tooling contract

**Files:**

- Create: `tests/unit/repository/security-tooling-policy.test.ts`

**Interfaces:**

- Consumes: repository text files and `package.json`.
- Produces: a Vitest policy suite that defines the required hooks, scripts, workflow, versions, and documentation.

- [ ] Write tests asserting the Semgrep pre-commit hook, Snyk pre-push hook, pinned scripts, local rules, CI workflow, and documentation exist.
- [ ] Run `pnpm vitest run tests/unit/repository/security-tooling-policy.test.ts` and verify it fails because the files and settings do not yet exist.
- [ ] Keep the failing output as red-phase evidence.

### Task 2: Semgrep rule behavior

**Files:**

- Create: `.semgrep.yml`
- Create: `.semgrepignore`
- Create: `tests/semgrep/security-rules.ts`

**Interfaces:**

- Consumes: JavaScript and TypeScript source.
- Produces: rule IDs `easyeda.security.no-dynamic-code-execution`, `easyeda.security.no-shell-child-process`, and `easyeda.security.no-disabled-tls-verification`.

- [ ] Add intentional positive and negative examples to `tests/semgrep/security-rules.ts`.
- [ ] Run Semgrep rule tests before adding the rules and verify the expected rule IDs are missing.
- [ ] Implement the three high-confidence rules and generated/test-fixture exclusions.
- [ ] Run `semgrep --validate --config .semgrep.yml`, `pnpm security:semgrep:test`, and a full scan; verify all complete successfully with zero production findings. The Node wrapper copies the rule and fixture to matching temporary filenames before invoking Semgrep test mode.

### Task 3: Local hook orchestration and developer commands

**Files:**

- Modify: `.pre-commit-config.yaml`
- Modify: `package.json`

**Interfaces:**

- Consumes: `.semgrep.yml`, pnpm, and authenticated Snyk CLI execution through `pnpm dlx`.
- Produces: staged Semgrep scanning, pre-push Snyk Open Source scanning, and explicit security scripts.

- [ ] Upgrade `pre-commit-hooks` to `v6.0.0`; add case-conflict, large-file, and private-key checks.
- [ ] Add Semgrep `v1.170.0` at the `pre-commit` stage using the local configuration and metrics disabled.
- [ ] Add local `snyk-oss` at the `pre-push` stage with `pass_filenames: false`.
- [ ] Add `security:semgrep`, `security:semgrep:test`, `security:snyk:oss`, `security:snyk:code`, and `security:snyk` scripts with Snyk `1.1306.1` pinned and invoked through Corepack.
- [ ] Install pre-commit in an isolated Python environment and run configuration validation plus all hooks except the authenticated Snyk hook.

### Task 4: CI and documentation

**Files:**

- Create: `.github/workflows/static-security-analysis.yml`
- Create: `docs/development/security-tooling.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/security-architecture.md`

**Interfaces:**

- Consumes: local Semgrep rules and existing GitHub security integrations.
- Produces: full-repository Semgrep CI, SARIF upload for trusted events, and developer setup instructions.

- [ ] Add a pinned Semgrep workflow for PRs, pushes to `main`, weekly scans, and manual dispatch.
- [ ] Validate rules, run rule tests, run the full scan, and upload SARIF without requiring a Semgrep token.
- [ ] Document pre-commit installation, hook installation, Snyk authentication, Connected Mode, normal commands, and explicit emergency bypass behavior.
- [ ] Link the guide from `CONTRIBUTING.md` and record the controls in the security architecture.

### Task 5: Final verification and delivery

**Files:**

- Review all changed files.

**Interfaces:**

- Consumes: all previous tasks.
- Produces: a reviewable branch and pull request.

- [ ] Run the policy test and Semgrep validation/rule/full scans.
- [ ] Run `mise exec node@24.18.0 -- corepack pnpm verify`.
- [ ] Run `git diff --check` and inspect the final diff for credentials or unintended generated artifacts.
- [ ] Commit with conventional commits, push the branch, open a PR, and inspect GitHub checks. Do not merge without explicit authorization.
