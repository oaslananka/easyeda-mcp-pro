# PCB Constraints

Constraint-driven validation for PCB board designs.

## Overview

The PCB constraints module validates a PCB design against 23 board, fabrication, assembly, and testability rules. It operates on a decoupled input type (`PcbConstraintInput`) that can be fed from CircuitIR, the EasyEDA bridge, or test fixtures.

The module supports two primary operations:

- **`validatePcbConstraints()`** — run all 23 rules against board data and produce structured errors/warnings
- **`buildConstraintReport()`** — build a human-readable report from validation results, listing which constraints were checked and which require manual review

## Validation Model

Every `validatePcbConstraints()` call returns a `PcbConstraintResult`:

```
{
  valid: boolean;             // true → zero errors (warnings allowed)
  errors: PcbConstraintIssue[];    // blocking issues
  warnings: PcbConstraintIssue[];  // advisory issues
  summary: {
    totalChecks: number;       // total rules evaluated
    passed: number;            // rules that produced no issues
    failed: number;            // issues found (errors + warnings)
    notApplicable: number;     // rules that were skipped
  };
}
```

Each `PcbConstraintIssue` contains:

| Field             | Type                   | Description                         |
| ----------------- | ---------------------- | ----------------------------------- |
| `code`            | `PcbConstraintCode`    | Machine-readable error code         |
| `message`         | `string`               | Human-readable description          |
| `severity`        | `'error' \| 'warning'` | Blocks validation or is advisory    |
| `path`            | `string?`              | Dot-notation path to offending data |
| `constraintType`  | `string?`              | Type of constraint violated         |
| `remediationHint` | `string`               | Actionable fix suggestion           |
| `details`         | `Record?`              | Additional structured context       |

## Rules

### 1. Missing Board Outline (error)

**Severity:** error
**Detects:** Board outline polygon is not defined.

```text
Board outline is not defined
→ Define a board outline with at least 3 polygon points
```

### 2. Board Outline Too Small (warning)

**Severity:** warning
**Detects:** Board width or height below 5 mm.

```text
Board width (3mm) is below recommended minimum of 5mm
→ Verify the board dimensions are correct
```

### 3. Missing Layer Stackup (warning)

**Severity:** warning
**Detects:** No detailed layer stackup defined.

```text
Detailed layer stackup is not defined
→ Define a layer stackup with thickness, material, and copper weight for each layer
```

### 4. Layer Count Mismatch (error)

**Severity:** error
**Detects:** Board has more than 2 layers but no detailed stackup defined.

```text
Board has 4 layers but no detailed stackup is defined
→ For boards with more than 2 layers, a complete layer stackup is required
```

### 5. Missing Mounting Holes (warning)

**Severity:** warning
**Detects:** Zero mounting holes defined.

```text
No mounting holes defined on the board
→ Add at least 4 mounting holes (one near each corner)
```

### 6. Missing Net Classes (warning)

**Severity:** warning
**Detects:** No net classes with routing rules defined.

```text
No net classes with routing rules are defined
→ Define net classes for power, signal, and high-speed nets
```

### 7. Invalid Clearance (warning)

**Severity:** warning
**Detects:** Net classes defined but no clearance rules between them.

```text
Net classes are defined but no clearance rules between them
→ Add clearance rules between each pair of net classes
```

### 8. Keepout Violations (warning)

**Severity:** warning
**Detects:** Placement zones defined but no keepout/restricted areas.

```text
Placement zones are defined but no keepout/restricted areas
→ Consider adding keepout areas to prevent component or track placement in restricted zones
```

### 9. Missing Placement Zones (warning)

**Severity:** warning
**Detects:** Multi-layer board without placement zones.

```text
No placement zones defined for component grouping
→ Define placement zones (power, analog, digital, etc.)
```

### 10. Missing Manufacturing Constraints (warning)

**Severity:** warning
**Detects:** Manufacturing process or production quantity not specified.

```text
Manufacturing process (lead-free/lead-based) is not specified
→ Specify the manufacturing process and target production quantity
```

### 11. Fiducials Recommended (warning)

**Severity:** warning
**Detects:** Board with mounting holes but no fiducial marks.

```text
No fiducial marks defined for SMT assembly
→ Add at least 3 fiducial marks for pick-and-place alignment
```

### 12. High-Voltage Clearance (error)

**Severity:** error
**Detects:** High-voltage domain without clearance/net-class rules.

```text
High-voltage domain detected but no clearance rules defined
→ Define explicit creepage and clearance distances for high-voltage nets
```

### 13. Drill File Missing (error)

**Severity:** error
**Detects:** Manufacturing package lacks NC drill / Excellon drill output.

### 14. Copper-to-Edge Clearance (error)

**Severity:** error
**Detects:** Copper, vias, pads, or zones too close to the routed board edge.
Default recommendation: at least `0.25mm` copper-to-edge clearance.

### 15. Drill / Annular Ring Risk (warning)

**Severity:** warning
**Detects:** Minimum drill below `0.20mm` or annular ring below `0.10mm`.

### 16. Soldermask Sliver (warning)

**Severity:** warning
**Detects:** Soldermask web/sliver below `0.10mm` or explicit sliver violations.

### 17. Silkscreen Over Pad (warning)

**Severity:** warning
**Detects:** Silkscreen text/graphics overlapping exposed copper pads.

### 18. Tooling Holes (warning)

**Severity:** warning
**Detects:** SMT assembly data present but fewer than two tooling holes are declared.

### 19. Polarity / Orientation Marks (warning)

**Severity:** warning
**Detects:** Polarized or orientation-sensitive components without matching polarity marks.

### 20. Component Spacing / Courtyard (warning)

**Severity:** warning
**Detects:** Component spacing or courtyard violations that can affect placement, soldering, or rework.

### 21. Testpoint Coverage (warning)

**Severity:** warning
**Detects:** Critical nets missing accessible test pads. Default minimum coverage is `80%`.

### 22. Programming Header Missing (error)

**Severity:** error
**Detects:** A design marked as requiring programming/debug access without a programming header or equivalent pads.

### 23. Fabrication Notes Missing (warning)

**Severity:** warning
**Detects:** Missing fabrication notes for thickness, copper weight, finish, soldermask, impedance, panelization, or special instructions.

## Error Codes

| Code                                    | Severity | Rule # |
| --------------------------------------- | -------- | ------ |
| `PCB_MISSING_OUTLINE`                   | error    | 1      |
| `PCB_OUTLINE_TOO_SMALL`                 | warning  | 2      |
| `PCB_MISSING_STACKUP`                   | warning  | 3      |
| `PCB_LAYER_COUNT_MISMATCH`              | error    | 4      |
| `PCB_MISSING_MOUNTING_HOLES`            | warning  | 5      |
| `PCB_MISSING_NET_CLASSES`               | warning  | 6      |
| `PCB_INVALID_CLEARANCE`                 | warning  | 7      |
| `PCB_KEEPOUT_VIOLATION`                 | warning  | 8      |
| `PCB_MISSING_PLACEMENT_ZONES`           | warning  | 9      |
| `PCB_MISSING_MANUFACTURING_CONSTRAINTS` | warning  | 10     |
| `PCB_FIDUCIAL_REQUIRED`                 | warning  | 11     |
| `PCB_HIGH_VOLTAGE_CLEARANCE`            | error    | 12     |
| `PCB_DRILL_FILE_MISSING`                | error    | 13     |
| `PCB_COPPER_EDGE_CLEARANCE`             | error    | 14     |
| `PCB_DRILL_TOO_SMALL`                   | warning  | 15     |
| `PCB_ANNULAR_RING_TOO_SMALL`            | warning  | 15     |
| `PCB_SOLDERMASK_SLIVER`                 | warning  | 16     |
| `PCB_SILKSCREEN_OVER_PAD`               | warning  | 17     |
| `PCB_TOOLING_HOLE_MISSING`              | warning  | 18     |
| `PCB_POLARITY_MARK_MISSING`             | warning  | 19     |
| `PCB_COMPONENT_SPACING_VIOLATION`       | warning  | 20     |
| `PCB_TESTPOINT_COVERAGE_LOW`            | warning  | 21     |

Polarity-mark inventory counts must be internally consistent: when
`polarityMarkCount` exceeds `polarizedComponentCount`, even if the
latter is zero, the polarity check is `UNKNOWN` rather than an invented
coverage pass. A lower mark count continues to raise
`PCB_POLARITY_MARK_MISSING`. Equal counts are only a _caller-reported
count comparison_; individual components, pin-1 markings, actual
silkscreen visibility and assembly readability remain unverified.

The critical-net testpoint check compares exact declared net identities:
`IO` and `io` are **not** assumed to share electrical connectivity.
Blank or whitespace-padded names and duplicated/case-colliding critical
net inventories produce `UNKNOWN` in `unknownChecks` instead of a
fabricated coverage pass or a guessed missing-net warning. Repeated
testpoint observations on a single exact net count only once. The
result remains a declared-name comparison, not proof of probe
accessibility or fabrication readiness.

| `PCB_PROGRAMMING_HEADER_MISSING` | error | 22 |
| `PCB_FAB_NOTES_MISSING` | warning | 23 |

## Usage

### Basic validation

```typescript
import { validatePcbConstraints } from './pcb-constraints/index.js';

const result = validatePcbConstraints({
  widthMm: 60,
  heightMm: 40,
  layerCount: 2,
  hasOutline: true,
  mountingHoleCount: 4,
  hasLayerStack: true,
  hasNetClasses: true,
  hasClearanceRules: true,
  hasKeepoutAreas: true,
  hasPlacementZones: true,
  hasFiducials: true,
  hasTestPads: true,
  hasHighVoltage: false,
  manufacturingProcess: 'standard',
  hasQuantity: true,
});

if (!result.valid) {
  for (const err of result.errors) {
    console.error(`[${err.code}] ${err.message}`);
    console.error(`  → Fix: ${err.remediationHint}`);
  }
}
```

### Production review data

Production review fields are optional and only fire when the corresponding data is present.
This lets live board probes, CircuitIR, or export manifests progressively add more manufacturing detail without creating false positives on simple board snapshots.

```typescript
const result = validatePcbConstraints({
  widthMm: 60,
  heightMm: 40,
  layerCount: 2,
  hasOutline: true,
  hasLayerStack: true,
  hasNetClasses: true,
  hasClearanceRules: true,
  hasDrillFile: true,
  minCopperToEdgeMm: 0.35,
  minDrillMm: 0.3,
  minAnnularRingMm: 0.15,
  minSolderMaskSliverMm: 0.12,
  smtComponentCount: 12,
  fiducialCount: 3,
  toolingHoleCount: 2,
  polarizedComponentCount: 4,
  polarityMarkCount: 4,
  criticalNetNames: ['GND', '3V3', 'RESET', 'SWDIO', 'SWCLK'],
  testPointNets: ['GND', '3V3', 'RESET', 'SWDIO', 'SWCLK'],
  requiresProgrammingHeader: true,
  hasProgrammingHeader: true,
  hasFabricationNotes: true,
});
```

The MCP tool `easyeda_pcb_production_review` exposes the same review model to agents.
`easyeda_export_gerbers` can also run the same review as an optional gate:

- `mode: 'warn'` returns production findings but still exports.
- `mode: 'block'` stops Gerber export when production errors exist.
- `mode: 'off'` preserves the legacy export behavior.

### Constraint Reports

Use `buildConstraintReport()` to generate a structured report:

```typescript
import { validatePcbConstraints, buildConstraintReport } from './pcb-constraints/index.js';

const result = validatePcbConstraints(input);
const report = buildConstraintReport(input, result);

console.log(`Verdict: ${report.verdict}`); // 'approved' | 'needs-review' | 'rejected'
console.log(`Manual review items: ${report.manualReviewRequired.length}`);
```

### Converting from PcbIntent

```typescript
import { fromPcbIntent } from './pcb-constraints/index.js';
import type { PcbIntent } from '../circuit/types.js';

const input = fromPcbIntent(pcbIntent);
const result = validatePcbConstraints(input);
```

## Integration with CircuitIR

The PCB constraint input is decoupled from CircuitIR types. Use `fromPcbIntent()` to convert a CircuitIR PCB intent object:

```typescript
import { fromPcbIntent } from './pcb-constraints/index.js';
import type { PcbIntent } from '../circuit/types.js';

function validatePcbFromIntent(pcb: PcbIntent) {
  return validatePcbConstraints(fromPcbIntent(pcb));
}
```

The converter handles:

- `boardOutline` → `hasOutline` (truthy check with empty-array guard)
- `layerCount` → `layerCount` (passed directly)
- `layerStack` → `hasLayerStack` (non-empty array check)
- `netClasses`, `clearanceRules`, `keepoutAreas`, `placementZones` → boolean presence flags
- `mountingHoles` → `mountingHoleCount` (array length, defaults to 0)
- `fiducials`, `testPads` → boolean presence flags
- `highVoltage` → `hasHighVoltage` (defaults to false)
- `manufacturingProcess` + `manufacturing.process` → `manufacturingProcess`
- `quantity` + `manufacturing.quantity` → `hasQuantity`
- production review fields such as drill, copper-to-edge, soldermask, silkscreen, fiducials, tooling holes, test points, programming header, and fabrication notes are passed through directly

## API Reference

### `validatePcbConstraints(input: PcbConstraintInput): PcbConstraintResult`

Run all 23 validation rules against board data. Returns errors and warnings.

### `buildConstraintReport(input: PcbConstraintInput, result: PcbConstraintResult): ConstraintReport`

Build a structured report from validation results. Includes:

- `checked` — list of areas that were verified
- `manualReviewRequired` — items requiring human review
- `verdict` — `'approved'`, `'needs-review'`, or `'rejected'`

### `fromPcbIntent(pcb: object): PcbConstraintInput`

Convert a CircuitIR PCB intent object to `PcbConstraintInput`.

### Factory helpers

- `pcbConstraintIssue(code, message, opts?)` — create an issue
- `pcbError(code, message, opts?)` — create an error-severity issue
- `pcbWarning(code, message, opts?)` — create a warning-severity issue

## File Structure

```
src/pcb-constraints/
├── types.ts         — PcbConstraintInput, PcbConstraintIssue, ConstraintReport types
├── errors.ts        — Error code map, issue interface, factory helpers
├── validation.ts    — 12 validation rules, entry points, report builder
└── index.ts         — Barrel exports

tests/unit/pcb-constraints/
└── pcb-constraints.test.ts  — Unit tests covering all rules, report, and conversion
```

## MCP Tools

Two MCP tools are registered in the `pcb-constraints` group:

- `easyeda_pcb_constraint_check` — Run PCB constraint validation and return structured results with errors, warnings, and summary
- `easyeda_pcb_constraint_report` — Run validation and produce a human-readable constraint report with verdict and manual review items

Both tools accept a `PcbConstraintInput` object and are available in all profiles.
