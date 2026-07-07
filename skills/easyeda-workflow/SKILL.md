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
- `easyeda_schematic_validate_netlist`
- `easyeda_schematic_verify_write`

### Controlled schematic write workflow

Use only after explicit permission and bridge capability confirmation.

- `easyeda_schematic_place_component`
- `easyeda_schematic_add_wire`
- `easyeda_schematic_create_net_flag`
- `easyeda_schematic_create_net_port`
- `easyeda_schematic_connect_pin_to_net`
- `easyeda_schematic_connect_pins_by_net`
- `easyeda_schematic_modify_primitive`
- `easyeda_schematic_delete_primitive`
- `easyeda_schematic_sync_to_pcb`
- `easyeda_project_save`

**Connectivity model:** wires/stubs sharing the same `netName` merge into one net regardless of physical location or distance — prefer `connect_pin_to_net`/named stubs over drawing a continuous route when the goal is just correct connectivity, not a hand-routed look. The collision guard (`NET_COLLISION`) only catches a foreign net at an *exact* touched coordinate (a wire/pin/flag endpoint) — it does not catch a wire whose interior merely crosses a foreign point. EasyEDA also rejects diagonal (non-axis-aligned) wire segments outright; keep routing to horizontal/vertical only.

**`easyeda_schematic_sync_to_pcb` is not fire-and-forget.** It is the only way to get a schematic-placed part (`addIntoPcb: true`) onto the linked PCB — `easyeda_pcb_place_component`'s direct create is confirmed broken (see PCB write workflow note below) — but calling it only *opens a confirmation dialog in EasyEDA Pro's UI*; the tool call itself returns success immediately regardless of what happens next. A human must click through that dialog before the part actually appears on the board. Always verify with `easyeda_pcb_components` after asking the user to approve the dialog — never report a PCB sync as complete based on the tool's return value alone.

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
8. Validate after mutation with schematic netlist, DRC/ERC, board constraint, and production checks.
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
