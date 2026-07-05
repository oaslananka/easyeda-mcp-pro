# CircuitIR & DesignIntent

## Overview

This document describes the **Circuit Intermediate Representation (CircuitIR)** and **DesignIntent** schema system used by easyeda-mcp-pro to model electronic designs in a structured, validated, and machine-readable format.

### Why two models?

| Model            | Purpose                                                       | Who writes it                                    | Status                      |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| **DesignIntent** | High-level user requirements — _what_ the user wants to build | User or AI prompt                                | Free-form, validated        |
| **CircuitIR**    | Resolved, validated circuit model — _how_ it will be built    | Compiled from DesignIntent, or authored directly | Machine-verified, versioned |

The separation ensures that **user intent** (DesignIntent) is preserved as an audit trail, while **machine operations** (CircuitIR) work from a validated source of truth.

## DesignIntent

A DesignIntent captures the user's high-level requirements:

- Project name, goal, and board type
- Required functional blocks
- Electrical requirements (voltage, current, frequency)
- Power rail definitions (voltage, tolerance, current)
- Mechanical constraints (dimensions, layers, mounting)
- Manufacturing intent (volume, process, timeline)
- Safety/regulatory notes
- Explicit assumptions and acknowledged unknowns

### Schema

`schema: design-intent/v1`

```typescript
interface DesignIntent {
  $schema: 'design-intent/v1';
  project: {
    name: string; // e.g. "ESP32-S3 Sensor Board"
    goal: string; // natural language design goal
    boardType: BoardType; // power-supply | mcu-board | sensor-board | ac-dc-iot | hierarchical | custom
  };
  requirements: {
    functionalBlocks: FunctionalBlockReq[];
    electrical: { vinMin?; vinMax?; currentMaxAmps?; frequencyMaxHz?; notes? };
    power: { rails: PowerRailReq[] }; // at least one rail required
    mechanical: { widthMm?; heightMm?; layers?; mountingHoles?; notes? };
    manufacturing: { volume?; process?; timelineWeeks?; notes? };
    safety: { isolation?; certifications?; regulatory? };
  };
  assumptions: string[];
  unknowns: string[];
}
```

### Validation rules

- At least one functional block is required
- At least one power rail is required
- Project name must be non-empty
- Board type must be a valid `BoardType` enum value
- Extra fields are rejected via `strict()` mode

## CircuitIR

CircuitIR is the **validated, machine-readable source of truth** for downstream EasyEDA operations. It is produced by compiling a DesignIntent, but can also be authored or edited directly for advanced use cases.

`schema: circuit-ir/v1`

### Core node types

| Node                    | Description              | Key fields                                                                                |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| **Block**               | Functional subsystem     | `id`, `name`, `type`, `description`, `designIntentRef[]`, `children[]`                    |
| **Device**              | Component instance       | `id`, `ref`, `mpn`, `package`, `blockRef`, `designIntentRef[]`                            |
| **Net**                 | Electrical connection    | `id`, `name`, `type` (power/signal/ground), `nodes[]`, `blockRef`                         |
| **Rail**                | Power rail               | `id`, `name`, `voltage`, `tolerance`, `maxCurrent`, `sourceBlockRef`, `sinkBlockRefs[]`   |
| **PowerDomain**         | Voltage/current domain   | `id`, `name`, `nominalVoltage`, `railRefs[]`, `sourceRailRef`, `loadDeviceRefs[]`         |
| **SignalClass**         | Routing/electrical class | `id`, `name`, `kind`, `netNames[]`, `differentialPair`, `routing`                         |
| **PhysicalConstraint**  | Physical/layout rule     | `id`, `type`, `targetType`, `targetRef`, `description`, `minClearanceMm`, `preferredSide` |
| **Interface**           | External connector       | `id`, `name`, `type`, `pinout[]`, `blockRef`                                              |
| **Constraint**          | Design rule              | `id`, `type`, `severity`, `description`, `scope`                                          |
| **BOMIntent**           | BOM requirements         | `excludeRefs[]`, `preferredVendors[]`, `costTargetUsd`                                    |
| **PCBIntent**           | PCB constraints          | `layerCount`, `stackup`, `widthMm`, `heightMm`, `material`                                |
| **ManufacturingIntent** | Fab/assembly             | `quantity`, `process`, `timelineWeeks`                                                    |

### Cross-reference validation

CircuitIR enforces referential integrity:

- Every `NetNode.deviceRef` must reference a valid `Device.id`
- Every `Device.blockRef` must reference a valid `Block.id`
- Every `Device.powerDomainRef` must reference a valid `PowerDomain.id`
- Every `PowerDomain.railRefs[]` and `sourceRailRef` must reference valid `Rail.id` values
- Every `PowerDomain.loadDeviceRefs[]` item must reference a valid `Device.id`
- Every `Net.signalClassRef`, `Net.powerDomainRef`, and `Net.railRef` must resolve to known classes/domains/rails
- Every `SignalClass.netNames[]` and differential pair net must reference known `Net.name` values
- Every `PhysicalConstraint.targetRef` must resolve to the requested target type, except board-level constraints
- All IDs must be unique within their type

### Power domains, signal classes, and physical constraints

The expanded CircuitIR model lets an agent reason about professional electronics concerns before writing to EasyEDA:

- `powerDomains[]` groups rails, loads, nominal voltage, current budget, and isolation policy.
- `signalClasses[]` groups nets by electrical/routing behavior such as analog, digital, USB, RF, sensitive, high-speed, or differential.
- `physicalConstraints[]` expresses placement, clearance, creepage, height, thermal, keepout, accessibility, and testability requirements.

These objects are intentionally references, not EasyEDA primitives. They give the planner and rule engine enough structure to derive safe schematic, PCB, BOM, and manufacturing actions.

### Validation lifecycle

```
Draft → Validated → (consumed by EasyEDA tools)
Draft → Rejected   → (returned for revision)
```

## Compile Flow: DesignIntent → CircuitIR

```
User/AI ──► DesignIntent ──► Validate ──► Compile ──► CircuitIR(draft)
                                                         │
                                                    [Review Gate]
                                                         │
                                              ┌──────────┼──────────┐
                                              ▼          ▼          ▼
                                        Validated    Rejected    Draft
                                              │          │
                                              ▼          ▼
                                        EasyEDA     Return for
                                        Tools       Revision
```

### Compiler steps

1. **Validate** DesignIntent against the schema
2. **Transform** functional block requirements into `Block` nodes
3. **Create** `Rail` nodes from power rail requirements
4. **Plan** one candidate `Device` per block via `component-planning.ts` — a
   deterministic refdes, a component role, and a package-family hint (see
   [Component planning](#component-planning) below)
5. **Generate** `Net` entries for each power rail plus one synthesized
   common-ground `Net`
6. **Synthesize** professional planning context:
   - `powerDomains[]` from rails, with device load/source wiring when
     unambiguous (see [Component planning](#component-planning))
   - `signalClasses[]` from power/electrical intent
   - `physicalConstraints[]` from mechanical and safety intent
   - `interfaces[]` candidate stubs for blocks classified as connectors
7. **Copy** mechanical constraints into `pcb` fields
8. **Copy** manufacturing intent into `manufacturing` fields
9. **Validate** the output CircuitIR (structural + cross-reference checks)
10. Return draft CircuitIR + original DesignIntent + compiler warnings (for traceability)

### Compiler best-practice synthesis

The compiler now creates first-pass electronics planning structures from DesignIntent before any EasyEDA write tool is used:

- each rail becomes a `PowerDomain` with voltage, tolerance, current, rail reference, and traceability;
- power nets are linked to their rail, power domain, and the `sc-power` signal class;
- a synthesized `GND` net models the board's common ground reference;
- high-frequency electrical requirements create a `sc-high-speed` planning class;
- board dimensions, mounting holes, and isolation requirements become physical constraints;
- connector-role blocks get a candidate `Interface` stub (pinout left empty for schematic entry).

These synthesized structures are conservative planning hints. They do not replace human review, ERC/DRC, datasheets, or manufacturing rules; they make those review steps explicit and machine-checkable.

### Component planning

`src/circuit/component-planning.ts` replaces the old generic `U?` device stub
with a deterministic component-role plan for every block:

1. **Role inference** (`determineComponentRole`) — keyword matches on the
   block's purpose text (`connector`/`header`/`usb`/`jack`, `fuse`/`polyfuse`/`ptc`,
   `filter`/`decoupl`/`bypass`) take priority over the coarse `BlockType`
   enum, because a "power-management" block may in practice be a regulator
   _or_ a passive filter stage. Roles: `power-regulator`, `mcu-module`,
   `sensor`, `communication-ic`, `analog-ic`, `connector`, `protection-diode`,
   `fuse`, `passive-support`, `generic-ic`.
2. **Deterministic refdes** — each role maps to a fixed refdes family
   (`U`, `J`, `D`, `F`, `C`; see `ROLE_REFDES_PREFIX`), numbered sequentially
   in block order. Refdes assignment is stable across repeated compiles of
   the same DesignIntent.
3. **Package-family hint** — a conservative footprint _family_ suggestion
   per role (`ROLE_PACKAGE_HINT`), e.g. "SOT-23-5 or TO-220" for a
   regulator. This is not a final footprint selection.
4. **Planning-state marker** — every Device records `role`, `packageHint`,
   and `planningState` (`resolved` when a verified catalog device matched the
   role, `candidate` for a high-confidence role with no catalog match,
   `placeholder` for the `generic-ic` fallback) as `Device.metadata` entries,
   so downstream tooling can tell a manufacturable candidate apart from an
   unclassified placeholder. A compiler warning is emitted for every
   `placeholder` device, and for a `candidate` device when a catalog was
   provided but had no matching role.

By default the compiler does not invent an `mpn`, `manufacturer`, or
`package` value — those fields stay unset until a human, a BOM-sourcing
step, or the verified device catalog resolves a real part. Callers may
optionally pass `planComponents(blocks, { catalog })` with a pre-loaded
device catalog (the starter catalog plus any devices cached by
`easyeda_catalog_verify_device` — see `docs/catalog-ingestion.md`); when a
high-confidence role matches a non-obsolete catalog device,
`mpn`/`manufacturer`/`package`/`lcsc` are filled in from that device and
`planningState` becomes `resolved`. This remains a narrowing/candidate step,
not an ordering step — omitting `catalog` preserves the original behavior.

Device-to-power-domain wiring (`Device.powerDomainRef` and
`PowerDomain.loadDeviceRefs`) is populated automatically only when a design
has exactly one power rail — an unambiguous case. DesignIntent does not
specify which rail a given block operates on, so for multi-rail designs the
compiler emits a warning instead of guessing a possibly-wrong rail
assignment; assign `Device.powerDomainRef` manually during CircuitIR review
in that case.

### Traceability model

Every `Block`, `Device`, `Net`, `Rail`, and `Constraint` carries a `designIntentRef[]` array that links back to one or more DesignIntent requirements:

```typescript
interface DesignIntentRef {
  requirementId: string; // e.g. "req-power-001"
  note?: string; // e.g. "Satisfies 3.3V rail requirement"
}
```

## Review Gate

Downstream EasyEDA **mutation tools** MUST check `isReadyForEasyEDA(circuitIR)` before applying changes. This function returns `true` only when `validationStatus === ValidationStatus.Validated`.

```typescript
import { isReadyForEasyEDA, setValidationStatus } from './circuit/compiler.js';
import { ValidationStatus } from './circuit/types.js';

// After human/AI review:
const validated = setValidationStatus(draftCir, ValidationStatus.Validated);

// Before EasyEDA operations:
if (!isReadyForEasyEDA(validated)) {
  throw new Error('CircuitIR must be validated before EasyEDA operations');
}
```

## Example: 12V-to-3.3V Power Supply Board

### DesignIntent

```json
{
  "$schema": "design-intent/v1",
  "project": {
    "name": "12V-to-3V3 Power Supply",
    "goal": "A regulated 3.3V power supply from a 12V input, delivering 500mA",
    "boardType": "power-supply"
  },
  "requirements": {
    "functionalBlocks": [
      {
        "id": "req-input",
        "name": "Input Protection",
        "type": "protection",
        "purpose": "Reverse polarity and over-current protection on 12V input"
      },
      {
        "id": "req-regulator",
        "name": "Voltage Regulator",
        "type": "power-management",
        "purpose": "12V to 3.3V step-down conversion at 500mA"
      }
    ],
    "power": {
      "rails": [
        { "id": "12V_IN", "voltage": 12.0, "maxCurrentAmps": 1.0 },
        { "id": "3V3_OUT", "voltage": 3.3, "tolerance": 3, "maxCurrentAmps": 0.5 }
      ]
    },
    "mechanical": { "widthMm": 30, "heightMm": 20, "layers": 2 }
  }
}
```

### Compiled CircuitIR (draft)

```json
{
  "$schema": "circuit-ir/v1",
  "metadata": {
    "validationStatus": "draft",
    "designIntentRef": "12V-to-3V3 Power Supply"
  },
  "blocks": [
    {
      "id": "block-req-input",
      "name": "Input Protection",
      "type": "protection",
      "designIntentRef": [{ "requirementId": "req-input" }]
    },
    {
      "id": "block-req-regulator",
      "name": "Voltage Regulator",
      "type": "power-management",
      "designIntentRef": [{ "requirementId": "req-regulator" }]
    }
  ],
  "devices": [
    {
      "id": "dev-block-req-input",
      "ref": "D1",
      "blockRef": "block-req-input",
      "designIntentRef": [{ "requirementId": "req-input" }],
      "metadata": [
        { "key": "role", "value": "protection-diode" },
        {
          "key": "packageHint",
          "value": "SOD-123/SMA (select by clamping voltage and current rating)"
        },
        { "key": "planningState", "value": "candidate" }
      ]
    },
    {
      "id": "dev-block-req-regulator",
      "ref": "U1",
      "blockRef": "block-req-regulator",
      "designIntentRef": [{ "requirementId": "req-regulator" }],
      "metadata": [
        { "key": "role", "value": "power-regulator" },
        { "key": "packageHint", "value": "SOT-23-5 or TO-220 (select by current/thermal rating)" },
        { "key": "planningState", "value": "candidate" }
      ]
    }
  ],
  "nets": [
    { "id": "net-rail-12V_IN", "name": "12V_IN", "type": "power", "nodes": [] },
    { "id": "net-rail-3V3_OUT", "name": "3V3_OUT", "type": "power", "nodes": [] },
    { "id": "net-gnd", "name": "GND", "type": "ground", "nodes": [] }
  ],
  "rails": [
    {
      "id": "rail-12V_IN",
      "name": "12V_IN",
      "voltage": 12.0,
      "tolerance": 5,
      "maxCurrentAmps": 1.0,
      "designIntentRef": [{ "requirementId": "12V_IN" }]
    },
    {
      "id": "rail-3V3_OUT",
      "name": "3V3_OUT",
      "voltage": 3.3,
      "tolerance": 3,
      "maxCurrentAmps": 0.5,
      "designIntentRef": [{ "requirementId": "3V3_OUT" }]
    }
  ],
  "pcb": { "layerCount": 2, "widthMm": 30, "heightMm": 20 },
  "manufacturing": {}
}
```

## API Usage

```typescript
import { compile, isReadyForEasyEDA, setValidationStatus } from './circuit/compiler.js';
import { validateDesignIntent, isDesignIntent } from './circuit/design-intent.js';
import { validateCircuitIR, isCircuitIR } from './circuit/circuit-ir.js';
import { ValidationStatus, BoardType } from './circuit/types.js';

// 1. Parse user requirements
const intent = validateDesignIntent(rawUserInput);

// 2. Compile into CircuitIR (draft)
const { circuitIR, warnings } = compile(intent);

// 3. Review gate (human or automated)
const validated = setValidationStatus(circuitIR, ValidationStatus.Validated);

// 4. Check before EasyEDA operations
if (isReadyForEasyEDA(validated)) {
  // Proceed with schematic placement, wiring, etc.
}
```

## File Structure

```
src/circuit/
├── index.ts              # Public API surface
├── types.ts              # Enums and shared types
├── errors.ts             # Circuit-specific error types
├── design-intent.ts      # DesignIntent schema + validation
├── circuit-ir.ts         # CircuitIR schema + validation
├── component-planning.ts # Component role, refdes, and package-hint synthesis
└── compiler.ts           # DesignIntent → CircuitIR compiler

tests/unit/circuit/
├── design-intent.test.ts       # DesignIntent validation tests
├── circuit-ir.test.ts          # CircuitIR validation tests
├── component-planning.test.ts  # Component role/refdes planning tests
└── compiler.test.ts            # Compiler + review gate tests
```
