# MCP Publisher Integrity Implementation Plan

> **For agentic workers:** Use test-driven development and verification-before-completion for every task.

**Goal:** Verify the exact MCP Registry publisher archive before extraction or execution while preserving the existing GitHub OIDC publication flow.

**Architecture:** Repository-owned JSON pins the publisher version, official checksum-manifest digest, and supported Linux asset digests. A reusable Node module validates platform mapping, policy shape, checksum evidence, and archive hash. A CLI performs verified extraction through a strict archive-member allowlist. The release workflow downloads both official files and invokes the CLI before the unchanged OIDC login/publish step.

**Tech stack:** Node.js 24.18.0, pnpm 11.5.1, Vitest, GitHub Actions, official modelcontextprotocol/registry release assets.

### Task 1: Integrity policy and deterministic verification

- [x] Add `config/mcp-publisher-integrity.json` with version `v1.7.9`, official checksum-manifest SHA-256, and Linux amd64/arm64 asset digests.
- [x] Add tests for supported mapping, unsupported OS/architecture rejection, malformed policy, checksum-manifest mismatch, manifest-entry mismatch, archive mismatch, and successful verification.
- [x] Implement the minimum reusable integrity module.

### Task 2: Verified installation

- [x] Add an installer CLI that verifies before extraction.
- [x] Reject absolute paths, traversal paths, unexpected members, missing binary, and empty binary.
- [x] Add deterministic fixtures proving extraction is not invoked on integrity failure.

### Task 3: Workflow and runbook

- [x] Replace inline unverified extraction in `publish-release.yml` with checksum-manifest download and verified installer invocation.
- [x] Preserve `./mcp-publisher login github-oidc` and publication behavior unchanged.
- [x] Add policy tests covering ordering, pinned configuration, and unsupported mapping rejection.
- [x] Document the publisher-version and integrity-evidence update procedure.

### Task 4: Verification and delivery

- [x] Run focused tests, actionlint, format, typecheck, lint, and a live official v1.7.9 install smoke.
- [x] Run `pnpm verify`.
- [x] Open a PR, wait for all protected checks, squash merge, and close #424.
