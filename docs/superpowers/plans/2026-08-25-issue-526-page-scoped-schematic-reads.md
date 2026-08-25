# Issue #526 Page-Scoped Schematic Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish draft #539 so page-scoped schematic reads are backward-compatible, fail closed, and behaviorally equivalent across the extension and CDP bridge paths without merging runtime changes into the RC.6 release line.

**Architecture:** Keep the existing server selector helpers, but move safety enforcement down into both bridge implementations as defense in depth. A small extension-side scope helper validates selectors and rejects unsupported scopes before native primitive reads; `schematic.getSheetInfo` resolves page metadata with DMT read-only APIs. The CDP manager mirrors the same capability matrix and never opens or activates a document.

**Tech Stack:** TypeScript, Zod, Vitest, EasyEDA Pro bridge extension, CDP bridge, Node.js 24.18.0, pnpm 11.5.1.

**Spec:** `docs/superpowers/specs/2026-08-22-issue-526-page-scoped-schematic-reads-design.md`

## Global Constraints

- Selector-less calls remain backward compatible; `easyeda_schematic_components` keeps its legacy all-pages inventory.
- Never call `openDocument`, `activateDocument`, or another focus-changing API for a scoped read.
- EasyEDA Pro 3.2.149 capability matrix: sheet metadata supports `focused/page/all_pages`; components supports explicit `focused/all_pages` but not page attribution; nets/wires/net-detail/netlist/ERC support only explicit `focused`.
- Unsupported scopes fail with structured `PAGE_*` errors before focused primitive enumeration.
- Extension and CDP bridge behavior must match.
- No dependency or public write-contract changes.
- #539 remains draft and is not merged into `main` during the RC.6 soak.

---

### Task 1: Lock the extension scope contract

**Files:**

- Create: `easyeda-bridge-extension/src/schematic-read-scope.ts`
- Modify: `easyeda-bridge-extension/src/read-only-operations.ts`
- Modify: `easyeda-bridge-extension/src/dispatcher-domain-router.ts`
- Test: `easyeda-bridge-extension/tests/read-only-operations.test.ts`
- Test: `easyeda-bridge-extension/tests/dispatcher-domain-router.test.ts`

**Interfaces:**

- Produces `resolveSchematicReadSelector(params)` returning `{ scope?: 'focused'|'page'|'all_pages'; pageUuid?: string }` with `pageUuid` implying `page`.
- Produces `assertSchematicReadScopeSupported(params, supported, operation, missingCapability)` that throws structured `PAGE_UUID_REQUIRED`, `PAGE_SCOPE_CONFLICT`, or `PAGE_SCOPE_UNSUPPORTED` errors.

- [ ] Add failing tests proving contradictory selectors fail and unsupported page/all-pages requests never invoke the underlying focused operation.
- [ ] Run only the new extension tests and verify RED for missing bridge enforcement.
- [ ] Implement the minimal shared selector/guard helper and route params through nets, net detail, components, validate-netlist, wires, and ERC routes.
- [ ] Run the focused extension tests and verify GREEN.

### Task 2: Resolve sheet metadata without focus mutation

**Files:**

- Modify: `easyeda-bridge-extension/src/schematic-inspection.ts`
- Modify: `easyeda-bridge-extension/src/read-only-operations.ts`
- Modify: `easyeda-bridge-extension/src/dispatcher-domain-router.ts`
- Test: `easyeda-bridge-extension/tests/schematic-inspection.test.ts`
- Test: `easyeda-bridge-extension/tests/dispatcher.test.ts`

**Interfaces:**

- `getSheetInfo(params?: Record<string, unknown>)` preserves the selector-less result.
- `pageUuid`/`scope:'page'` validates page-list membership, calls `DMT_Schematic.getSchematicPageInfo(pageUuid)` when available, and returns selected metadata while preserving actual focused-document identity.
- `scope:'all_pages'` returns page-list metadata and does not invent aggregate geometry.

- [ ] Add RED tests for non-focused page lookup, unknown page rejection, all-pages metadata, and unchanged focused UUID.
- [ ] Implement scoped metadata resolution using only DMT read APIs.
- [ ] Verify focused/legacy sheet tests and new scope tests GREEN.

### Task 3: Make component semantics explicit in the extension

**Files:**

- Modify: `easyeda-bridge-extension/src/read-only-operations.ts`
- Modify: `easyeda-bridge-extension/src/schematic-component-inspection.ts`
- Test: `easyeda-bridge-extension/tests/read-only-operations.test.ts`
- Test: `easyeda-bridge-extension/tests/schematic-component-inspection.test.ts`

**Interfaces:**

- Selector omitted => `getAll(undefined, true)` (legacy).
- `scope:'focused'` => `getAll(undefined, false)`.
- `scope:'all_pages'` => `getAll(undefined, true)`.
- `scope:'page'` => `PAGE_SCOPE_UNSUPPORTED` before `getAll`.

- [ ] Add/adjust RED tests for all four cases and verify the unsupported page case does not touch the native class.
- [ ] Implement minimal parameter mapping without changing component normalization/pagination.
- [ ] Run component-focused tests GREEN.

### Task 4: Enforce the same matrix in CDP

**Files:**

- Modify: `src/bridge/cdp-manager.ts`
- Test: `tests/unit/bridge/cdp-manager.test.ts`
- Test: `tests/unit/bridge/cdp-manager-components.test.ts`

**Interfaces:**

- CDP dispatch rejects unsupported schematic scopes before generating/evaluating focused primitive expressions.
- `componentListExpression` preserves legacy all-pages and supports explicit focused/all-pages.
- `sheetInfoExpression(params)` performs read-only page selection without focus-changing strings.

- [ ] Add RED tests for unsupported nets/wires/ERC/page-component requests and ensure Runtime.evaluate is not called.
- [ ] Add RED tests for page sheet-info expression and focus-safety string assertions.
- [ ] Implement minimal CDP selector guard and scoped sheet/component expressions.
- [ ] Run CDP-focused tests GREEN.

### Task 5: Forward supported selectors through the MCP server

**Files:**

- Modify: `src/tools/L1_schematic_read.ts`
- Modify: `src/tools/L1_drc_erc.ts`
- Modify: `src/tools/schematic-read-scope.ts`
- Modify: `src/tools/schematic-sheet-info.ts`
- Test: `tests/unit/tools/schematic.test.ts`
- Test: `tests/unit/tools/drc-erc.test.ts`

**Interfaces:**

- Server keeps schema validation and structured error mapping.
- Supported selector metadata is forwarded to the bridge so bridge-level validation is exercised, while unsupported requests continue to fail before any bridge call.
- Scoped sheet formatting prefers bridge-selected page metadata but remains compatible with legacy bridge shapes.

- [ ] Add RED tests asserting bridge payloads include supported selector intent and selected page metadata wins over a less-complete page-list entry.
- [ ] Implement minimal forwarding/mapping changes.
- [ ] Run server-focused tests GREEN and verify selector-less payloads/results remain unchanged.

### Task 6: Documentation, generated reference, and verification

**Files:**

- Modify: `docs/superpowers/specs/2026-08-22-issue-526-page-scoped-schematic-reads-design.md`
- Modify/generated: `docs/reference/tools.md`
- Modify only if the existing ratchet requires it: `config/complexity-baseline.json`

- [ ] Regenerate tool reference with the repository's existing generator; do not hand-edit generated sections.
- [ ] Run Prettier, typecheck, lint, focused server/extension tests, repository policy checks, and `git diff --check`.
- [ ] Run full `pnpm verify` under exact Node 24.18.0 / pnpm 11.5.1 with isolated npm cache.
- [ ] Run extension build/dist verification and package verification not already included by `verify`.
- [ ] If an isolated EasyEDA Pro 3.2.149 live profile is available, run the multi-page focus-safety probe against the exact implementation head and record evidence; otherwise keep #526 open and explicitly mark live closure as unverified.
- [ ] Review the complete diff for secrets, generated/temp files, compatibility regressions, complexity ratchet increases, and unrelated refactors.
- [ ] Push #539 branch, keep PR draft, inspect all CI/provider checks and bot/review comments, and fix valid findings without weakening gates.
