# Dispatcher Canvas Domain Extraction Implementation Plan

**Goal:** Move `canvas.capture`, `canvas.captureRegion`, and `canvas.locate` behind one typed canvas-operation factory without changing binary payload normalization, transport-budget enforcement, repaint timing, errors, or public method contracts.

**Architecture:** Add `canvas-operations.ts` with injected `callFirst`, binary-result normalizer, bridge-error factory, and animation-frame root. The dispatcher retains the shared payload-size policy and binds the domain factory during `createDispatcher()`. Canvas switch cases become thin delegates.

## Constraints

- Preserve all 67 public bridge methods.
- Keep binary payload and `BRIDGE_MAX_PAYLOAD_SIZE` safety logic in the dispatcher shared layer.
- Preserve capture filenames, tab handling, region coordinate normalization, zero-area/finite validation, and exact errors.
- Preserve zoom-before-capture ordering and the bounded two-frame repaint wait.
- Preserve `canvas.locate` argument forwarding.
- Keep package output within the repository size budget.

## Task 1 — Lock the canvas contract

- [x] Add focused tests for full capture, non-string tab handling, normalized region capture, invalid coordinates, zero-area bounds, rejected zoom, animation-frame settlement, bounded frame timeout, and locate forwarding.
- [x] Run the focused test before implementation and record module-not-found RED.
- [x] Confirm the existing 89 dispatcher integration tests remain green.

## Task 2 — Extract the typed canvas factory

- [x] Add `easyeda-bridge-extension/src/canvas-operations.ts`.
- [x] Export typed dependencies and `CanvasOperations` interfaces.
- [x] Move region normalization and repaint waiting into the module.
- [x] Implement capture, capture-region, and locate operations with injected dependencies.
- [x] Bind the factory in `createDispatcher()` and replace switch bodies with delegates.

## Task 3 — Prove parity

- [x] Reach 100% statement, branch, function, and line coverage for the new module.
- [x] Run focused module and dispatcher tests.
- [x] Run method-list parity and extension size-budget checks.
- [x] Compare source, dispatcher bundle, and `.eext` sizes against `main`.
- [x] Run full `pnpm verify`.
- [x] Record final evidence before opening the PR.

## Execution evidence

- TDD RED: the focused canvas test failed with module-not-found before `src/canvas-operations.ts` existed.
- Pre-extraction baseline: all 89 dispatcher integration tests and extension typecheck passed.
- Focused parity: 7 canvas-domain and 90 dispatcher tests pass (97 total).
- Extracted-module coverage: 100% statements, branches, functions, and lines (`LF=33`, `LH=33`, `BRF=15`, `BRH=15`).
- Codecov follow-up: the initial patch report found the `canvas.capture` and `canvas.locate` dispatcher delegates uncovered; a dispatcher integration contract now executes both paths and verifies binary normalization plus locate argument forwarding (`DA:4487=1`, `DA:4489=3`, `DA:4491=1`).
- Public method contract: all 67 sorted bridge methods remain unchanged; method-list parity passes.
- Dispatcher source size: 4,760 lines on `main` → 4,679 lines after extraction (-81).
- Built dispatcher bundle: 152,566 bytes on `main` → 153,348 bytes (+782 bytes, approximately +0.51%).
- Packaged extension: 160,951 bytes on `main` → 161,147 bytes (+196 bytes, approximately +0.12%); the size budget passes.
- Full extension suite: 12 files / 167 tests pass.
- Full server suite: 150 files / 1,740 tests pass.
- Full `pnpm verify` passes Node.js/pnpm preflight, formatting, root and extension typecheck, ESLint, tool/profile metadata, server and extension tests, both builds, extension packaging/checksums, metadata alignment, generated compatibility validation, and VitePress documentation.
