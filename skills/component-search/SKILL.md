---
name: component-search
description: EasyEDA component discovery, BOM review, LCSC/JLCPCB sourcing, pricing, availability, and part-risk workflow through EasyEDA MCP Pro.
---

# Component Search Skill

Use this skill when an AI agent is asked to find, review, source, compare, or validate components for an EasyEDA Pro project through EasyEDA MCP Pro.

This skill is specific to `oaslananka/easyeda-mcp-pro` and must stay aligned with the registered MCP tools in `src/tools/` and the tool list in `README.md`.

## When to use

Use this skill for:

- EasyEDA schematic device search
- BOM generation and review
- LCSC/JLCPCB-oriented sourcing checks
- Supplier pricing and availability review
- BOM export preparation
- Component-quality and production-risk reporting

Do not use this skill to promise live inventory, price, lifecycle, or compliance facts unless the relevant tool result actually provides them.

## Required context

Collect:

- Target component requirements: value, tolerance, package, voltage, current, temperature, lifecycle, and manufacturer constraints
- Preferred supplier or marketplace: LCSC, JLCPCB, DigiKey, Mouser, or project default
- Assembly target: prototype, JLCPCB assembly, manual assembly, or production
- Active schematic and BOM state
- Whether component placement or property updates are allowed
- API credentials or supplier integration status when supplier tools require them

## Primary MCP tools

### Schematic and component discovery

- `easyeda_schematic_components`
- `easyeda_schematic_search_device`
- `easyeda_schematic_component_pins`
- `easyeda_schematic_net_detail`
- `easyeda_schematic_nets`

### BOM generation and validation

- `easyeda_bom_generate`
- `easyeda_bom_validate`
- `easyeda_bom_export`
- `easyeda_bom_sourcing`
- `easyeda_bom_quality_report`

### Supplier and production workflow

- `easyeda_jlcpcb_quote_workflow`
- `easyeda_production_qa_artifacts`
- `easyeda_export_pick_place`
- `easyeda_export_netlist`

### Controlled component write workflow

Use only after explicit permission and runtime capability confirmation.

- `easyeda_schematic_place_component`
- `easyeda_schematic_modify_primitive`
- `easyeda_schematic_connect_pin_to_net`
- `easyeda_schematic_connect_pins_by_net`
- `easyeda_project_save`

## Workflow

1. Confirm health and bridge state with `easyeda_health_check` and `easyeda_bridge_status` if no recent status exists.
2. Inspect current components with `easyeda_schematic_components`.
3. Generate or refresh BOM with `easyeda_bom_generate`.
4. Validate BOM structure and basic sourcing data with `easyeda_bom_validate`.
5. Use `easyeda_schematic_search_device` when searching for new EasyEDA library devices.
6. Use `easyeda_bom_sourcing` and `easyeda_bom_quality_report` for supplier, price, stock, and risk review when available.
7. For JLCPCB workflows, use `easyeda_jlcpcb_quote_workflow` and report all assumptions.
8. If the user requests component insertion or property updates, explain the mutation and use controlled schematic write tools only after approval.
9. Export BOM or pick-and-place only when the project state and assembly target are clear.
10. Report recommended parts with evidence, constraints, and unresolved risks.

## Quality checks

A useful component-search response must include:

- Search criteria used
- Current BOM state
- Candidate components and source evidence
- Package and footprint compatibility notes
- Electrical derating risks
- Stock, pricing, and supplier caveats
- Assembly suitability
- Required human review

## Failure modes

Stop and report clearly when:

- Supplier tools are unavailable or credentials are missing
- The user asks for guaranteed current stock or price without live tool evidence
- The component requirements are under-specified
- The EasyEDA library search returns ambiguous candidates
- Footprint compatibility cannot be verified
- A write operation is requested without permission

## Output format

Return:

- Requirement summary
- Tools used
- Candidate table or BOM findings
- Recommended choice and rationale
- Risks and missing data
- Required verification steps
- Optional write/export actions

## Safety rule

Component recommendations are engineering suggestions. A qualified human must verify datasheets, footprint, availability, lifecycle, compliance, and assembly constraints before purchase or production.
