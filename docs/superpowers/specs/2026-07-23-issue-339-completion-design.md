# Issue #339 Completion Design

## Goal

Complete the remaining dispatcher decomposition work tracked by GitHub issue #339 by extracting the design rule-check and schematic transaction boundaries into typed domain modules, preserving all public bridge behavior, and closing the issue only after post-merge acceptance evidence is complete.

## Starting Point

- Repository: `oaslananka/easyeda-mcp-pro`
- Canonical base: GitHub `main` at `18c5217083da7f8a705d8dc246e82fc9ed734caf`
- Public extension method list: exactly 67 methods, unchanged throughout this work
- Dispatcher size at the base commit: 3,749 lines
- Runtime: Node.js 24.18.0 and pnpm 11.5.1
- Work location: isolated branch and worktree; the existing MSI checkout and its uncommitted `.mcp.json` deletion remain untouched

The work is delivered as two sequential pull requests. The first pull request references #339 without closing it. The second pull request closes #339 only after all acceptance criteria in this document pass.

## Scope

### Pull Request 1: Design Rule-Check Boundary

Create `easyeda-bridge-extension/src/design-rule-check-operations.ts` and move the dispatcher-owned implementation of these public methods behind a typed factory:

- `design.drc`
- `design.erc`
- `design.ruleCheck`

The extracted module owns:

- DRC/ERC severity normalization
- leaf violation normalization
- aggregate count normalization
- recursive flattening of nested EasyEDA UI result trees
- normalized summary counts and pass/fail calculation
- PCB-only DRC context error translation
- generic active-canvas fallback from PCB DRC to schematic ERC/DRC
- stable `CONTEXT_UNAVAILABLE` errors with existing messages, suggestions, and cause data
- `design.erc` orchestration for best-effort inferred floating-pin detail

The extracted module does not own schematic net inference or floating-pin discovery. The dispatcher injects the existing `findFloatingPinsApi` behavior as a typed dependency so this pull request changes ownership, not connectivity semantics.

### Pull Request 2: Schematic Transaction Boundary

Create `easyeda-bridge-extension/src/schematic-transaction-operations.ts` and move these public methods behind a typed factory:

- `schematic.getPrimitiveSnapshot`
- `schematic.listPrimitiveIds`
- `schematic.deletePrimitive`
- `schematic.recreatePrimitiveSnapshot`
- `schematic.restorePrimitiveSnapshot`
- `schematic.modifyPrimitive`

The extracted module owns the `schematic-primitive-snapshot/v1` contract and transaction-safe behavior for:

- component
- net flag
- net port
- wire
- text
- rectangle
- circle
- polygon

It also owns the supporting transaction behavior currently embedded in `dispatcher.ts`, including primitive class resolution, snapshot parsing and validation, scalar-safe primitive IDs, ownership-aware deletion, recreation confirmation, partial-update state merging, text alignment safety, and connected-wire following after component movement.

## Required Behavioral Parity

### Rule-Check Behavior

The rule-check module must preserve all observed native result shapes:

- detailed leaf objects
- flat aggregate objects such as `{ type, count }`
- nested UI trees such as `{ name, count, list: [...] }`

Severity mapping remains:

- values containing `fatal` or `error` become `error`
- values containing `warn` become `warning`
- all other values become `info`

`passed` remains true when and only when `errorCount` is zero. Aggregate counts contribute their full count to `totalViolations`, `errorCount`, and `warningCount`; the public `violations` array contains one explanatory aggregate entry per non-zero aggregate group.

`design.drc` remains PCB-only. A missing or unfocused PCB context becomes `CONTEXT_UNAVAILABLE` with the existing actionable suggestion.

`design.ruleCheck` continues to attempt PCB first, then schematic. It returns the first successful native check and emits a single stable `CONTEXT_UNAVAILABLE` error only when neither canvas is available, including both causes in error data.

`design.erc` continues to run native schematic DRC/ERC and then best-effort floating-pin inference. Inference failure must not fail the native ERC result. `detailSource` remains `inferred_partial` when inferred pins exist and `native_aggregate_only` otherwise.

### Transaction Behavior

The snapshot schema version remains exactly `schematic-primitive-snapshot/v1`. Existing error codes, messages, suggestions, and error data are preserved unless a test demonstrates an unsafe or ambiguous contract that must be made stricter.

Primitive IDs must remain scalar-safe. Object values must never become `[object Object]` identifiers.

Text behavior must preserve the public `ESCH_PrimitiveTextAlignMode` range of 1 through 9. Internal `getAll()` encodings must never be written back to public create or modify APIs. The dispatcher-instance cache remains short-lived and is cleared when a dispatcher is created.

Snapshot recreation remains supported only for wire, text, rectangle, circle, and polygon. Component, net flag, and net port recreation remains rejected because the current snapshot does not contain a complete creation descriptor.

Text and rectangle recreation must preserve the current Y-axis conversion. The extraction must not “simplify” or remove the sign inversion already validated against the live runtime.

Partial modification must continue to snapshot and merge all native fields because EasyEDA resets omitted fields. Component `otherProperty` remains deep-merged at its first level. Text aliases remain normalized from `color` to `textColor` and `underline` to `underLine`.

Moving a component continues to capture its original pin coordinates before modification and move matching wire points by the same delta afterward. The result continues to report `followedWireIds` and `wireFollowFailures`; wire-follow failures remain recoverable and do not roll back the component modification.

Deletion remains ownership-aware: the implementation must identify the owning primitive class before invoking its delete operation. Missing IDs remain reported in `notFound`, and the response `success` remains false when any requested ID was not found.

When native create results do not expose an ID, recreation continues to compare the before/after inventory. Exactly one new ID confirms creation; zero or multiple candidates produce `CREATE_UNCONFIRMED`.

## Architecture

Both new modules use factory functions matching the established extracted-domain pattern in the repository. Dependencies are injected as narrow typed callbacks rather than importing dispatcher globals.

The dispatcher remains responsible for:

- constructing the shared EasyEDA API runtime
- constructing extracted domain modules
- routing public method names to domain methods
- owning cross-domain callbacks that are not part of the extracted boundary
- clearing dispatcher-instance caches during initialization

The rule-check module receives callbacks for native API calls, bridge-error creation, recoverable logging, error-message normalization, and floating-pin discovery.

The transaction module receives callbacks for API path resolution, native calls, bridge-error creation, recoverable logging, primitive state reads, primitive ID extraction, and the connected-wire helper dependencies required to preserve current behavior. Helpers should move with the domain when they have no remaining non-transaction consumers. Helpers shared with non-transaction schematic operations remain in the dispatcher and are injected.

No new public bridge method is introduced. No server schema or MCP tool name changes are required.

## Testing Strategy

Implementation follows test-driven development.

### Rule-Check Tests

Add `easyeda-bridge-extension/tests/design-rule-check-operations.test.ts` covering:

- detailed leaf normalization
- nested UI tree flattening
- flat aggregate normalization
- count and pass/fail calculation
- PCB DRC success
- PCB context translation
- PCB-first generic rule check
- schematic fallback
- both-contexts-unavailable error data
- ERC inferred floating pins
- ERC inference failure containment

Update dispatcher parity tests to prove all three public methods delegate through the new module and the public method list remains byte-for-byte unchanged.

### Transaction Tests

Add `easyeda-bridge-extension/tests/schematic-transaction-operations.test.ts` covering every supported primitive kind and the critical safety branches:

- snapshot validation and expected-kind mismatch
- text public align mode and cache fallback
- object-valued ID rejection
- class ownership during deletion
- unsupported component-like recreation
- create-result ID extraction
- inventory-diff ID recovery
- ambiguous/unconfirmed recreation
- text and rectangle Y conversion
- partial component, wire, text, circle, and polygon modifications
- net flag and net port low-level state mutation
- connected-wire movement and recoverable failures
- primitive-not-found and unsupported-runtime errors

Update dispatcher parity tests for all six delegated transaction methods and verify the method list remains exactly 67 entries.

New extracted modules must reach 100% statement, branch, function, and line coverage. Existing test coverage must not be reduced.

## Verification Gates

Each pull request must pass locally at its exact head with Node.js 24.18.0 and pnpm 11.5.1:

- focused red/green tests for the new module
- complete extension test suite
- complete server test suite
- `pnpm verify`
- extension build and distribution verification
- extension package and bundle size budgets
- dependency audit policy, including only the documented temporary Hono exception tracked by #334
- peer dependency validation
- public method-list parity

Remote required checks must pass before merge:

- CI on Ubuntu, macOS, and Windows
- Codecov patch checks with all changed coverable lines tested
- Sonar with zero new issues, zero accepted issues, and zero security hotspots
- CodeQL
- Semgrep OSS and Cloud
- Socket
- Trivy
- DeepScan
- dependency review
- container and workflow security checks

All bot, agent, review, and inline suggestion threads must be resolved or explicitly documented before merge.

## Delivery and Issue Closure

Pull Request 1 uses `Refs #339` and leaves the issue open.

Pull Request 2 may use `Closes #339` only when:

- both extracted boundaries are merged or included in the final pull request
- all required local and remote checks pass
- public method count remains 67
- dispatcher behavior parity is demonstrated by tests
- no unresolved bot, agent, or reviewer feedback remains
- final dispatcher line-count and coverage evidence are recorded

After the final merge, verify the post-merge `main` workflow set, including CI, static security, Scorecard, Release Please, and benchmark jobs. Add a final issue comment summarizing both pull requests, merge commits, dispatcher reduction, test totals, coverage, quality/security results, and acceptance-criteria completion. Close #339 only after that evidence is public.

## Explicit Non-Goals

- changing public MCP tool names or schemas
- changing native DRC/ERC semantics
- rewriting schematic connectivity or floating-pin inference
- adding component/net flag/net port delete recreation
- changing title-block, synchronization, BOM, PCB, export, canvas, or API-runtime domains
- unrelated cleanup in the dispatcher
- modifying the user’s existing MSI checkout or `.mcp.json` deletion
