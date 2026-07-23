# Dispatcher API Runtime Extraction Implementation Plan

**Goal:** Move EasyEDA runtime-root discovery, class/method resolution, API inventory assembly, and authorized `api.call` execution from `dispatcher.ts` into one typed factory without changing any public method, error, or response contract.

**Architecture:** Add `api-runtime.ts` as a browser-safe factory depending on the existing `api-introspection.ts`, `toolkit.ts`, and `utils.ts` contracts. The factory receives the narrow runtime-root subset of `DispatcherToolkit` and the dispatcher's existing bridge-error factory. `dispatcher.ts` retains method routing and all domain operations, but binds the factory's four functions during `createDispatcher()`.

## Constraints

- Preserve root precedence: `eda` → `EDA` → `api` → `globalThis`.
- Re-read toolkit roots on every call so late runtime availability remains supported.
- Preserve lowercase/uppercase EasyEDA class variants and method receiver binding.
- Preserve `METHOD_NOT_FOUND` and `UNAUTHORIZED` error metadata and messages.
- Preserve inventory normalization, filtering, sorting, deduplication, and response shape.
- Preserve all 67 public methods and the package size budget.
- Do not introduce a new EasyEDA capability.

## Task 1 — Lock the runtime contract

- [x] Add focused tests for root precedence, dynamic roots, receiver binding, class variants, first-value reads, inventory deduplication/filtering, authorized calls, normalization, and bounded errors.
- [x] Run the focused test before implementation and record the expected module-not-found RED.
- [x] Confirm existing dispatcher integration tests remain green.

## Task 2 — Extract the typed runtime factory

- [x] Add `easyeda-bridge-extension/src/api-runtime.ts`.
- [x] Export a typed `ApiRuntime` interface and `createApiRuntime()` factory.
- [x] Move `getApiCandidates`, `callFirst`, `readFirstPath`, `inspectApiInventory`, and `callAllowedApi` behavior into the factory.
- [x] Bind factory functions in `createDispatcher()` without changing call sites or routing.
- [x] Remove dispatcher imports used only by the extracted runtime.

## Task 3 — Prove parity

- [x] Run focused runtime and dispatcher tests.
- [x] Reach full branch/line coverage for the extracted module.
- [x] Run method-list parity and extension size-budget checks.
- [x] Compare dispatcher source and built package sizes with `main`.
- [x] Run full `pnpm verify`.
- [x] Record final evidence here before opening the PR.

## Execution evidence

- TDD RED: the focused runtime test failed with module-not-found before `src/api-runtime.ts` existed.
- Pre-extraction baseline: the API-introspection and dispatcher suites passed 98/98 tests; extension typecheck passed.
- Focused parity: 6 API-runtime, 9 API-introspection, and 89 dispatcher tests pass (104 total).
- Extracted-module coverage: 100% statements, branches, functions, and lines (`LF=51`, `LH=51`, `BRF=25`, `BRH=25`).
- Public method contract: all 67 sorted bridge methods remain unchanged; method-list parity passes.
- Dispatcher source size: 4,878 lines on `main` → 4,760 lines after extraction (-118).
- Built dispatcher bundle: 151,841 bytes on `main` → 152,566 bytes (+725 bytes, approximately +0.48%).
- Packaged extension: 160,594 bytes on `main` → 160,951 bytes (+357 bytes, approximately +0.22%); the size budget passes.
- Full extension suite: 11 files / 159 tests pass.
- Full server suite: 150 files / 1,740 tests pass.
- Full `pnpm verify` passes Node.js/pnpm preflight, formatting, root and extension typecheck, ESLint, tool/profile metadata, server and extension tests, both builds, extension packaging/checksums, metadata alignment, generated compatibility validation, and VitePress documentation.
