# Engineering review: staged tool routing and evidence boundaries

This is the canonical, **on-demand** phase router for EasyEDA MCP Pro
engineering inspection. Load it only for a design, PCB, component or
production-validation task. It complements the existing
`skills/design-validation/SKILL.md`, `skills/easyeda-workflow/SKILL.md`,
`skills/easyeda-component-review/SKILL.md` and
`skills/easyeda-professional-layout/SKILL.md`. Do not add a second
rule engine, agent or plugin for these checks.

## Route by requested scope

| Phase                     | Purpose and existing tools                                                                                                                                                                                                                                                        | Source/evidence boundary                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Requirements           | `easyeda_health_check`, `easyeda_bridge_status`, `easyeda_get_capabilities`, `easyeda_get_tool_profiles`; identify project, focused document and intended manufacturing context                                                                                                   | Health is not design evidence. An empty native read may mean the wrong EasyEDA tab, absent support or a disconnected bridge                                                                                                                          |
| 2. Component/datasheet    | `easyeda_schematic_components`, `easyeda_schematic_component_pins` and canonical `easyeda-component-review` skill                                                                                                                                                                 | Exact MPN, package suffix, document revision/page, actual bound footprint/model and library identity are required for scoped checking; supplier descriptions and model defaults are not proof                                                        |
| 3. Schematic/ERC          | `easyeda_erc_run`, `easyeda_semantic_erc_auto`, `easyeda_schematic_validate_netlist`; both semantic tools accept optional `datasheetConstraints`; prefer `easyeda_semantic_erc_auto` for live designs and `easyeda_semantic_erc_validate` for caller-supplied netlists            | Native ERC has coarse aggregate severity; semantic auto has inferred pin electrical types. Datasheet comparisons on `..._validate` are caller-declared and are not authenticated from a manufacturer                                                 |
| 4. Power/placement        | `easyeda_power_tree_analyze`; for schematic placement use `easyeda-professional-layout` skill and its geometry/preview/readback guards                                                                                                                                            | Power budgets need actual current/dropout/thermal assumptions. Placement origin/nearby references are not pad-net continuity or verified high-frequency paths; cosmetic writes need explicit approval                                                |
| 5. Routing/DRC            | `easyeda_drc_run`, `easyeda_pcb_route_geometry_review`, `easyeda_design_rules_lookup` with `topic: "trace-current-review"` or `topic: "protocol-routing"`                                                                                                                         | Native DRC gives **aggregate** counts, not located issue geometry. Route observations require exact caller/native trace/pad/net evidence; approximated widths and loop names cannot yield manufacturing PASS                                         |
| 6. DFM/DFT and insulation | `easyeda_pcb_constraint_check`, `easyeda_pcb_production_review` (optional `manufacturerProfile`), `easyeda_design_rules_lookup` with `topic: "dfm-checklist"` or `topic: "isolation-emc-review"`; `easyeda_production_qa_artifacts` only if artifacts are requested and permitted | Generic checklist guidance differs from source-declared factory profile limits and native DRC. Missing drill/mounting-hole/assembly/testpoint geometry remains UNKNOWN. Insulation/ESD/EMC review does not confer safety or laboratory certification |
| 7. Documented review      | `easyeda_engineering_review`, native readback and the human engineer's disposition                                                                                                                                                                                                | Report each source/version, observation, measured or declared units, limits, errors, warnings, UNKNOWN, waivers, and unresolved physical/human-review evidence. No fabrication or release approval is inferred                                       |

**Select only the phases relevant to the requested job.** For a component
review, phases 1–2 and 7 suffice unless the user requests circuit/board
validation. For schematic bring-up, prefer phases 1–4 and 7. For
routing/PCB inspection, phases 1, 5–7 are typical. For a
production/release-readiness review, use all applicable phases with
explicit DFM/DFT, BOM/package and artifact coverage; phase 7 cannot
override missing source proof.

## Enforced MCP controls versus agent advice

- **Enforced by current MCP tool contracts:** Zod input validation,
  declared tool profile/scope, `confirmWrite` and remote approval where
  a tool requires them, and bounded outputs for each actually executed
  validation. An existing semantic ERC with optional
  `datasheetConstraints` flags declared pin/rail contradictions;
  a production review with optional `manufacturerProfile` keeps
  `manufacturing_approval=false` and never returns a profile-based
  factory-ready PASS. The `isolation-emc-review` lookup reports
  source-scoped spacing conflicts or UNKNOWN, not certification.
- **Advisory skill guidance, not independently enforced:** the
  seven-stage ordering, manufacturer-datasheet authentication,
  reviewing pin-to-pad mappings, full support-component topology,
  continuous return-path inspection, physical test access, exact
  standard-table applicability, and final human sign-off. An agent
  should request these as evidence, **not claim** the MCP already
  proves them.
- **No native confirmation from inferences:** empty/partial result,
  designer-supplied model, reference designator, estimated XY gap or
  net named `3V3` does not prove a missing component, verified
  surface creepage, a 3.3 V rail, or zero violations. Do not map
  UNKNOWN to a successful check.
- **Write/export gates:** read-only inspection is allowed.
  Mutating EasyEDA design/library operations require the established
  explicit user write approval and tool confirmation. Approval for a
  schematic write is not approval for Personal Device metadata, PCB
  writes, exporting data, factory submission or creating an order.
  Export only when authorized, and keep actual fabrication/vendor
  contact out of this review. After any write, verify editor
  readback; an ambiguous timeout must not be retried blindly.

## On-demand rule and source references

Use the existing `easyeda_design_rules_lookup` topics rather than
loading a complete rule catalog into every request:

| Specific question                    | Lookup or review path                                                                                                | Important limit                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traces and current                   | `trace-current-review`, with explicit units, layer, copper weight, environment and manufacturer limit when available | Estimates do not prove thermal or fabrication safety                                                                                                                 |
| A protocol net's routing             | `protocol-routing`                                                                                                   | Protocol guidance is not routed native geometry                                                                                                                      |
| Power decoupling or bulk             | `decoupling` and `bulk-capacitance`                                                                                  | Source-specific recommended components and layout must be checked                                                                                                    |
| General clearance recommendation     | `clearance`                                                                                                          | Generic guidance is not equipment safety clearance/creepage certification                                                                                            |
| Isolation/ESD/EMC                    | `isolation-emc-review`                                                                                               | Explicit standard identifier, **edition**, clause, pollution/material/altitude and distinct observed air/surface measurements; no licensed table values are embedded |
| Manufacturer assembly/test readiness | `dfm-checklist` plus optional `manufacturerProfile` on `easyeda_pcb_production_review`                               | Profile identity, process, revision, source and native-versus-caller evidence must be visible; a matching summary stays unapproved                                   |

Read detailed rules only when relevant:

- `docs/datasheet-electrical-review.md` for pin/IO voltage, NC, support
  component and regulator-headroom provenance.
- `docs/isolation-emc-evidence-review.md` for distinct through-air and
  surface paths, context, and standards metadata (not numerical tables).
- `docs/manufacturer-process-profile-review.md` for source/version,
  measurement units, missing factory/process/DFT evidence and limitations.
- `skills/easyeda-component-review/references/review-process.md` for
  source drawings, footprint/pad/3D evidence and Personal Device scope.
- `docs/professional-schematic-layout.md` for geometry/readback stages.

A standard **identifier, edition and clause are metadata**, not an
authenticated standards excerpt. Do not generate or reproduce
copyrighted IEC/IPC numeric tables or assert that a declared factory
profile is the current manufacturer's real capability.

## Example distinctions

1. **Schematic 5 V rail versus declared 3.6 V pin limit:** on a
   caller-supplied netlist with exact component/pin and a declared
   numeric rail, `easyeda_semantic_erc_validate` may report a
   contradiction as WARNING. It cannot verify the datasheet's
   authenticity, rail tolerance or actual live EasyEDA connectivity.
2. **PCB 0.15 mm finished drill versus a claimed 0.30 mm fab floor:**
   `easyeda_pcb_production_review` with a versioned profile reports
   WARNING for the reported mismatch. A larger reported drill
   remains UNKNOWN for real manufacturer acceptance.
3. **Air gap and surface creepage:** a through-air value meeting
   a declared clearance limit is not a measured creepage path.
   Missing actual surface geometry yields UNKNOWN rather than PASS.
4. **Release request:** successful unit tests, native DRC summary
   and production checklist alone do not authorize a release,
   fabrication order or electrical/EMC sign-off. Record the
   outstanding exact-version EasyEDA readback and qualified
   reviewer tasks.

This reference is repo-owned and intentionally loaded on demand.
Runtime wrappers should point to this path and the canonical
`skills/` files instead of carrying independently edited rule catalogs.
