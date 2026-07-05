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
- `easyeda_project_save`

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
- `easyeda_pcb_place_component`
- `easyeda_pcb_add_track`
- `easyeda_pcb_add_via`
- `easyeda_pcb_add_zone`
- `easyeda_pcb_modify_component`
- `easyeda_pcb_delete_component`
- `easyeda_project_save`

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
- A project cannot be saved or exported
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
