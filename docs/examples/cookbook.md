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
