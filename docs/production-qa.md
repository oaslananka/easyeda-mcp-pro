# Production QA Artifacts

Production QA artifacts extend a manufacturing handoff package with test, assembly, and bring-up documentation.

## Tool

```text
easyeda_production_qa_artifacts
```

The tool is read-only. It generates Markdown and JSON artifacts from board metadata and does not call the EasyEDA bridge.

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
