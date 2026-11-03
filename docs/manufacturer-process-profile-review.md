# Manufacturer/process-profile evidence review

The existing read-only `easyeda_pcb_production_review` tool accepts an
optional `manufacturerProfile` in addition to the existing project,
`boardData` and `gateMode` fields. This is an incremental **DFM/DFA/DFT
readiness** review, not a fabrication capability certificate. It does
not introduce a new MCP tool, network service, factory workflow,
export request, manufacturing order, or PCB mutation.

## Source- and version-bound constraints

Each process profile needs a manufacturer name, specific process,
revision/version and source reference. These are **caller-declared
and not verified against a factory's current price/technology tier**.
Do not reuse a profile from another factory, assembly process, or
PCB technology without confirming the actual chosen process.

```json
{
  "projectId": "a-focused-pcb-uuid",
  "gateMode": "block",
  "boardData": {
    "widthMm": 60,
    "heightMm": 40,
    "minDrillMm": 0.25,
    "fiducialCount": 2,
    "toolingHoleCount": 0,
    "criticalNetNames": ["GND", "3V3", "RESET"],
    "testPointNets": ["GND", "3V3"]
  },
  "manufacturerProfile": {
    "manufacturer": "Example only - hypothetical fab",
    "process": "Example standard assembly",
    "revision": "sample-2026-A",
    "source": "Illustrative, not an actual manufacturer datasheet",
    "limits": {
      "minimumFinishedDrillMm": 0.3,
      "maximumBoardWidthMm": 100,
      "minimumFiducialCount": 3,
      "minimumToolingHoleCount": 2,
      "minimumCriticalNetTestpointRatio": 0.8
    }
  }
}
```

**All example numerical thresholds above are hypothetical**; no
universal manufacturing limits are implied. The `limits` object must
contain at least one actual requirement. The supported comparisons
use millimetres for dimensions, counts for fiducials/tooling holes,
and fractions from 0 to 1 for marking/test coverage.

Available comparisons include:

- Finished/mechanical minimum drill, minimum annular ring, minimum
  solder-mask web, and minimum copper-to-board-edge separation.
- Maximum supported board width and height.
- Minimum reported fiducial and tooling-hole counts.
- Ratio of marked polarized components and ratio of explicitly
  identified critical nets that have named test points.
- Explicit programming header requirement.

These are **declared board summary metrics**. They do not establish
correctness of every drill, pad, trace, net, footprint, pick-and-place
orientation or physical assembly access.

## Provenance and result interpretation

When `boardData` is provided, the evidence class is
`caller_supplied_unverified`. Otherwise the tool reuses the existing
four native board-summary read calls, resulting in
`native_partial_unverified`. Native dimensional data and a minimum
observed drill can be available; native mounting-hole classification,
complete tooling/fiducial/testpoint inventories and fabrication
package review are **not inferred** from drilled-pad counts.

The optional `manufacturing_profile_review` returns per-metric
reported values, declared bounds, units, input field, comparison,
source identity, a list of unsupported workflows, and
`fabrication_approval: false`.

- `BELOW_DECLARED_LIMIT` or `ABOVE_DECLARED_LIMIT` yields `WARNING`
  when a finite reported metric conflicts with the declared limit.
- `WITHIN_DECLARED_LIMIT` still yields **UNKNOWN** overall for
  manufacture approval; numbers and profile validity remain
  independently unverified.
- `UNKNOWN` means the measurement, relevant inventory, or process
  detail is missing/ambiguous. It never means zero or proven absence.

When a profile is supplied, the top-level production `passed` cannot
become a manufacturing readiness pass; in `gateMode: "block"` it is
blocked pending review. Existing production review behavior and
fields are preserved when no profile is supplied. This additional
result distinguishes requested process constraints from generic
repository engineering advisories or EasyEDA editor DRC results.

## Remaining evidence and user review

Do not claim complete board pass unless actual geometry,
manufacturer-qualified copper trace/space, drill/annular ring,
solder mask, silkscreen, courtyard and assembly-side tolerances
are available, including component placement and actual rotation
with the chosen package. Testpoint physical accessibility,
programming pins, fiducials, tooling holes, polarity, BOM-to-MPN
package/footprint mapping, pick-and-place and manufacturing outputs
need direct source-bound checks.

A real EasyEDA Pro read-only disposable PCB acceptance must record
the exact editor and extension versions, focused project, native
method/response, evidence source and measurement units. Model
guesses or mocked fixtures are not live acceptance. Do not create
supplier orders or send manufacturing data as part of this review.
