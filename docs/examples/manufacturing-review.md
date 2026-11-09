# Manufacturing Review Example Workflow

This guide details a step-by-step workflow for running a manufacturing audit on a PCB design before exporting Gerber and Drill files.

---

## The Workflow

```mermaid
graph TD
    A[Start Audit] --> B[Run DRC easyeda_drc_run]
    B --> C{Any violations?}
    C -- Yes --> D[Examine violations and report to user]
    C -- No --> E[Verify Board Features easyeda_board_features]
    E --> F{Manual 3D and enclosure review complete?}
    F -- No --> G[Record UNKNOWN and hold handoff]
    F -- Yes --> H[Export Gerbers easyeda_export_gerbers]
    H --> I[Generate BOM easyeda_bom_generate]
    I --> J[Package for human sign-off]
```

---

## 1. Run the Design Rule Check (DRC)

First, check if the PCB layout violates any manufacturing spacing constraints:

**MCP Call**:
`easyeda_drc_run` with no parameters.

**AI Action**:
The assistant triggers a DRC run in the live editor. If there are spacing or clearance violations, it parses them:

```json
{
  "passed": false,
  "violationCount": 3,
  "violations": [
    {
      "type": "Clearance",
      "message": "Track clearance violation between Net VCC and Net GND",
      "coordinates": { "x": 142.5, "y": 88.2 }
    }
  ]
}
```

---

## 2. Inspect Board Outline & Dimensions

Before exporting, verify that board stackups and mounting holes match manufacturer capabilities:

**MCP Call**:
`easyeda_board_dimensions` and `easyeda_board_stackup`.

---

## 3. Inspect the PCB in 3D (human checkpoint)

Open the focused PCB in EasyEDA Pro and select **View → 3D Preview**. Verify
both board sides, actual bound component models, body height and connector
or enclosure clearance using the relevant manufacturer drawings. Missing
models or unmeasured mechanical constraints are **UNKNOWN**, not a passed
check. Follow the [manual 3D enclosure and assembly review](../production-qa.md).

The current MCP canvas capture is **2D only**; it must not be reported as a
verified 3D collision or enclosure-fit analysis. Resolve the unknowns before
manufacturing handoff.

---

## 4. Export Fabrication Files

Once checks pass, export the production deliverables:

- **Gerbers**: Call `easyeda_export_gerbers` to generate the copper, solder mask, and silkscreen layers.
- **Centroids**: Call `easyeda_export_pick_place` to generate the pick-and-place placement map (required for assembly).
- **PDF**: Call `easyeda_export_pdf` to export documentation plots.
