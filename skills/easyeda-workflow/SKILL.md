---
name: easyeda-workflow
description: End-to-end EasyEDA Pro workflow guidance for setup, inspection, controlled writes, exports, and reporting through EasyEDA MCP Pro.
---

# EasyEDA Workflow Skill

Use this skill when an AI agent is asked to work with an EasyEDA Pro project through EasyEDA MCP Pro.

This skill is specific to `oaslananka/easyeda-mcp-pro` and must stay aligned with the registered MCP tools in `src/tools/` and the tool list in `README.md`.

## When to use

Use this skill for:

- EasyEDA MCP server setup and health checks
- Bridge extension connectivity checks
- Project inspection
- Schematic and PCB read-only review
- Controlled schematic or PCB write workflows
- BOM, DRC/ERC, board, export, and production review orchestration
- Producing a structured status report for a human engineer

Do not use this skill to bypass EasyEDA Pro, bridge-extension, tool-profile, or scope restrictions.

## Required context

Collect:

- Whether the server is running in `stdio` or `http` transport mode
- Active `TOOL_PROFILE`: `core`, `pro`, `full`, `dev`, or `experimental`
- EasyEDA Pro bridge status
- **Which document tab is focused in EasyEDA Pro** — schematic tools need the schematic tab active, PCB tools need the PCB tab active. A tool called against the wrong tab does not error, it silently returns empty/`not_available` data (e.g. `easyeda_pcb_components` returns `total:0` with no PCB open). If a read tool that should have data returns nothing, check tab focus before assuming the project is empty.
- Whether the task is read-only or write-enabled
- Project type: schematic, PCB, BOM, export, sourcing, or production review
- User approval for any write operation
- Output directory requirements for exports

## Primary MCP tools

### Diagnostics and capability discovery

- `easyeda_health_check`
- `easyeda_bridge_status`
- `easyeda_get_capabilities`
- `easyeda_get_server_config`
- `easyeda_get_tool_profiles`
- `easyeda_get_feature_flags`
- `easyeda_observability_report`
- `easyeda_run_self_test`
- `easyeda_api_inventory`

### Schematic read workflow

- `easyeda_schematic_nets`
- `easyeda_schematic_components`
- `easyeda_schematic_net_detail`
- `easyeda_schematic_sheet_info`
- `easyeda_schematic_component_pins`
- `easyeda_schematic_check_collisions` — sheet-wide pin-coordinate collision scan; see "Known write-safety caveats" below
- `easyeda_schematic_validate_netlist`
- `easyeda_schematic_verify_write`

### Controlled schematic write workflow

Use only after explicit permission and bridge capability confirmation.

- `easyeda_schematic_place_component`
- `easyeda_schematic_add_wire`
- `easyeda_schematic_add_text` — free-standing text label (section headers, notes); cosmetic only, not a net label
- `easyeda_schematic_add_rectangle` — grouping/divider box for organizing a busy schematic into labeled blocks; pair with add_text for the title
- `easyeda_schematic_add_circle` — decorative circle marker; cosmetic only
- `easyeda_schematic_add_polygon` — closed custom shape from 3+ vertices (callouts, block-diagram elements); cosmetic only
- `easyeda_schematic_set_title_block` — edit title block text fields (Company, Version, Drawn, Reviewed, Page Size) only. **Do not attempt to widen this tool to other title-block fields** (Symbol, Border, Device, Name, Description, Width/Height, Region\*, "@"-prefixed, ID): a past attempt to round-trip the full snapshot corrupted a real project's title block (EasyEDA Pro's own Log panel flagged "abnormal data" on the Symbol/Device property) — those fields are read-only through this native API, either silently ignored or throwing a native TypeError, and are only fixable via the EasyEDA Pro UI
- `easyeda_schematic_set_pin_no_connect` — set or clear EasyEDA's native intentional no-connect state on one exact component pin; this does not create a net or flag primitive
- `easyeda_schematic_create_net_flag`
- `easyeda_schematic_create_net_port`
- `easyeda_schematic_connect_pin_to_net`
- `easyeda_schematic_connect_pins_by_net`
- `easyeda_schematic_modify_primitive`
- `easyeda_schematic_delete_primitive`
- `easyeda_schematic_sync_to_pcb`
- `easyeda_project_save`

**Native No Connect is pin state, not a net primitive.** Use `easyeda_schematic_set_pin_no_connect` only for pins intentionally left open. Resolve the exact pin first with `easyeda_schematic_component_pins`; set `noConnected: true`, verify `no_connected: true`, and use `false` to clear it. Never emulate this with a drawn X, `create_net_flag`, or `createShortCircuitFlag`, and never apply it to a pin that already belongs to a net.

**Connectivity model:** wires/stubs sharing the same `netName` merge into one net regardless of physical location or distance — prefer `connect_pin_to_net`/named stubs over drawing a continuous route when the goal is just correct connectivity, not a hand-routed look. The collision guard (`NET_COLLISION`) only catches a foreign net at an _exact_ touched coordinate (a wire/pin/flag endpoint) — it does not catch a wire whose interior merely crosses a foreign point. EasyEDA also rejects diagonal (non-axis-aligned) wire segments outright; keep routing to horizontal/vertical only.

**`easyeda_schematic_sync_to_pcb` is not fire-and-forget.** It is the only way to get a schematic-placed part (`addIntoPcb: true`) onto the linked PCB — `easyeda_pcb_place_component`'s direct create is confirmed broken (see PCB write workflow note below) — but calling it only _opens a confirmation dialog in EasyEDA Pro's UI_; the tool call itself returns success immediately regardless of what happens next. A human must click through that dialog before the part actually appears on the board. Always verify with `easyeda_pcb_components` after asking the user to approve the dialog — never report a PCB sync as complete based on the tool's return value alone.

**Known write-safety caveats (read before any batch/multi-component build):**

- **A timeout is not proof of failure — never retry blind.** Bridge calls have a default 15s timeout. If a write call times out or errors, the EasyEDA-side operation may have completed anyway (the response just arrived too late to be matched to the request). `easyeda_schematic_place_component` now auto-reconciles this itself on a timeout-like error — it re-checks the sheet for a matching component before reporting failure, and returns `reconciled: true` (safe, do not retry) or `unconfirmed: true` (genuinely unknown) instead of a flat `success: false`. For every other write tool, the rule still applies manually: re-query real state — `easyeda_schematic_components` / `easyeda_schematic_nets` — and check whether the intended change is already there _before_ deciding whether to retry. Retrying without checking first is how duplicate components get created.
- **Moving a component now attempts to follow its wires, but this is unverified in practice — always re-check.** `easyeda_schematic_modify_primitive` on a component captures its pins' pre-move coordinates and tries to translate any wire endpoint that was touching one of them by the same delta (`followedWireIds`/`wireFollowFailures` in `result`). Live testing (2026-07-09) found `SCH_PrimitiveWire.getAll()` can miss wires created earlier in the same session — and confirmed the pre-existing `NET_COLLISION` guard has the identical blind spot, so this isn't a new-code defect, but it means an empty `followedWireIds` is **not** reliable proof nothing needed following. After moving any wired component, always independently confirm with `easyeda_schematic_nets` (or a canvas capture) — do not trust `followedWireIds`/`wireFollowFailures` alone. See [[easyeda_hotswap_getall_staleness]].
- **Coordinate collisions cause silent shorts, and the native collision guard has blind spots.** EasyEDA merges any two primitives that share an exact `(x,y)` — regardless of net name — the moment either one is wired. The `NET_COLLISION` guard on `connect_pin_to_net`/`add_wire` only sees pins that are _already_ part of a net (via a touching wire); a pin that has never been wired yet is invisible to it. It also (live-verified, see [[easyeda_hotswap_getall_staleness]]) can miss wires created earlier in the _same_ session, at least under the dev hot-swap workflow — root cause not yet confirmed as hot-swap-specific vs. general. `easyeda_workflow_place_block`/`power_rail`/`decouple_ic`/`connector_breakout` reconcile pin-vs-pin collisions automatically at apply time (nudging offenders, failing with `WORKFLOW_PIN_COLLISION` if unresolved), but inherit the same `getAll()`-based blind spot for wires. For any placement done _outside_ those workflow tools, call `easyeda_schematic_check_collisions` afterward — but treat a clean result as a strong signal, not absolute proof, and do a final visual/`schematic_nets` check on anything safety-critical.
- **Cache device pin dumps within a session.** A given `deviceUuid`'s pin layout is constant — look it up once per device type and reuse it, rather than re-requesting the full component/pin dump every time you reference that device again (it's a large, unchanging payload).
- **Don't request `canvas_capture`'s inline base64 unless you actually need to re-examine the image data.** The captured image is already rendered for the user; repeatedly capturing burns a large payload for no benefit — capture once, review it, then continue.
- **Net-naming ambiguity (e.g. `VIN` vs `VBUS`) must be resolved explicitly, not silently.** If a design brief calls for two net names that turn out to be the same physical rail in the actual topology, say so out loud in the report (state the simplification) rather than quietly picking one name and dropping the other.
- **Don't hand-size section boxes before every component in them is placed.** A rectangle drawn early is routinely too small once the real component cluster lands (the classic "BOOT0 box looks empty", "SPI FLASH box overlaps the decoupling caps" showcase-cosmetic failure). Use `easyeda_workflow_layout_section` after placing a section's components: it computes the box from their real pin extents and creates (or, given `replaceRectanglePrimitiveId`/`replaceTitlePrimitiveId`, replaces) the rectangle and title. It reports overlap with other rectangles and page-size overflow as warnings — it never tries to resize the page itself.

### PCB and board workflow

- `easyeda_board_layers`
- `easyeda_board_stackup`
- `easyeda_board_dimensions`
- `easyeda_board_features`
- `easyeda_pcb_constraint_check`
- `easyeda_pcb_constraint_report`
- `easyeda_pcb_production_review`

### Controlled PCB write workflow

Use only after explicit permission and bridge capability confirmation.

- `easyeda_pcb_place_component_group`
- `easyeda_pcb_route_path_plan`
- `easyeda_pcb_place_component` — **confirmed broken**: the native `PCB_PrimitiveComponent.create()` call this wraps never resolves. Do not use it to get a new part onto the board. The real path is schematic-side: place the part with `easyeda_schematic_place_component` (`addIntoPcb: true`, the default), then `easyeda_schematic_sync_to_pcb` (see schematic write workflow above for its human-in-the-loop caveat). Once the part exists on the PCB this way, `easyeda_pcb_modify_component` correctly repositions/rotates it.
- `easyeda_pcb_add_track`
- `easyeda_pcb_add_via`
- `easyeda_pcb_add_zone` — **confirmed broken**: the native `PCB_PrimitivePour.create()` call never resolves. No working alternative exists (unlike component placement, copper pours are not a schematic concept, so there is no sync-based workaround). Report this as an unsupported capability rather than attempting it.
- `easyeda_pcb_add_text` — silkscreen/label text on a PCB layer (typically Top/Bottom Silkscreen, layer id 3/4); fontFamily must be a name the runtime's font list contains — the default `NotoSansMonoCJKsc-Regular` is live-verified to work
- `easyeda_pcb_add_silkscreen_line` — non-electrical decorative line (section dividers, board art); reuses the same primitive as add_track but with an empty net name so it never appears in the netlist/ratsnest
- `easyeda_pcb_modify_component`
- `easyeda_pcb_delete_component`
- `easyeda_project_save`

### Diagnostics and regression (dev profile)

- `easyeda_live_write_regression` — exercises real schematic and/or PCB write paths (place/connect/wire/delete, via/track/list/delete) against the connected bridge in one call and reports pass/fail per step, self-cleaning afterward. Useful to sanity-check the bridge/extension itself before trusting a larger write workflow, or to reproduce a suspected regression. Requires `testDeviceItem` (resolve one via `easyeda_schematic_search_device` first) and the matching tab focused per scope.

### Export and visual workflow

- `easyeda_canvas_capture`
- `easyeda_canvas_capture_region`
- `easyeda_canvas_locate`
- `easyeda_export_gerbers`
- `easyeda_export_pick_place`
- `easyeda_export_pdf`
- `easyeda_export_netlist`
- `easyeda_production_qa_artifacts`
- `easyeda_jlcpcb_quote_workflow`

## Workflow

1. Start with `easyeda_health_check`, `easyeda_bridge_status`, and `easyeda_get_capabilities`.
2. Confirm the active tool profile and scope boundary with `easyeda_get_tool_profiles` and `easyeda_get_feature_flags`.
3. Determine whether the task is read-only, controlled write, export, sourcing, or validation.
4. For read-only review, inspect schematic, board, BOM, DRC/ERC, and export readiness with the relevant L1 tools.
5. For write workflows, state the exact intended mutations before tool use and require explicit approval.
6. Apply the smallest safe write set. Prefer semantic tools over `easyeda_api_call`.
7. Save only when appropriate with `easyeda_project_save`.
8. Validate after mutation with schematic netlist, DRC/ERC, board constraint, and production checks. Do this after _every_ batch write, not just at the end — see "Known write-safety caveats" above for why a write's own return value cannot be trusted alone.
9. Report verified tool output separately from assumptions and user-supplied requirements.

## Quality checks

A complete EasyEDA workflow response must include:

- Server and bridge health
- Active profile and scope assumptions
- Tools used
- Project observations
- Changes made or proposed
- Validation evidence
- Unsupported or unavailable capabilities
- Required human-review items

## Failure modes

Stop and report clearly when:

- EasyEDA Pro is not connected through the bridge
- The active tool profile does not expose the required tool
- Required write permission is missing
- A bridge API returns unsupported-method or unavailable-runtime errors
- A read tool returns an empty/`not_available` result where data was expected — check document tab focus before concluding the project is empty
- A project cannot be saved or exported
- `easyeda_pcb_place_component` or `easyeda_pcb_add_zone` is requested directly — redirect to the working alternative (or report no alternative, for zones) instead of attempting the broken call
- The user requests raw execution or unsafe full-control behavior without explicit enabled gates

## Output format

Return:

- Context
- Health/capability state
- Workflow performed
- Tool evidence
- Changes or proposed changes
- Validation result
- Blockers and next actions

## Safety rule

Do not claim an EasyEDA project is manufacturing-ready based only on write success. Manufacturing readiness requires validation, export review, and qualified human approval.
