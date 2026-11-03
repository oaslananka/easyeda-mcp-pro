# Source-scoped isolation, clearance, creepage and EMC/ESD review

The existing read-only `easyeda_design_rules_lookup` MCP tool accepts
`topic: "isolation-emc-review"` with a nested `review` object. This
adds **no new tool or active EasyEDA read/write operation**. It is a
declaration-based preliminary engineering review, not a safety
standard interpreter, IEC/IPC numerical-table implementation, an
EMC simulator or a substitute for an actual physical PCB acceptance.

## Why air clearance and surface creepage must be separate

- **Clearance** is the shortest distance through **air** between
  conductive parts. Its relevant context can include peak/transient
  overvoltage, insulation purpose, altitude and environment.
- **Creepage** is the shortest distance **along an insulating
  surface**. It depends on operating voltage, contamination/pollution
  environment, material characteristics, the actual surface path and
  potential interruptions. An XY centerline gap or a through-air
  separation is **not** automatically a creepage measurement.
- Coatings, slots, cutouts, barriers and encapsulation cannot be
  treated as automatic safety-distance reductions. Their genuine
  effectiveness and permitted applicability need source-specific
  physical evidence and qualified judgment.

To determine applicability for safety work, supply the relevant
working and transient/impulse voltages, insulation purpose
(`functional`, `basic`, `supplementary`, `reinforced`), pollution
degree, overvoltage category, insulating material group/CTI,
environment including condensation risk, altitude, and the actual
applicable standard identifier/edition/clause.

For a source-declared comparison, specify the separate `minimumMm`
for each spacing type and the corresponding standard/engineering
reference. **There is no hard-coded universal minimum**. The
manufacturer, safety standard and fabricator requirements must be
verified separately against the exact design and current edition.
Only provide a clearance observation with
`evidenceKind: "measured_air_gap"`, and creepage with
`evidenceKind: "measured_surface_path"`. An `estimated` value stays
**UNKNOWN** even when the number appears below a claimed limit.

The following is a deliberately **hypothetical** example. The 3 mm
figure is a caller-supplied sample, **not** a value quoted from IEC:

```json
{
  "topic": "isolation-emc-review",
  "review": {
    "purpose": "basic",
    "workingVoltageV": 230,
    "transientVoltageV": 2500,
    "environment": "industrial",
    "pollutionDegree": 2,
    "overvoltageCategory": "II",
    "materialGroup": "IIIa",
    "altitudeM": 1000,
    "safetyStandard": {
      "identifier": "IEC 60664-1",
      "edition": "2020+AMD1:2025",
      "clause": "Confirm actual applicable section before safety review",
      "source": "https://webstore.iec.ch/en/publication/107319"
    },
    "clearanceRequirement": {
      "minimumMm": 3,
      "reference": {
        "identifier": "IEC 60664-1",
        "edition": "2020+AMD1:2025",
        "clause": "Hypothetical sample, not a standard-table number",
        "source": "Example engineering declaration only"
      }
    },
    "airClearance": {
      "distanceMm": 2,
      "evidenceRef": "Unverified measurement from a disposable PCB",
      "evidenceKind": "measured_air_gap"
    }
  }
}
```

The result is a **WARNING** about an internal conflict between the
claimed minimum and claimed measurement, not an independently
verified IEC violation. Even when all reported distances meet
declared minima, the overall result is **UNKNOWN**; safety
certification and engineering sign-off are always `false`.
Missing applicability context is itemized. Safety-relevant
insulation classes require qualified engineering review.

## ESD entry and EMC/return paths

The optional `esdEntry` accepts a connector reference, ESD protector
reference, entry net and an explicit return-path evidence reference.
The optional `emcReturn` records the named fast-current loop,
reference/return evidence and sensitive circuit. **Both remain
UNKNOWN**, regardless of whether all names are supplied, because
this tool has no verified native copper/pad/plane topology or
laboratory results.

IEC 61000-4-2:2025 describes **ESD immunity tests and measurement
methods**, not a blanket rule that selecting a TVS or placing a
connector nearby proves immunity. The test-standard identifier,
edition and source may be recorded for an ESD case, but do not
constitute measured test results.

## Primary edition references (metadata only)

- [IEC 60664-1:2020+AMD1:2025, edition 3.1](https://webstore.iec.ch/en/publication/107319):
  insulation coordination with separate air clearance and surface
  creepage considerations; applicability must be determined.
- [IPC-2221C, revision C (2023)](https://ipcstandards.com/product/10082/ipc-2221):
  generic printed-board design guidance; not a universal
  replacement for the governing product/equipment safety standard.
- [IEC 61000-4-2:2025](https://webstore.iec.ch/en/publication/68954):
  ESD immunity testing and measurement methods.
- [IEC 62368-1:2023, edition 4.0](https://webstore.iec.ch/en/publication/69308):
  equipment-class-specific safety requirements when applicable.

Only standard identifiers, editions and public abstracts are
referenced. No copyrighted electrical spacing tables or proprietary
requirements are embedded in the repository.

## Acceptance constraints

Test ordinary low-voltage boards, a declared shortfall in air
clearance, a separate creepage shortfall, estimated rather than
measured geometry, connector ESD return limitations, high-consequence
insulation requiring qualified review, and slot/coating limitations.
The deterministic fixtures exercise only software behavior.

For actual live board acceptance, verify the connected EasyEDA
editor/extension version, exact PCB, conductor/pad/plane geometry,
material and fabricator constraints, applicable standard edition
and appropriate measurement evidence. Product safety certification,
conducted/radiated emissions and ESD immunity cannot be issued by
the model or this tool.
