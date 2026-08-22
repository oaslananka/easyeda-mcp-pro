# Issue #526 Page-Scoped Schematic Reads Design

## Context

Issue #526 asks schematic read tools to inspect a selected schematic page without changing the user's active EasyEDA Pro tab. Today the public read tools are effectively focused-document reads. An agent that needs another page must call `DMT_EditorControl.openDocument`/activation APIs, which moves the user's view and introduces focus, stale-canvas, and concurrency risks.

EasyEDA Pro 3.2.149 exposes two different API families that matter here:

- `DMT_Schematic` exposes page metadata and identity APIs, including `getAllSchematicPagesInfo`, `getCurrentSchematicAllSchematicPagesInfo`, `getCurrentSchematicPageInfo`, and `getSchematicPageInfo(pageUuid)`.
- `SCH_*` primitive/read APIs are bound to the current schematic editor context. The captured 3.2.149 runtime inventory exposes no documented `pageUuid` argument or per-page primitive namespace for `SCH_PrimitiveComponent`, `SCH_PrimitiveWire`, `SCH_Drc`, or the other primitive classes used by the MCP read tools.
- `SCH_Net.getCurrentProjectAllNets` exists and may provide a safe project-wide connectivity primitive, but its exact result shape and cross-page semantics must be characterized live before the public MCP contract claims `all_pages` support.

The design therefore must not equate “a page can be described by `DMT_Schematic`” with “all primitives on that page can be read without activating it.”

## Goals

- Preserve every existing focused-page read call unchanged when no selector is supplied.
- Allow agents to identify and request a schematic page by `pageUuid` without changing EasyEDA focus.
- Support non-focused page reads only where EasyEDA exposes a documented/read-only native path whose semantics are verified live.
- Expose project-wide/all-pages connectivity only where the runtime proves that the data really spans pages.
- Make unsupported scope explicit and machine-readable instead of silently switching tabs or returning focused-page data under a requested page identity.
- Preserve read consistency, timeout, error-code, redaction, and agent-safety behavior already present in the tools.
- Keep the RC.6 release candidate immutable during its seven-day soak. The feature may be developed and reviewed on its own branch, but its runtime implementation must not merge into `main` until the v1.0.0 stable promotion completes unless the project intentionally accepts an RC.7 reset.

## Non-goals

- Do not call `DMT_EditorControl.openDocument`, `activateDocument`, or equivalent focus-changing APIs as an implementation detail of a read tool.
- Do not mutate IndexedDB, renderer internals, private EasyEDA state, or undocumented page-context globals to force `SCH_*` classes onto another page.
- Do not claim that `SCH_PrimitiveComponent.getAll(..., true)` is an all-pages query without live proof; the existing bridge already uses that call while #526 reports focused-page behavior.
- Do not synthesize a complete all-pages ERC result by combining incomplete focused-page checks.
- Do not merge unrelated read-model or routing refactors into the feature PR.
- Do not change write-tool page/focus semantics in this issue.

## Approaches Considered

### 1. Capability-aware native read scope — recommended

Introduce one internal read-scope resolver and let each operation declare the scopes it can actually satisfy. The resolver validates page identity through `DMT_Schematic`; the operation then uses only documented native read APIs. If the requested scope cannot be satisfied without focus mutation, the bridge returns `PAGE_SCOPE_UNSUPPORTED`.

Advantages:

- preserves the user's UI and existing focused behavior;
- never labels focused data as another page's data;
- can grow incrementally when later EasyEDA runtimes expose better page-scoped APIs;
- keeps unsupported capability explicit for agents.

Trade-off: the first implementation may support only a subset of the requested tool/scope combinations.

### 2. Activate target document, read, then restore focus — rejected

This could reuse the current `SCH_*` code but violates the core requirement. It moves the user's view, is observable, can race with user activity, and cannot guarantee restoration after renderer/API failures. It also turns nominally read-only MCP calls into UI mutations.

### 3. Private renderer/page-context injection — rejected

Reverse-engineering undocumented globals could potentially redirect `SCH_*` calls without visible focus changes. The approach is brittle across EasyEDA releases, difficult to test safely, and incompatible with the project's runtime-compatibility and fail-closed policies.

## Public selector contract

The existing tool inputs remain valid. A common selector shape is added only to schematic read tools participating in this feature:

```ts
{
  pageUuid?: string;
  scope?: 'focused' | 'page' | 'all_pages';
}
```

Resolution rules:

1. Neither field supplied: behave exactly as today; resolved scope is `focused`.
2. `pageUuid` supplied with no `scope`: treat as `scope: 'page'`.
3. `scope: 'page'` requires a non-empty `pageUuid`.
4. `scope: 'focused'` rejects `pageUuid`; callers must not provide contradictory intent.
5. `scope: 'all_pages'` rejects `pageUuid`.
6. Unknown or empty `pageUuid` values fail before a primitive read.

The server should use a shared Zod selector schema so every participating tool validates the same combinations.

## Scope metadata in outputs

Successful scoped reads add an optional, backward-compatible envelope field:

```ts
read_scope?: {
  requested: 'focused' | 'page' | 'all_pages';
  resolved: 'focused' | 'page' | 'all_pages';
  page_uuid?: string;
  focused_page_uuid?: string;
  focus_changed: false;
  source: string;
}
```

The existing result fields remain unchanged. `focus_changed` is always `false` for this feature; a read that would require focus mutation fails instead.

For errors, existing tool-specific output shapes continue to be used, with bridge `code`/`data` preserved where the tool already exposes them. Tools touched by this feature must not flatten `PAGE_*` bridge errors to an unstructured string.

## Bridge read-scope resolver

Add a small read-only resolver in the bridge extension, separate from the primitive implementations. Conceptually:

```ts
resolveSchematicReadScope({ pageUuid, scope }) -> {
  requestedScope,
  pageUuid?,
  focusedPageUuid?,
  page?,
  pages,
  focusChanged: false
}
```

The resolver uses only `DMT_Schematic`/`DMT_SelectControl` metadata calls:

- page list: `getCurrentSchematicAllSchematicPagesInfo`, then `getAllSchematicPagesInfo` as fallback;
- focused document identity: `DMT_SelectControl.getCurrentDocumentInfo`;
- requested page metadata: `DMT_Schematic.getSchematicPageInfo(pageUuid)` after validating membership in the current schematic/project page set.

The resolver must not call an editor activation/open API.

Errors:

- `PAGE_UUID_REQUIRED`: `scope: 'page'` without a UUID.
- `PAGE_SCOPE_CONFLICT`: contradictory selector fields.
- `PAGE_NOT_FOUND`: requested UUID is not in the current schematic/project page set or cannot be resolved.
- `PAGE_SCOPE_UNSUPPORTED`: the requested tool cannot satisfy the resolved scope using verified read-only native APIs.
- `PAGE_SCOPE_UNAVAILABLE`: page-list/focused identity metadata is unavailable, so the requested scope cannot be proven safely.

Diagnostic `data` should identify the requested scope, page UUID when present, focused page UUID when known, tool/operation, and the native capability that is missing. It must not include private document contents.

## Initial tool capability matrix

The final implementation matrix is gated by live characterization. No row may be promoted from `probe required` to supported based only on method names.

| Tool                                 | `focused` | `page`                                                          | `all_pages`                                                         | Initial design                                                                                                                                                                                               |
| ------------------------------------ | --------- | --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `easyeda_schematic_sheet_info`       | supported | supported                                                       | supported as page-list metadata, not merged geometry                | `DMT_Schematic` already exposes safe page metadata APIs. `page` returns the selected page metadata. `all_pages` returns the known page list with per-page metadata and no invented aggregate sheet geometry. |
| `easyeda_schematic_components`       | supported | probe required                                                  | probe required                                                      | Current `SCH_PrimitiveComponent.getAll(undefined, true)` is context-bound according to issue behavior. Do not enable another scope until live tests prove a documented native path and page attribution.     |
| `easyeda_schematic_wires`            | supported | unsupported on 3.2.149 unless probe discovers a documented path | unsupported on 3.2.149 unless probe discovers a documented path     | `SCH_PrimitiveWire.getAll` has no page selector in the captured runtime surface.                                                                                                                             |
| `easyeda_schematic_nets`             | supported | unsupported unless a page-attributed native result is proven    | probe `SCH_Net.getCurrentProjectAllNets`                            | Project-wide support is plausible but must prove cross-page coverage, stable net identity, and node/page attribution before exposure.                                                                        |
| `easyeda_schematic_net_detail`       | supported | unsupported unless page-attributed native data is proven        | probe only if project-wide net data contains sufficient node detail | Never filter a focused result and call it page-scoped.                                                                                                                                                       |
| `easyeda_schematic_validate_netlist` | supported | unsupported initially                                           | unsupported until all required inputs are project-wide              | Validation needs nets, component/pin enumeration, floating-pin inference, wire checks, and native ERC. Partial data must not be reported as a complete validation.                                           |
| `easyeda_erc_run`                    | supported | unsupported on 3.2.149                                          | unsupported on 3.2.149                                              | `SCH_Drc.check` is current-context native ERC. Do not activate a page behind the user's back.                                                                                                                |

If live characterization proves a safe documented path for a currently unsupported cell, update this matrix, tests, and the design/issue evidence before implementation of that cell.

## `sheet_info` behavior

`easyeda_schematic_sheet_info` is the first fully page-selectable read because it already relies on `DMT_Schematic` metadata rather than `SCH_*` primitives.

Focused behavior remains unchanged.

For `scope: 'page'`/`pageUuid`, the bridge returns that page as `currentPage`/selected page and includes the complete page list plus focused document metadata for diagnostics. The server output reports the selected page's geometry only when the native page record actually contains it; it must retain today's `geometry_available` semantics and never infer dimensions.

For `scope: 'all_pages'`, the server returns page-list metadata in a dedicated additive field such as `pages`; singular `sheet`/geometry fields remain unset unless there is an unambiguous documented meaning. This prevents fake “combined sheet” geometry.

## Primitive-read behavior

Every primitive operation receives the resolved scope before calling `SCH_*` APIs.

- `focused`: call the existing implementation unchanged.
- `page`: call a verified page-aware native implementation if one exists; otherwise throw `PAGE_SCOPE_UNSUPPORTED` before calling a focused primitive class.
- `all_pages`: call a verified project/all-page native implementation if one exists; otherwise throw `PAGE_SCOPE_UNSUPPORTED`.

No implementation may perform a focused call first and later reject it; unsupported scope should fail before expensive primitive enumeration when possible.

## All-pages net semantics

`SCH_Net.getCurrentProjectAllNets` is a candidate for `schematic_nets(scope: 'all_pages')`, not an assumed implementation.

The live probe must establish:

- that the method returns nets from at least two pages while one page remains focused;
- whether returned nodes include designator/pin identity sufficient for the existing public net shape;
- whether identical named nets on two pages are intentionally one project net or separate page-local nets;
- whether net flags/net ports and unnamed nets have stable semantics across pages;
- whether stale/zero-node catalog behavior from #528 reappears in the project-wide API;
- whether the call changes focus or document state (it must not).

If page attribution is absent, `all_pages` may still be exposed only if the semantics are genuinely project-wide and the output does not pretend to identify a source page. If those conditions are not met, the scope remains unsupported.

## Netlist validation and ERC

`easyeda_schematic_validate_netlist(scope: 'all_pages')` must not be implemented merely by swapping in project-wide nets. Today validation also depends on focused-context component/pin enumeration, floating-pin inference, optional wire checks, and `SCH_Drc.check`.

All-pages validation is enabled only when every required component has a verified project/all-page data source or the output contract is explicitly redesigned to represent partial validation. This issue's initial implementation should prefer `PAGE_SCOPE_UNSUPPORTED` over a misleading `valid: true` based on incomplete evidence.

`easyeda_erc_run` stays focused-only on EasyEDA 3.2.149 unless a documented non-focused ERC API is discovered and validated.

## Server and bridge architecture

Expected implementation boundaries:

- `src/tools/L1_schematic_read.ts`: shared selector schema, additive output `read_scope`, and selector forwarding for schematic read tools.
- `src/tools/L1_drc_erc.ts`: selector validation/forwarding for `easyeda_erc_run`, including structured unsupported-scope handling.
- `easyeda-bridge-extension/src/schematic-inspection.ts` or a small adjacent module: shared read-scope/page resolver built on `DMT_Schematic` metadata.
- `easyeda-bridge-extension/src/read-only-operations.ts`: accepts scope and routes only to operations that declare support.
- `easyeda-bridge-extension/src/dispatcher.ts` and/or narrowly scoped inspection modules: native implementation for any live-proven all-pages/page-aware primitive read.
- `src/bridge/cdp-manager.ts`: parity implementation for the CDP bridge path; it must enforce the same selector and fail-closed capability rules.
- generated tool reference docs are regenerated through the existing generator rather than hand-edited.

Do not create a new generic service layer if the existing inspection/read-only modules can own the behavior cleanly.

## Backward compatibility

- Existing calls without `pageUuid`/`scope` must produce the same data shapes and focused semantics, except for additive optional `read_scope` metadata if enabled for default calls.
- Existing tool names and required parameters do not change.
- `projectId` remains accepted exactly as today; #526 does not redefine its identity semantics.
- No read tool gains `confirmWrite` or triggers a write confirmation.
- Unsupported new selector combinations fail only when the caller opts into the new selector.
- Tool semantic versions are bumped only where repository policy requires a public input/output contract version increment.

## Concurrency and focus safety

The live tests capture focused document/page identity immediately before and after every non-focused/projection probe. Any difference fails the test.

The bridge does not attempt a focus “restore” because it never changes focus. This avoids a race where the user changes tabs during an MCP read and the bridge restores the wrong tab afterward.

Read consistency should continue using the existing stable-read mechanism where applicable. Scope metadata is part of the observation: a stable result cannot be reported if the focused document/page identity changes between repeated reads.

## Live characterization plan

Use only the already isolated EasyEDA profile or another disposable isolated profile; never the user's normal profile.

Create or reuse a disposable schematic with at least two pages containing deliberately distinguishable fixtures, for example:

- Page A: component/reference and named net unique to A.
- Page B: different component/reference and named net unique to B.
- One deliberately shared named net/net-port pattern if needed to characterize project-wide merging.

For each probe:

1. record `DMT_SelectControl.getCurrentDocumentInfo` and current page UUID;
2. call the candidate read API without opening/activating another page;
3. record the same focus identity afterward;
4. assert identity is unchanged;
5. compare results against known page fixtures;
6. clean up any disposable fixture state through the normal EasyEDA APIs if the probe required setup.

Minimum probes:

- `DMT_Schematic.getSchematicPageInfo(pageUuid)` for a non-focused page;
- `SCH_PrimitiveComponent.getAll(undefined, true)` while alternating the focused page only during fixture characterization, to determine whether it is actually page-bound;
- `SCH_PrimitiveWire.getAll()` under the same characterization;
- `SCH_Net.getCurrentProjectAllNets()` with distinct nets on two pages;
- `SCH_Drc.check()` only to confirm it is context-bound; do not use it as an all-pages implementation unless results prove otherwise.

The characterization itself may temporarily switch pages under explicit test-harness control while establishing semantics, but the final MCP read implementation must not switch focus. The test must restore the isolated fixture and verify final focus/state.

## Testing

### Server unit tests

- selector schema accepts all legacy calls unchanged;
- `pageUuid` implies `scope: 'page'`;
- contradictory/missing selector inputs fail deterministically;
- selector fields are forwarded to the bridge;
- `PAGE_*` code/data survives server error handling;
- additive `read_scope` fields are mapped without changing existing result data;
- all-pages `sheet_info` does not invent aggregate geometry.

### Bridge extension tests

- resolver matches a requested page from the page list and calls `getSchematicPageInfo(pageUuid)`;
- missing/unknown pages fail before primitive calls;
- unsupported page/all-pages scopes do not call focused `SCH_*` APIs;
- focused/default path continues to call existing implementations;
- all-pages nets tests are added only after live result semantics are captured in fixtures;
- no resolver code calls editor activation/open methods.

### CDP parity tests

- same selector-resolution and structured-error behavior as extension bridge;
- no generated expression contains `openDocument`, `activateDocument`, or another focus-changing fallback for scoped reads.

### Repository gates

- focused server/extension tests first under TDD;
- format, typecheck, lint, complexity ratchet, tool metadata/docs generation;
- full `pnpm verify` on Node 24.18.0 / pnpm 11.5.1;
- extension size budget;
- PR Codecov patch gate, Sonar, CodeQL, Semgrep, Trivy/container security, Socket/dependency checks, and Linux/macOS/Windows matrix.

### Live gate

A live multi-page test is mandatory before marking #526 implemented. The evidence must include EasyEDA/runtime versions, exact candidate SHA, requested/resolved scope, before/after focus UUID, fixture result summary, and redaction checks.

## Release strategy

RC.6 is already published to prerelease/`next` channels and its seven-day soak started from the successful published-release verifier. Runtime changes merged into `main` during that soak would invalidate RC.6 and require a new RC with fresh live evidence and a new soak.

Therefore:

1. develop #526 on `feature/526-page-scoped-reads` from the RC.6 main baseline;
2. keep the implementation PR draft/non-mergeable for stable release while RC.6 soaks;
3. run normal CI/security review on every pushed implementation head;
4. after v1.0.0 stable promotion, rebase/update the feature branch onto the then-current `main`, rerun full and live verification, and merge only if all gates remain green.

If the project intentionally decides to merge #526 before stable, that is a release-policy decision: RC.6 is superseded and an RC.7 + fresh compatibility evidence + fresh seven-day soak is required.

## Acceptance criteria

- Existing focused calls remain backward compatible.
- No scoped read changes EasyEDA focus.
- `sheet_info(pageUuid)` can return verified metadata for a non-focused page.
- Every requested scope either returns data from a proven native scope or fails with a structured `PAGE_SCOPE_UNSUPPORTED`/related error; no silent focused fallback exists.
- Any `all_pages` support has live evidence proving cross-page semantics.
- Netlist/ERC outputs never claim completeness from partial page data.
- Extension and CDP bridges have parity for supported/unsupported scope behavior.
- Full CI/security/live gates pass on the final implementation head.
- The feature does not invalidate RC.6 by merging during its soak unless the release is intentionally reset to RC.7.
