# Professional Schematic Layout

> **Status:** Active
> **Skill:** [`easyeda-professional-layout`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/skills/easyeda-professional-layout/SKILL.md)
> **Applies to:** easyeda-mcp-pro v0.34.0+

This page is the worked example referenced by the `easyeda-professional-layout`
skill. The skill file is the normative safety contract (policy IDs, numeric
defaults, stage gates); this page shows what following it actually looks like
end to end, with the concrete MCP tools each step maps to.

## Operator prompt

For a fresh design:

> Use the `easyeda-professional-layout` skill to lay out this schematic
> professionally. Read the real page and title-block geometry first, plan
> placement with a matching template if one fits, preview and read back every
> batch, and run layout QA plus a full-page capture before you tell me it's
> done. Stop and ask if geometry is unavailable or a critical issue remains —
> never guess coordinates.

For cleaning up an existing design, add:

> This is a cosmetic pass only — do not change any connectivity. Capture a
> connectivity fingerprint before you start and compare it after every batch.

## Worked example

The steps below follow the skill's mandatory workflow (`SKILL.md`, "Mandatory
workflow") against a hypothetical USB-powered MCU board.

1. **Discover geometry.** `easyeda_health_check`, `easyeda_bridge_status`,
   then `easyeda_schematic_sheet_info` for sheet bounds, drawable bounds,
   grid, and title-block bounds. If any of these are unavailable, stop with
   `LAYOUT_GEOMETRY_REQUIRED` — do not fall back to guessed coordinates.
2. **Inventory components.** `easyeda_schematic_components` and
   `easyeda_schematic_nets` for anything already on the sheet, plus the full
   list of parts the new design needs (main devices, connectors, and every
   support component — decoupling caps, pull-ups, crystal load caps).
3. **Resolve rendered bounds.** `easyeda_schematic_primitive_bounds` for any
   existing primitives, so support-component space is reserved against real
   rotation-aware combined bounds, not symbol origins.
4. **Create keep-outs and blocks.** The title block and page border are hard
   keep-outs (`TITLE_BLOCK_KEEP_OUT`); group the inventory into named
   functional blocks (power entry, controller, connectors, support).
5. **Select a template and plan.** If the design matches one of the six
   catalog templates (`src/professional-layout-templates/index.ts`) — USB
   MCU board, ESP32 sensor node, battery IoT node, CAN/RS-485 interface,
   simple analog/timer, or medium MCU peripheral board — use its block order,
   signal flow, and clearances as the starting constraints. Then call
   `easyeda_schematic_plan_layout` to get a deterministic placement plan, and
   `easyeda_schematic_check_placement` to validate or search for safe regions
   for anything the plan doesn't cover.
6. **Place, preview, read back.** Place main components first, then support
   components, one small batch at a time. After each batch, re-read
   `easyeda_schematic_components` / `easyeda_schematic_primitive_bounds` —
   never trust a write's own return value alone, and never blindly retry a
   timeout (`NO_BLIND_RETRY`): re-check real state first.
7. **Wire.** Only after placement QA is clean. Prefer visible, local,
   orthogonal connections; avoid detached net ports in a normal circuit.
8. **Cosmetic cleanup.** A separate, electrically-inert pass for alignment,
   spacing, and wire length — never change connectivity here.
9. **Fingerprint before/after.** Call
   `easyeda_schematic_connectivity_fingerprint` immediately before the
   cleanup pass and again after every cosmetic batch
   (`CONNECTIVITY_FINGERPRINT_REQUIRED`). Roll back any batch whose
   fingerprint doesn't match.
10. **QA, validate, capture.** Run `easyeda_schematic_layout_qa` with
    `runVisualCapture: true` (which calls `easyeda_schematic_capture_full_page`
    internally), plus `easyeda_schematic_validate_netlist` /
    `easyeda_erc_run`. Read every issue code and per-dimension score
    (geometry/readability/grouping/spacing/wiring/electrical/runtime), not
    just the aggregate.
11. **Save or block.** Only call `easyeda_project_save` once critical issues
    are zero (`NO_SAVE_WITH_CRITICALS`). Otherwise report the exact blockers,
    affected regions, and the next safe action — do not claim the layout is
    production-ready.

## What this replaces

Before this skill existed, agents were told to "make the schematic
professional" or "keep related components close" — subjective phrasing that
produced inconsistent layouts even with identical tools. The skill instead
encodes the workflow above as a deterministic contract, tested for equivalence
across Claude Code, Codex, and Antigravity distributions
(`tests/unit/professional-layout/skill-distribution.test.ts`).

## What MCP enforces vs. what is guidance only

The skill is prompt text — an agent that ignores it still has working tools.
Know which policies a tool call actually refuses to violate, and which ones
depend on the agent following the workflow:

| Policy                                 | Enforcement                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TITLE_BLOCK_KEEP_OUT`                 | **MCP-enforced.** `easyeda_schematic_check_placement` / `easyeda_schematic_plan_layout` treat the title block and page border as hard keep-outs that reject a candidate — never a score penalty. |
| `RENDERED_BOUNDS_ONLY`                 | **MCP-enforced.** Placement and QA math is computed from live rendered/combined bounds (`easyeda_schematic_primitive_bounds`), not component origin points or agent estimates.                   |
| Missing-geometry fail-safe             | **MCP-enforced.** `resolveProfessionalLayoutTemplate` and the placement tools return `LAYOUT_GEOMETRY_REQUIRED` / an error instead of guessed coordinates when sheet geometry is unavailable.    |
| Template catalog structure             | **MCP-enforced.** `validateProfessionalLayoutTemplateCatalog` throws at build time if a template's numeric defaults, keep-outs, or support rules are malformed.                                  |
| Connectivity fingerprint comparison    | **MCP-enforced.** `easyeda_schematic_connectivity_fingerprint` computes real pin/net/wire membership from live state — the comparison itself isn't agent-judged.                                 |
| `PAGE_GEOMETRY_REQUIRED` step ordering | **Guidance only.** No tool refuses to place a component just because sheet info wasn't read first this session.                                                                                  |
| `NO_BLIND_RETRY`                       | **Guidance only.** A timeout doesn't stop an agent from retrying; the skill instructs re-checking real state first, but no tool enforces it.                                                     |
| `STAGED_PREVIEW_READBACK_QA` cadence   | **Guidance only.** Nothing forces a readback or a QA run between batches — it's a workflow discipline.                                                                                           |
| Wiring only after placement QA passes  | **Guidance only.** Wire tools don't check `easyeda_schematic_layout_qa` results before running.                                                                                                  |
| `NO_SAVE_WITH_CRITICALS`               | **Guidance only.** `easyeda_project_save` does not read `commitBlocked` from a prior QA run — nothing server-side prevents saving with critical layout issues outstanding.                       |

This is why the skill exists as a separate artifact rather than being folded
into tool descriptions: the deterministic primitives (#243/#244/#271/#272/#273/#274)
make correct layout _possible_ and make certain violations _impossible to hide_,
but the workflow discipline that gets an agent to call them in the right order,
at the right cadence, and to stop before saving is enforced by the skill
contract, not by the tools themselves.

## Related

- [Schematic layout benchmarks](/schematic-layout-benchmarks) — how to
  validate this workflow against golden fixtures before changing defaults.
- [Golden E2E Fixtures](/golden-fixtures) — the general fixture mechanism
  this benchmark suite builds on.
- [MCP Tools Reference](/reference/tools) — full parameter/return schemas for
  every tool named above.
