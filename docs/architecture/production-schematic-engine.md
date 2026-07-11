# Production schematic engine

This document tracks the incremental production-schematic work. The first implemented layer is a
canonical read model that sits between EasyEDA runtime data and validation/planning code.

## Phase 1: canonical read model

`src/schematic-model` preserves raw runtime identities and metadata while exposing stable component
classification, canonical net names, BOM eligibility, electrical eligibility, and model diagnostics.
Only recognized imported power aliases are normalized; arbitrary user signal names remain unchanged.

The next phases will build on this model:

1. imported-design audit and reversible normalization;
2. snapshot-backed transactions and atomic batch writes;
3. no-connect/hidden/stacked-pin aware semantic ERC;
4. obstacle-aware orthogonal schematic routing;
5. functional-block layout and declarative plans.

## Imported-design audit

`easyeda_schematic_audit_imported_design` is the first read-only consumer of the canonical model. It reads live components and nets, preserves raw imported names, builds `schematic-model/v1`, and returns `imported-design-audit/v1` findings.

The audit currently detects:

- recognized imported power-net aliases and alias merges;
- duplicate or unstable component references;
- missing values and footprints;
- unresolved EasyEDA metadata expressions;
- imported primitives with ambiguous BOM classification;
- power-flag helper nets that must not be treated as user signals.

The audit never mutates EasyEDA. `normalization_preview` is advisory and will become the input to a later explicit, transaction-backed normalization operation. Source truncation is reported when the live component count exceeds the requested read limit.

## Deterministic normalization preview

`easyeda_schematic_preview_imported_normalization` converts a live canonical model into an
`imported-normalization-plan/v1` document without writing to EasyEDA. The plan includes a stable
`modelHash`, a deterministic `planId`, ordered operations, per-operation validation gates, blockers,
warnings, and expected postconditions.

Plan states are explicit:

- `noop`: the selected normalization policy would not change the design;
- `ready`: all operations are automatic and no blocker or confirmation requirement exists;
- `review`: the plan is complete but includes explicit overrides, alias convergence, or preserved
  runtime helpers that require human confirmation;
- `blocked`: the source is incomplete or a required reference, value, footprint, or BOM decision is
  unresolved.

Automatic operations are limited to recognized imported net aliases, deterministic reference
allocation, and metadata expressions that already resolve to concrete values. Arbitrary user net
names are never rewritten. Power-flag helper nets are preserved. Duplicate references, stale
overrides, incomplete source inventories, and missing metadata block application planning.

The preview is designed to become the immutable input to the later snapshot-backed transaction
engine. A future apply operation must re-read the model, compare `modelHash`, execute the listed
operations, and enforce every validation gate before commit.

## Snapshot-backed transactions

The transaction layer in `src/transactions` provides document-scoped begin, validate, commit, rollback, and status semantics. Only one unresolved transaction may hold a document lock. Transactions store bounded before/after snapshots internally, but MCP status output exposes only operation metadata and hashes.

The first transaction-aware write is `easyeda_schematic_modify_primitive`. With `transactionId` and matching `projectId`, it:

1. captures `schematic-primitive-snapshot/v1`;
2. applies the normal safe partial modify operation;
3. captures and hashes the after state;
4. automatically restores the before snapshot when the write or after-read fails;
5. records the operation for reverse-order rollback.

The extension exposes two controlled bridge methods for this workflow: `schematic.getPrimitiveSnapshot` and `schematic.restorePrimitiveSnapshot`. They support components, net flags/ports, wires, text, circles, and polygons. Restore is routed through the same safe modify logic, including wire-following when a component moves.

Transactions must pass validation before commit. Failed compensation, partial rollback, or expiration with unresolved writes retains the document lock until rollback succeeds. Rollback attempts every unresolved operation in reverse order and verifies the restored snapshot hash.

Public tools:

- `easyeda_project_begin_transaction`
- `easyeda_project_get_transaction_status`
- `easyeda_project_validate_transaction`
- `easyeda_project_commit_transaction`
- `easyeda_project_rollback_transaction`

This phase currently covers modify operations. Create/delete rollback descriptors and atomic batch writes are the next transaction increment.

## Atomic schematic batch writes

`easyeda_schematic_batch_write` applies up to 200 prevalidated create, modify, and delete operations through the snapshot-backed transaction manager. The tool supports dry-run planning, caller-owned transactions, and internally managed transactions that validate and commit automatically. Any operation failure rolls the entire transaction back in reverse order.

Create rollback deletes the newly created addressable primitive. Modify rollback restores the exact pre-write snapshot. Delete rollback recreates the primitive and verifies an identity-independent descriptor hash because EasyEDA assigns a new primitive UUID. Delete is currently restricted to wire, text, rectangle, circle, and polygon primitives whose complete creation descriptors are known. Component, net-flag, and net-port deletion is rejected before any write because their snapshots do not yet contain a complete, proven recreation descriptor.

The bridge now exposes controlled primitive support for transaction internals:

- `schematic.listPrimitiveIds` for create reconciliation;
- class-owned `schematic.deletePrimitive` routing;
- `schematic.recreatePrimitiveSnapshot` for supported drawing primitives;
- rectangle coverage in `schematic.getPrimitiveSnapshot`.

A create error is reconciled against before/after primitive ID inventories. No delta means no side effect; one new ID is automatically removed; multiple candidates leave the transaction locked as failed rather than claiming atomic rollback. Snapshot lookup failures are treated as absence only for explicit `PRIMITIVE_NOT_FOUND` errors—timeouts and connection failures remain validation failures.
