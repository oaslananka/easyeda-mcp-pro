# Package Script Target Policy Implementation Plan

> **For agentic workers:** Use test-driven development and verification-before-completion for every task.

**Goal:** Remove the permanently broken method-registry generator entry and prevent package scripts from referencing missing local source files.

**Architecture:** A repository policy module discovers package manifests outside ignored/generated directories, tokenizes package script commands, extracts source-controlled local targets invoked by Node.js, tsx, shell, Python, and PowerShell runners, and fails with package/script/target context when any file is missing. The checker becomes part of `pnpm verify`, so protected CI detects future drift.

**Tech stack:** Node.js 24.18.0, pnpm 11.5.1, Vitest, TypeScript package manifests.

### Task 1: Define target extraction behavior

- [x] Add synthetic tests for direct Node/tsx targets, environment prefixes, `tsx watch`, quoted paths, shell/Python/PowerShell runners, inline-code exclusions, generated `dist` exclusions, and missing-file diagnostics.
- [x] Add a live repository test covering root and extension package manifests.
- [x] Confirm tests fail because the policy module does not exist.

### Task 2: Implement fail-closed repository policy

- [x] Discover package manifests recursively while excluding generated/vendor directories.
- [x] Tokenize commands without executing them.
- [x] Resolve source-controlled local targets relative to their package root.
- [x] Reject missing targets and paths escaping the repository.
- [x] Add a CLI with deterministic actionable output.

### Task 3: Remove obsolete command and wire CI

- [x] Remove the obsolete method-registry generator entry from `package.json`.
- [x] Add `check:package-scripts` and invoke it from `pnpm verify`.
- [x] Confirm no documentation references the removed command.
- [x] Add policy assertions that CI reaches the checker through the protected verification path.

### Task 4: Verify and deliver

- [x] Run focused tests, format, typecheck, lint, actionlint, and the checker directly.
- [x] Run complete `pnpm verify`.
- [ ] Commit, open a PR, wait for all protected checks, squash merge, and close #423.
