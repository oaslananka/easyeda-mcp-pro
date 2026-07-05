---
name: design-validation
description: EasyEDA DRC/ERC, semantic ERC, power-tree, PCB constraints, production QA, export, and release-validation workflow through EasyEDA MCP Pro.
---

# Design Validation Skill

Use this skill when an AI agent is asked to validate an EasyEDA Pro schematic, PCB, BOM, export, or production handoff through EasyEDA MCP Pro.

This skill is specific to `oaslananka/easyeda-mcp-pro` and must stay aligned with the registered MCP tools in `src/tools/` and the tool list in `README.md`.

## When to use

Use this skill for:

- ERC review
- DRC review
- Semantic ERC and netlist checks
- PCB constraint review
- Power-tree analysis
- BOM and sourcing validation
- Production QA and export readiness review
- Manufacturing handoff risk reporting

Do not use this skill to approve a project for fabrication or assembly without qualified human review.

## Required context

Collect:

- Active EasyEDA project and bridge status
- Validation target: schematic, PCB, BOM, export, quote, or production package
- Manufacturer or assembly constraints
- Power rails, currents, connector requirements, and critical nets
- Expected board stackup and mechanical constraints
- Export directory and artifact requirements
- Existing waivers or accepted risks

## Primary MCP tools

### Health and capability checks

- `easyeda_health_check`
- `easyeda_bridge_status`
- `easyeda_get_capabilities`
- `easyeda_get_tool_profiles`
- `easyeda_run_self_test`

### Schematic validation

- `easyeda_erc_run`
- `easyeda_semantic_erc_validate`
- `easyeda_schematic_validate_netlist`
- `easyeda_schematic_verify_write`
- `easyeda_schematic_components`
- `easyeda_schematic_nets`
- `easyeda_schematic_net_detail`
- `easyeda_power_tree_analyze`

### PCB validation

- `easyeda_drc_run`
- `easyeda_rule_check_summary`
- `easyeda_board_layers`
- `easyeda_board_stackup`
- `easyeda_board_dimensions`
- `easyeda_board_features`
- `easyeda_pcb_constraint_check`
- `easyeda_pcb_constraint_report`
- `easyeda_pcb_production_review`

### BOM and sourcing validation

- `easyeda_bom_generate`
- `easyeda_bom_validate`
- `easyeda_bom_sourcing`
- `easyeda_bom_quality_report`

### Export and production checks

- `easyeda_export_gerbers`
- `easyeda_export_pick_place`
- `easyeda_export_pdf`
- `easyeda_export_netlist`
- `easyeda_production_qa_artifacts`
- `easyeda_jlcpcb_quote_workflow`
- `easyeda_canvas_capture`
- `easyeda_canvas_capture_region`

## Workflow

1. Confirm server and bridge state with `easyeda_health_check` and `easyeda_bridge_status`.
2. Confirm that the active profile exposes the needed validation tools.
3. Run schematic validation with `easyeda_erc_run`, `easyeda_semantic_erc_validate`, and `easyeda_schematic_validate_netlist` when schematic scope is included.
4. Run PCB validation with `easyeda_drc_run`, `easyeda_rule_check_summary`, and board inspection tools when PCB scope is included.
5. Run power-tree and critical-net validation when the design has named rails, current constraints, or safety-sensitive nets.
6. Run PCB constraint and production review tools against the provided manufacturer constraints.
7. Validate BOM and sourcing if assembly or procurement is in scope.
8. Generate export and production QA artifacts only when validation blockers are known and reported.
9. Capture visual evidence when layout or schematic readability matters.
10. Produce a final report that separates blocking issues, warnings, unknowns, waivers, and human-review items.

## Quality checks

A complete validation response must include:

- Health and bridge status
- Active tool profile
- ERC result summary
- DRC result summary
- Semantic/netlist result summary
- PCB constraints and production review
- BOM and sourcing status when relevant
- Export artifact status when relevant
- Blockers, warnings, unknowns, and waivers
- Human-review checklist

## Failure modes

Stop and report clearly when:

- EasyEDA bridge is disconnected
- Required validation tools are hidden by the active tool profile
- ERC/DRC tools cannot obtain project data
- Manufacturer constraints are missing for production review
- BOM/sourcing data is incomplete
- Export tools fail or artifact paths are ambiguous
- The user asks to ignore unresolved critical issues

## Output format

Return:

- Validation scope
- Tools used
- Results by domain
- Findings by severity
- Waivers and assumptions
- Export/production artifact status
- Final verdict: `blocked`, `needs fixes`, `needs human review`, or `candidate after human review`

## Safety rule

A clean automated validation result is not production approval. Production release requires human review of EasyEDA files, exports, BOM, assembly data, and manufacturer constraints.
