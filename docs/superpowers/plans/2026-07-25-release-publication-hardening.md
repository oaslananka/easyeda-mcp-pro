# Release Publication Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Release Please PR maintenance from fail-closed, non-cancellable, idempotent release publication.

**Architecture:** `release-please.yml` will only maintain release PRs with `skip-github-release: true`. A new `publish-release.yml` will normalize automatic/manual events, run compatibility and quality gates before immutable release creation, invoke Release Please in release-only mode, and publish npm, GitHub assets, MCP Registry, and GHCR.

**Tech Stack:** GitHub Actions, Release Please v5, Node.js 24.18.0, pnpm 11.5.1+, npm OIDC/token fallback, Vitest, actionlint, zizmor.

## Global Constraints

- Stable automatic releases use `easyeda-mcp-pro-vX.Y.Z` and npm dist-tag `latest`.
- Manual prereleases use `easyeda-mcp-pro-vX.Y.Z-rc.N` and npm dist-tag `next`.
- Compatibility and quality gates complete before automatic tag/GitHub Release creation.
- Publication jobs use `cancel-in-progress: false` and a release-tag concurrency key.
- Manual dispatches run from `main` and require a public issue or PR evidence URL in `oaslananka/easyeda-mcp-pro`.
- Immutable tags are never moved or recreated.
- No plaintext credential is added to the repository.

---

### Task 1: Publication policy resolver

**Files:**

- Modify: `scripts/release-channel-policy.mjs`
- Modify: `tests/unit/repository/release-channel-policy.test.ts`

**Interfaces:**

- Consumes: Git checkout, package/manifest versions, GitHub event environment.
- Produces: `release_run`, `release_tag`, `release_channel`, `npm_dist_tag`, `target_ref`, `create_github_release`, and `evidence_url` outputs.

- [ ] Write failing tests for an automatic release commit, existing-tag recovery, version drift, ordinary pushes, manual `main` dispatch, invalid evidence, and invalid branch/channel/tag combinations.
- [ ] Run `pnpm vitest run tests/unit/repository/release-channel-policy.test.ts` and confirm the new cases fail for missing behavior.
- [ ] Implement the minimum resolver and CLI output changes.
- [ ] Re-run the targeted test and confirm all cases pass.
- [ ] Commit the policy resolver and tests.

### Task 2: Workflow separation and ordering

**Files:**

- Modify: `.github/workflows/release-please.yml`
- Create: `.github/workflows/publish-release.yml`
- Modify: `tests/unit/repository/release-policy.test.ts`

**Interfaces:**

- Consumes: Task 1 normalized outputs.
- Produces: release-PR maintenance workflow and gated publication workflow.

- [ ] Add failing repository policy assertions that the PR manager uses `skip-github-release`, has no publication permissions/steps, and the publisher gates before release-only Release Please.
- [ ] Add failing assertions for tag-keyed non-cancelling concurrency, automatic recovery, manual evidence validation, and Docker channel isolation.
- [ ] Run `pnpm vitest run tests/unit/repository/release-policy.test.ts` and confirm the new assertions fail.
- [ ] Reduce `release-please.yml` to PR maintenance and add `publish-release.yml` with the specified ordering and permissions.
- [ ] Pin current Action releases by full SHA and update version comments.
- [ ] Re-run the targeted policy test and confirm it passes.
- [ ] Commit workflow separation and policy tests.

### Task 3: Documentation and recovery alignment

**Files:**

- Modify: `docs/RELEASE_PROCESS.md`
- Modify: `docs/release-ci-runbook.md`
- Modify: `docs/SOLO_MAINTAINER_RECOVERY.md`
- Modify: `docs/REPOSITORY_GOVERNANCE.md`

**Interfaces:**

- Consumes: final workflow filenames, triggers, and recovery semantics.
- Produces: operator instructions matching the executable workflow.

- [ ] Add failing policy assertions for the new workflow names, pre-tag gate, dispatch-from-main rule, npm OIDC/token fallback, and immutable recovery behavior.
- [ ] Run the documentation policy tests and confirm they fail.
- [ ] Update the release and recovery documentation.
- [ ] Re-run documentation policy tests and confirm they pass.
- [ ] Commit documentation changes.

### Task 4: Full verification and integration

**Files:**

- Verify all changed files.

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: a reviewable PR and green `main` after merge.

- [ ] Run Prettier, TypeScript, ESLint, actionlint, zizmor, targeted release tests, and `pnpm verify`.
- [ ] Run `pre-commit run --all-files`.
- [ ] Review `git diff --check`, workflow permissions, action pins, and publication ordering.
- [ ] Push the branch and create a PR with risk, rollback, and verification evidence.
- [ ] Wait for all required GitHub checks, fix any failures, and merge only when green.
- [ ] Verify post-merge `main` CI and a no-op Release Please PR-manager run.
