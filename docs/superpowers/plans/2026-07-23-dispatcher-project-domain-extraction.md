# Dispatcher Project Domain Extraction Implementation Plan

**Goal:** Move `project.open`, `project.save`, and `project.export` behind one typed project-operation factory without changing runtime path precedence, arguments, results, errors, or public method contracts.

**Architecture:** Add `project-operations.ts` with a single injected `callFirst` dependency from `api-runtime.ts`. The dispatcher binds the factory during `createDispatcher()` and keeps only three thin switch delegates.

## Constraints

- Preserve all 67 public bridge methods.
- Preserve `project.open` path order and exact `projectId` forwarding.
- Preserve the five-path save fallback order and zero-argument invocation.
- Preserve project export path order and exact params-object forwarding.
- Preserve errors from the shared API runtime without wrapping or translation.
- Keep package output within the repository size budget.

## Task 1 — Lock the project contract

- [x] Add focused tests for open, save, and export path/argument forwarding.
- [x] Add one dispatcher integration contract that executes all three delegates.
- [x] Run the focused module test before implementation and record module-not-found RED.
- [x] Confirm the existing 90 dispatcher integration tests remain green before extraction.

## Task 2 — Extract the typed project factory

- [x] Add `easyeda-bridge-extension/src/project-operations.ts`.
- [x] Export typed dependency and operation interfaces.
- [x] Bind the factory in `createDispatcher()`.
- [x] Replace the three switch implementations with thin delegates.

## Task 3 — Prove parity

- [x] Reach 100% statement, branch, function, and line coverage for the new module.
- [x] Run focused project and dispatcher tests.
- [x] Run method-list parity and extension size-budget checks.
- [x] Compare source, dispatcher bundle, and `.eext` sizes against `main`.
- [x] Run full `pnpm verify`.
- [x] Record final evidence before opening the PR.

## Execution evidence

- TDD RED: the focused project-domain test failed with module-not-found before `src/project-operations.ts` existed.
- Pre-extraction baseline: all 90 dispatcher integration tests and extension typecheck passed.
- Focused parity: 3 project-domain and 91 dispatcher tests pass (94 total).
- Extracted-module coverage: 100% statements, functions, and lines (`LF=4`, `LH=4`); the module has no conditional branches (`BRF=0`).
- Dispatcher delegate coverage: `project.open`, `project.save`, and `project.export` each execute once in the integration suite; factory binding executes 104 times.
- Public method contract: all 67 sorted bridge methods remain unchanged; method-list parity passes.
- Dispatcher source size: 4,679 lines on `main` → 4,673 lines after extraction (-6).
- Built dispatcher bundle: 153,348 bytes on `main` → 153,845 bytes (+497 bytes, approximately +0.32%).
- Packaged extension: 161,147 bytes on `main` → 161,319 bytes (+172 bytes, approximately +0.11%); the size budget passes.
- Full extension suite: 13 files / 171 tests pass.
- Full server suite: 150 files / 1,740 tests pass.
- Full `pnpm verify` passes Node.js/pnpm preflight, formatting, root and extension typecheck, ESLint, tool/profile metadata, server and extension tests, both builds, extension packaging/checksums, metadata alignment, generated compatibility validation, and VitePress documentation.
