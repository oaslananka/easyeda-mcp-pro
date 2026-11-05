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
- Maximum supported board width and height. If the board outline is
  explicitly absent (`hasOutline: false`), reported canvas dimensions
  cannot establish a manufactured board size and those comparisons
  remain `UNKNOWN` even when width/height are finite. For native partial
  reads, **missing outline evidence** (`hasOutline` not `true`) also
  leaves dimensions `UNKNOWN`; a native canvas extent is not a verified
  fabricated-board dimension. Caller-supplied dimensions retain their
  declared comparison semantics without implying fabrication approval.
- Minimum reported fiducial and tooling-hole counts.
- Ratio of marked polarized components and ratio of explicitly
  identified critical nets that have named test points. Test-point
  coverage uses **exact declared net names**: `IO` is not automatically
  the same net as `io`. Blank or whitespace-padded names and ambiguous
  duplicate critical-net inventories yield `UNKNOWN` instead of
  fabricated test coverage. Repeated test points on the same exact net
  can contribute only once.
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
`fabrication_approval: false`. Each individual finding also carries
`profile_reference` and `profile_revision` from the caller-declared
manufacturer profile, plus `measurement_evidence`:
`caller_supplied_unverified`, `native_partial_unverified` or
`unavailable` for missing/invalid individual measurements. These values
track provenance **without authenticating** any process limits or native
fabrication readiness.

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

## Representative source-bound, read-only PCB acceptance

On 5 November 2026, a focused disposable EasyEDA Pro Web 3.2.209 PCB
was queried using extension 1.9.0 without any design mutation,
save, export or native DRC/ ERC operation. Its native summary exposed
an outlined board measuring **21.59 × 16.51 mm**, with an observed
minimum drill of **1.1 mm**. Its detailed layer stackup remained
unavailable even though a two-layer count was reported.

The existing `easyeda_pcb_production_review` tool was run **without
caller-supplied board data** against a clearly **hypothetical**, not
manufacturer-authenticated profile: maximum width 20 mm, maximum
height 18 mm and minimum drill 0.8 mm, plus unobservable annular ring,
test-point coverage and programming access limits. The native width
comparison produced `WARNING`; the height and drill values produced
`WITHIN_DECLARED_LIMIT` comparisons whose status is still `UNKNOWN`.
Metrics missing from the native reader remained `UNKNOWN` without a
fabricated `actual` value. `gateMode: block` returned `blocked: true`
and `fabrication_approval: false`.

The sanitized [read-only acceptance evidence](./evidence/easyeda-live/2026-11-05-easyeda-3.2.209-v1.9.0-native-846-production-review.json)
records units, individual source fields, declared profile revision and
missing data. **These example limits are not the real capabilities of
any fab; this test is not permission to order boards or proof of
fabrication readiness.**

## Source-bound read-only PCB placement inventory

A separate 5 November 2026 EasyEDA Pro Web 3.2.209 read of the
same disposable fixture PCB used the existing `pcb.listComponents`
reader, with the focused PCB and project identity independently
matched. All **3/3 PCB components** had distinct native primitive
IDs, named footprints, footprint UUIDs, finite native coordinates and
rotations, with raw layer code **1**. The [sanitized assembly inventory](./evidence/easyeda-live/2026-11-05-easyeda-3.2.209-v1.9.0-native-846-assembly-inventory.json)
records aggregate observations, not private coordinates or project
identifiers.

This observation establishes available assembly _metadata_, not
pick-and-place output, source-matched BOM-to-PCB MPN/package validity,
side/rotation convention, courtyard geometry or nozzle/rework access.
The prior BOM and PCB reads were not one atomic design snapshot, so
the full BOM/footprint join remains **UNKNOWN**. No manufacturing or
assembly sign-off was performed.

## Representative BOM–PCB footprint identity reconciliation

A separate source-bound, read-only comparison on 5 November 2026
matched a focused disposable EasyEDA Pro Web 3.2.209 PCB component
inventory to the same project's schematic native component list and
the updated 1.9.0 `bom.generate` output. All **3/3** references,
schematic/BOM footprint names, schematic/PCB footprint names,
BOM/PCB footprint names and source-observed native manufacturer IDs
versus BOM MPNs matched; no unmatched PCB-only reference was found.

The [sanitized comparison evidence](./evidence/easyeda-live/2026-11-05-easyeda-3.2.209-v1.9.0-native-846-bom-pcb-footprint-join.json)
records the different baked dispatcher fingerprints, exact project
focus checks, match counts and missing guarantees. The PCB and
schematic reads were **not atomic**; a final PCB recheck was
inconclusive because the Bridge connected to a non-PCB-focused
browser session. Do **not** interpret the name matches as
revision-stable assembly consistency, physical package/footprint
compatibility, pick-and-place accuracy, verified supplier MPN
authenticity or manufacturing approval.

## Read-only native footprint declaration comparison

On 5 November 2026 a focused disposable EasyEDA Pro Web 3.2.209 PCB
was checked against optional, explicitly sourced `firstFootprintName`
and `secondFootprintName` declarations in the existing read-only
`easyeda_pcb_route_geometry_review` placement relationship input.
The observed native component collection was complete (3 items).
A comparison against test-only names copied from the source returned
`UNKNOWN`; an intentionally incorrect second expected name returned
`WARNING`, without any approval or design mutation.

The [sanitized source-bound acceptance](./evidence/easyeda-live/2026-11-05-easyeda-3.2.209-v1.9.0-native-846-footprint-declaration-review.json)
does not expose the original part numbers, designators, project
identifiers or footprint names. Its expectation was **synthetic,
not a manufacturer datasheet requirement**. This checks only exact
footprint-name equality, not pad dimensions, physical package,
assembly side, pick-and-place orientation or manufacturer capability.
Missing native identity remains `UNKNOWN`.

## Remaining evidence and user review

Do not claim complete board pass unless actual geometry,
manufacturer-qualified copper trace/space, drill/annular ring,
solder mask, silkscreen, courtyard and assembly-side tolerances
are available, including component placement and actual rotation
with the chosen package. Testpoint physical accessibility,
programming pins, fiducials, tooling holes, polarity, BOM-to-MPN
package/footprint mapping, pick-and-place and manufacturing outputs
need direct source-bound checks. The `bom.generate` read-only route now
preserves a source-observed `manufacturerId` as the BOM `mpn`
field and keeps differently identified MPN, manufacturer, LCSC,
footprint and value combinations as **separate BOM lines**, even when
the requested display grouping is `value`, `lcsc` or `footprint`.
The `easyeda_bom_quality_report` carries that MPN into sourcing
assessment. An observed **manufacturer name alone is not an MPN**
and must not suppress missing-part-number review. This protects
identity only: no supplier/catalog mapping, package compatibility
or physical assembly readiness is authenticated by BOM grouping.

### BOM MPN source-preservation acceptance

On 5 November 2026, the original installed EasyEDA Pro Web 3.2.209
extension (1.9.0, baked dispatcher `de7e9xc35bx92a6`) exposed
**three source-native manufacturer IDs** in the focused disposable
schematic component inventory but **zero MPNs** in its three generated
BOM entries. The verified local 1.9.0 package was then imported
through EasyEDA's Extensions Manager and a **new editor test tab**
loaded the exact `d7db8xef8bx53c6` dispatcher. The same
source-matched schematic now yielded **three MPN-bearing BOM rows
out of three**, with the native references, quantities and footprint
identities consistent. The server's read-only
`easyeda_bom_generate` tool also returned three entries and
**three MPNs**, with total quantity three.

The sanitized [native BOM acceptance evidence](./evidence/easyeda-live/2026-11-05-easyeda-3.2.209-v1.9.0-native-846-bom-mpn.json)
records both dispatcher IDs, the verified local package hash, result
counts and limitations without publishing the project's document IDs
or actual MPN values. The fixture has **distinct** component values,
so grouping conflicts involving _equal_ values and _different_
MPNs/footprints remain **automated-test evidence**, not live
acceptance. Neither supplier MPN authenticity nor assembly readiness
is established. Existing open editor tabs may still use their
earlier loaded dispatcher until restarted.

A real EasyEDA Pro read-only disposable PCB acceptance must record
the exact editor and extension versions, focused project, native
method/response, evidence source and measurement units. Model
guesses or mocked fixtures are not live acceptance. Do not create
supplier orders or send manufacturing data as part of this review.
