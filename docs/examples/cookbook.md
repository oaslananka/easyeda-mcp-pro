# Example Project Gallery and Cookbook

These examples describe safe, repeatable workflows for AI-assisted EasyEDA review. They are documentation examples, not a substitute for human electrical review. Always run read-only inspection before write tools and require explicit confirmation before mutations or exports.

## 1. MCU development board review

**Goal:** Review a small MCU board with regulator, USB/programming header, reset, boot mode, and debug pins.

**Prompt:**

```text
Inspect the active EasyEDA project as an MCU development board. Summarize schematic risks, power tree assumptions, decoupling coverage, programming/debug access, and PCB production readiness. Do not mutate the design.
```

**Tool sequence:**

1. `easyeda_live_smoke_report`
2. `easyeda_schematic_components`
3. `easyeda_schematic_nets`
4. `easyeda_bom_generate`
5. `easyeda_drc_run` / `easyeda_erc_run` when available in the active profile

**Safety checkpoints:**

- Confirm power nets and ground nets are non-empty.
- Confirm reset and programming nets are named and accessible.
- Confirm write tools are not called unless the user asks for a change plan.

## 2. Linear or switching regulator board review

**Goal:** Review input protection, regulator margins, thermal risk, bulk capacitance, and output test access.

**Prompt:**

```text
Review the active project as a regulator board. Identify input/output voltage assumptions, missing protection, bulk capacitance, and manufacturing/export concerns. Return a severity-ranked checklist.
```

**Expected output:**

- Power path summary
- BOM availability notes
- Critical nets list
- Thermal and current-budget assumptions clearly marked when unknown

## 3. USB interface board review

**Goal:** Review USB connector wiring, ESD protection, differential pair routing assumptions, shield/ground handling, and labeling.

**Prompt:**

```text
Inspect this project as a USB interface board. Check connector pins, ESD/protection placement assumptions, differential routing risks, and export readiness. Do not place or route anything automatically.
```

**Safety checkpoints:**

- Treat high-speed routing guidance as review feedback unless a verified PCB write workflow exists.
- Confirm USB data net names before recommending layout changes.

## 4. Sensor board BOM and sourcing review

**Goal:** Review a sensor board for lifecycle, stock, footprint/package risk, and substitution caveats.

**Prompt:**

```text
Generate a BOM review for this sensor board. Flag missing manufacturer data, ambiguous parts, unavailable parts, risky packages, and substitution caveats. Keep vendor data provenance explicit.
```

**Expected output:**

- BOM table
- Missing or ambiguous MPNs
- Vendor/source freshness notes
- Safe-substitution caveats rather than automatic replacements

## 5. Manufacturing export preflight

**Goal:** Prepare a board for fabrication handoff without silently ordering or paying for anything.

**Prompt:**

```text
Run a manufacturing preflight for the active project. Check export package readiness, manifest expectations, DRC/ERC blockers, and assembly notes. Do not submit quotes or orders.
```

**Tool sequence:**

1. Read-only project inspection
2. DRC/ERC review
3. Export manifest validation
4. Human confirmation before any export tool with write or file-output side effects

**Safety checkpoints:**

- Quote/order actions require explicit user confirmation and audit.
- Export packages must include hashes and clear generation metadata.
- Any missing board outline, drill, placement, or BOM artifact should block handoff until reviewed.

## 6. Visual verification after a schematic edit

**Goal:** After placing a component or drawing a wire, visually confirm the change looks
right before continuing — catch overlaps, dangling wires, or misplacements a structural
diff alone would miss.

**Prompt:**

```text
Place a 0603 decoupling capacitor near U1's VCC pin and wire it to VCC and GND. After placing it, capture the area and check the result looks correct before doing anything else.
```

**Tool sequence:**

1. `easyeda_schematic_place_component` / `easyeda_schematic_add_wire` (with `confirmWrite: true`)
2. `easyeda_canvas_capture_region` framed around the edited area (or `easyeda_canvas_capture`
   for the whole visible viewport)
3. Visually inspect the returned PNG for overlaps, dangling wire ends, or misplacement
4. If something looks wrong, use `easyeda_schematic_verify_write` or a follow-up
   read-only inspection tool to confirm the structural state, then correct it

**Safety checkpoints:**

- `easyeda_canvas_capture_region` moves the user's visible viewport (EasyEDA Pro has no
  offscreen rendering API) — mention this to the user before use in an interactive session.
- Treat the captured image as a visual sanity check, not a substitute for DRC/ERC.
- A capture that fails with `not_available` (e.g. `PAYLOAD_TOO_LARGE`) should fall back to
  structural inspection tools rather than blocking the whole review.

## 7. PCB layout review with design-rule citations

**Goal:** Before finalizing routing, check board-level constraints and cite engineering
reference guidance (trace width, clearance, protocol routing, decoupling, DFM) instead of
guessing values from memory.

**Prompt:**

```text
Review the PCB layout for the active project before I finalize routing. For the 5V rail
trace carrying 2A, the USB data pair, and the MCU decoupling, look up the relevant design
rules rather than assuming values, and cite what you found.
```

**Tool sequence:**

1. `easyeda_pcb_constraint_check` and `easyeda_pcb_production_review`
2. `easyeda_design_rules_lookup` with `topic: 'trace-width'` for the 2A rail
3. `easyeda_design_rules_lookup` with `topic: 'protocol-routing', protocol: 'usb2'`
4. `easyeda_design_rules_lookup` with `topic: 'decoupling', category: 'mcu'`
5. Cross-check `easyeda://design-rules/dfm-checklist` before sign-off

**Safety checkpoints:**

- Every `easyeda_design_rules_lookup` result includes a `source` and a `caveat` — surface
  both to the user, don't just report the number.
- These are rule-of-thumb estimates, not certified values — flag anything safety-critical
  (mains-adjacent clearance, high-current traces) for confirmation against the actual
  standard, the fabricator's capability table, or the target IC's datasheet.
- The `review_layout` MCP prompt encodes this same sequence for reuse.

## 8. Building a power-rail stage in three tool calls

**Goal:** Place a regulator with its input/output capacitors and wire the whole stage to
named nets as one atomic transaction, instead of one primitive call per component and per
pin connection.

**Prompt:**

```text
Add a 3.3V regulator stage to the active schematic: search for the part, then place it
with its input and output capacitors and wire everything to VIN_5V, VOUT_3V3, and GND.
```

**Tool sequence (3 calls total):**

1. `easyeda_schematic_search_device` — resolve the regulator's `deviceItem` (`libraryUuid`/`uuid`)
2. `easyeda_schematic_search_device` — resolve a generic 0603 ceramic capacitor's `deviceItem`
   (reused for both the input and output capacitor)
3. `easyeda_workflow_power_rail` with `mode: 'preview'` first to inspect the deterministic
   plan, then again with `mode: 'apply', confirmWrite: true` — this single call places the
   regulator plus both capacitors and wires every pin to `VIN_5V` / `VOUT_3V3` / `GND`

**Safety checkpoints:**

- Always preview before apply: the plan lists every component, its computed placement
  coordinates, and every pin-to-net connection it will make before anything is written.
- This tool does not select parts for you — it only orchestrates placement and wiring of
  device items you've already resolved, so a wrong part number is still your responsibility
  to catch before calling it.
- If apply fails part-way through, newly-placed components/net ports from that same call are
  rolled back automatically (best-effort) — check the response's `rolled_back` and
  `rollback_notes` fields rather than assuming a clean state.
- `easyeda_workflow_decouple_ic` follows the same pattern for adding decoupling capacitors to
  an already-placed IC's power pins in one call.

## 9. Floorplan, autoroute, verify — with a vendor-neutral fallback

**Goal:** Go from a CircuitIR to a routed, DRC-checked board, without silently reporting
success and without getting stuck if the native autorouter is unavailable.

**Prompt:**

```text
Floorplan the board from this CircuitIR, keeping the connector on the bottom edge and the
regulator on the bottom copper side, then autoroute it and confirm it's actually clean
before telling me it's done.
```

**Tool sequence:**

1. `easyeda_pcb_floorplan` with `mode: 'preview'`, then `mode: 'apply', confirmWrite: true` —
   places components per CircuitIR physical constraints (keepouts, top/bottom side,
   connector edge, thermal spacing)
2. `easyeda_pcb_autoroute` with `confirmWrite: true` — runs a pre-flight constraint check,
   calls the native autorouter, then a mandatory post-route DRC + constraint report
3. If `overall_verdict` is `partial` or `failed` (or the autorouter reports `not_available`),
   fall back to `easyeda_pcb_export_route_context` to get a Specctra DSN file for an external
   autorouter such as FreeRouting, then re-import the routed result through EasyEDA Pro itself

**Safety checkpoints:**

- Never report "routed" from `overall_verdict` alone without also surfacing `post_route_drc`
  and `post_route_constraint_report` to the user — a `partial` verdict means real issues exist.
- `PCB_Document.autoRouting` is a `@beta` EasyEDA Pro API — a `not_available: true` response
  means try the DSN export fallback, not retry the same call.
- Top-side and bottom-side floorplan passes are not cross-checked for collisions — read
  `floorplan_notes` and eyeball the result (e.g. via `easyeda_canvas_capture`) before autorouting.
