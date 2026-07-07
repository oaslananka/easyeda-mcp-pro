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
- **Which document tab is focused in EasyEDA Pro** — schematic validation tools need the schematic tab active, PCB validation tools need the PCB tab active. A tool called against the wrong tab does not error, it silently returns an empty/`not_available` result — do not report "no issues found" from a validation run that may simply have had no data to check.
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
- `easyeda_live_write_regression` (dev profile) — exercises real write paths against the live bridge and reports pass/fail per step; use to distinguish "the bridge itself is misbehaving" from "the design has real issues" when validation results look suspicious

### Schematic validation

- `easyeda_erc_run` — native ERC is coarse (per-severity aggregate counts only, e.g. "1 warning"); it does not natively report which pin/net/component is affected. This tool supplements it with `inferred_floating_pins`/`detail_source` (best-effort, located via netlist inference) — treat `detail_source: 'native_aggregate_only'` as a signal that no itemized detail is available for that run.
- `easyeda_semantic_erc_auto` — extracts nets/devices/pins from the *live* schematic and runs semantic ERC without a hand-authored netlist. Electrical types are inferred from pin/net naming conventions, not verified against EasyEDA's own metadata (which is unreliably populated — a passive part's pins can report a native type like "IN"). Prefer this over `easyeda_semantic_erc_validate` when the goal is validating what's actually drawn, not a hypothetical netlist.
- `easyeda_semantic_erc_validate` — same rule engine as `..._auto`, but takes a fully hand-authored `nets`/`devices` structure. Use when the schematic isn't drawn yet, or when inferred classification isn't trustworthy enough for the check being run.
- `easyeda_schematic_validate_netlist`
- `easyeda_schematic_verify_write`
- `easyeda_schematic_components`
- `easyeda_schematic_nets`
- `easyeda_schematic_net_detail`
- `easyeda_power_tree_analyze`

### PCB validation

- `easyeda_drc_run` — native PCB DRC is coarse (per-severity aggregate counts only), with no itemized-violation inference layer (unlike `easyeda_erc_run`). Report a DRC pass/fail as "N errors, location unknown — open the DRC panel in EasyEDA Pro for detail," not as a located finding.
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
3. Run schematic validation with `easyeda_erc_run`, `easyeda_semantic_erc_auto` (or `..._validate` if working from a hand-authored netlist), and `easyeda_schematic_validate_netlist` when schematic scope is included.
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
- ERC/DRC tools cannot obtain project data — check document tab focus (schematic vs PCB) before treating an empty result as "no issues"
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
