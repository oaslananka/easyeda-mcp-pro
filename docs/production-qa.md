# Production QA Artifacts

Production QA artifacts extend a manufacturing handoff package with test, assembly, and bring-up documentation.

## Tool

```text
easyeda_production_qa_artifacts
```

The tool is read-only. It generates Markdown and JSON artifacts from board metadata and does not call the EasyEDA bridge.

Assembly placement side comes only from the caller-declared component metadata. When omitted, the assembly notes display **unverified** (not an assumed top-side placement), and the affected assembly checklist item remains **review** until confirmed. This is metadata completeness, not independent native placement or pick-and-place proof. The report's `passed` field only means no generated hard-error issues; required human-review checklist items and physical fabrication/assembly approval remain separate.

Assembly component references must be exact, nonblank and unique across the entire caller-declared inventory, including parts without assembly notes. Reused or malformed references remain **review** with no trusted checklist ref; different references that normalize to the same slug receive unique checklist IDs. Generated assembly notes mark ambiguous identities, but do not certify that caller data matches a live board.

## Generated artifacts

| Role                      | Filename pattern               | Purpose                                         |
| ------------------------- | ------------------------------ | ----------------------------------------------- |
| `testpoint-checklist`     | `*-testpoint-checklist.md`     | Critical-net test access checklist              |
| `assembly-notes`          | `*-assembly-notes.md`          | Polarity, DNP, side, and special handling notes |
| `bringup-plan`            | `*-bringup-plan.md`            | Bench bring-up and rail verification plan       |
| `production-qa-checklist` | `*-production-qa-checklist.md` | Operator-facing QA checklist                    |
| `qa-manifest`             | `*-production-qa.json`         | Machine-readable QA package                     |

## Input example

```json
{
  "projectId": "proj-qa",
  "projectName": "Sensor Board",
  "revision": "A1",
  "criticalNets": [
    { "name": "GND", "category": "ground", "hasTestPoint": true, "testPointRef": "TP1" },
    { "name": "3V3", "category": "power", "hasTestPoint": true, "testPointRef": "TP2" },
    { "name": "RESET", "category": "reset", "hasTestPoint": true, "testPointRef": "TP3" },
    { "name": "SWDIO", "category": "programming", "hasTestPoint": true, "testPointRef": "TP4" }
  ],
  "components": [
    { "ref": "D1", "value": "LED", "footprint": "0603", "polarized": true, "orientationMark": true }
  ],
  "requiresProgramming": true,
  "programmingInterfaces": ["SWD"],
  "hasProgrammingAccess": true,
  "requiresFunctionalTest": true
}
```

Generated Markdown table cells escape caller-supplied pipes, raw HTML and line breaks so component labels, testpoint names and handling instructions cannot create extra columns/rows or executable markup. The JSON QA manifest keeps the original values for source attribution.

Critical-net testpoint rows preserve exact net identities even if different names
normalize to the same checklist slug. A declared test point without a nonblank,
exact reference, a repeated testpoint reference across critical nets, or a
duplicate/ambiguous net identity remains **review / unverified**, never checklist `pass`. All such inputs are caller-supplied, not
independent proof of physical access. Bring-up instructions do not invent a
test-point position when a reference is missing.

## Findings

The generator emits structured issues for release blocking or review-required conditions:

| Code                                 | Severity | Meaning                                                  |
| ------------------------------------ | -------- | -------------------------------------------------------- |
| `QA_CRITICAL_NET_MISSING_TESTPOINT`  | error    | Required critical net lacks declared test access         |
| `QA_PROGRAMMING_ACCESS_REQUIRED`     | error    | Programming/debug access is required but missing         |
| `QA_POLARITY_NOTE_MISSING`           | warning  | Polarized component lacks orientation note/mark metadata |
| `QA_ASSEMBLY_HANDLING_NOTE_REQUIRED` | warning  | Board requires special handling notes                    |
| `QA_BRINGUP_POWER_STEP_REQUIRED`     | info     | Power-rail verification should be part of bring-up       |

## Export manifest integration

Production QA artifacts can be required in a manufacturing export manifest using these roles:

```typescript
ExportArtifactRole.TestpointChecklist;
ExportArtifactRole.AssemblyNotes;
ExportArtifactRole.BringupPlan;
ExportArtifactRole.ProductionQaChecklist;
ExportArtifactRole.QaManifest;
```

Example policy:

```json
{
  "manufacturingPolicy": {
    "requiredRoles": [
      "testpoint-checklist",
      "assembly-notes",
      "bringup-plan",
      "production-qa-checklist",
      "qa-manifest"
    ]
  }
}
```

If a required QA role is missing, export manifest validation fails before the package is considered complete.

## Manual 3D enclosure and assembly review (EasyEDA Pro 3.2.209)

**Before ordering or marking a PCB assembly review complete**, open the **focused PCB**
inside EasyEDA Pro and select **View → 3D Preview**. The official editor also
provides **Tools → 3D Model Manager** to inspect component-model bindings.
This is a **manual checkpoint**, not a capability of
`easyeda_production_qa_artifacts`, `easyeda_canvas_capture` or a generated
fabrication manifest. A 2D Component Shape layer image cannot establish 3D
body dimensions or enclosure clearance.

1. Check the **top and bottom** of the board, and identify components that have
   no model or an obviously mismatched model, transform or mounting side.
2. Compare actual component body heights, connector mating/cable exit directions,
   fastener/keepout clearances and any enclosure constraints against the
   **appropriate manufacturer mechanical drawing**. Inspect relevant viewing
   angles; an attractive 3D rendering alone is not dimensional evidence.
3. Record the **board revision, EasyEDA version, model identities/revisions**,
   source drawing pages, reviewer, and results. A missing model, unverified
   mounting offset or unavailable enclosure model remains **UNKNOWN / needs
   review**, never `pass`.
4. Do not mark the mechanical or assembly checklist approved until a human
   reviewer has resolved the applicable unknowns. Keep the generated QA
   manifest's `passed` value separate from human mechanical/fabrication sign-off.

### Why there is no automatic 3D capture claim

The [official 3D Preview guide](https://prodocs.easyeda.com/en/pcb/view-preview-3d/)
describes the editor's manual 3D workflow. Current extension documentation also
lists `PCB_RayTracerEngine` methods including `exportImage()` and
`getSceneElements()`, but marks them **BETA**; its documented scene elements
contain an ID, name and transform, **not independently verified body bounds**.
The [official ray-tracing API reference](https://prodocs.easyeda.com/en/api/reference/pro-api.pcb_raytracerengine.html)
does not establish a stable, available 3D capture or per-component height
contract on supported **EasyEDA Pro 3.2.209**. It must not be silently used as a
production feature. Until a compatible stable API is available and validated on
an actual disposable PCB, automatic 3D collision/height/side checks remain
**not available**. Track the missing capability in
[issue #931](https://github.com/oaslananka/easyeda-mcp-pro/issues/931).
