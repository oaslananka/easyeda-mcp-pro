# Design Rules Reference

Generic engineering reference lookups: trace-width/current-capacity, electrical clearance, protocol routing, decoupling, and a static DFM checklist.

## Overview

The design-rules module is a knowledge pack, not a design tool: every lookup returns a `source` and a `caveat` alongside the computed or looked-up value. These are widely-published engineering rules of thumb — not certified values, not a replacement for the actual standard, your fabricator's capability table, or the target IC's datasheet.

This is exposed to agents through a single MCP tool, `easyeda_design_rules_lookup`, discriminated by a `topic` field:

| Topic                  | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `trace-width`          | IPC-2221 empirical conductor width estimate for stated current and rise |
| `trace-current-review` | Current-path warnings and explicit UNKNOWN evidence gaps                |
| `max-current`          | IPC-2221 maximum current for a given trace width (reverse lookup)       |
| `clearance`            | Simplified, conservative voltage-based electrical clearance bands       |
| `protocol-routing`     | Routing reference data: USB 2.0/3.x, RS-485, I2C, SPI, UART, Ethernet   |
| `decoupling`           | Per-pin decoupling capacitor recipes by IC category                     |
| `bulk-capacitance`     | Rail bulk capacitance sizing (shares the power-tree analyzer's rule)    |
| `dfm-checklist`        | Static, generic design-for-manufacturability checklist                  |

## Trace width / current capacity

`src/design-rules/trace-width.ts` implements the IPC-2221 (formerly MIL-STD-275) empirical curve:

```
I = k · ΔT^0.44 · A^0.725
```

where `I` is current in amps, `ΔT` is the allowed temperature rise in °C, `A` is cross-sectional area in mils², and `k` is `0.048` for external (outer layer) conductors or `0.024` for internal conductors.

```typescript
import { calculateTraceWidth, calculateMaxCurrent } from './design-rules/trace-width.js';

calculateTraceWidth({
  currentA: 2,
  temperatureRiseC: 10,
  layer: 'external',
  copperWeightOz: 1,
});
// → { traceWidthMils, traceWidthMm, requiredAreaMils2, copperThicknessMils, k, source, caveat }

calculateMaxCurrent({
  traceWidthMils: 20,
  temperatureRiseC: 10,
  layer: 'external',
  copperWeightOz: 1,
});
// → { maxCurrentA, source, caveat }
```

These are **empirical reference estimates**, not certified or native measurements. Inputs, units, method, source and limitations accompany both calculations. The model omits adjacent-trace heating, via/plane proximity, forced airflow and enclosures. [IPC-2152](https://quicksearch.dla.mil/qsDocDetails.aspx?ident_number=277660) provides broader thermal guidance and can yield either higher or lower sizing estimates depending on the actual PCB, rather than being uniformly conservative. Do not reproduce licensed standard tables; refer to the governing standard and the fabricator's documented process.

### Context-aware current-path review

The same read-only MCP tool accepts `topic=trace-current-review` without another tool or service. Supply known current (A), allowed rise (°C), layer, copper weight (oz/ft²), routed width (mm), local narrowest width (mm), manufacturer minimum width (mm), and thermal environment. All supplied geometry and stackup data remains **caller-supplied and unverified** — this lookup does not measure EasyEDA routes.

```json
{
  "topic": "trace-current-review",
  "currentA": 2,
  "temperatureRiseC": 10,
  "layer": "external",
  "copperWeightOz": 1,
  "traceWidthMm": 1.0,
  "neckDownWidthMm": 0.15,
  "manufacturerMinWidthMm": 0.12,
  "environment": "still-air"
}
```

The result uses `WARNING` for supplied values below the empirical thermal estimate or the separately supplied fabricator minimum. Missing route, via, finished-copper and thermal evidence remains `UNKNOWN`. **This review never emits a verified PASS**, even when caller-supplied width exceeds both estimates. A manufacturing trace minimum is not an electrical rating. Via barrels and parallel-current paths require separate analysis.

To compare a real **bounded native net-segment width** with the same empirical
reference, use the optional `traceCurrent` input on
[`easyeda_pcb_route_geometry_review`](./route-geometry-review.md#optional-current-observed-net-width-review).
That operation reads `pcb.listTracks` on an exact focused project and reports
source/geometry coverage; its measured minimum is not a validated whole
current path or stackup. The original lookup above remains entirely
caller-supplied and backward-compatible.

For genuine native measurements and exact-source runtime evidence, inspect a disposable EasyEDA PCB and follow [engineering review live acceptance](./development/engineering-review-live-acceptance.md). Never claim a fabrication/electrical sign-off from this reference lookup.

## Electrical clearance

`src/design-rules/clearance.ts` provides deliberately coarse, safety-margined clearance bands loosely modeled on IPC-2221's "clearance grows with voltage" shape — **not a reproduction of the exact IPC-2221 Table 6-1 through 6-4 breakpoints**. Internal clearances are always set at least as large as external for the same band, so the estimate never under-recommends.

```typescript
import { lookupClearance } from './design-rules/clearance.js';

lookupClearance({ voltageV: 48, location: 'external' });
// → { minClearanceMm, minClearanceMils, bandMaxVoltageV, source, caveat }
```

Voltages above the covered range (`>500V`) return `outOfRange: true` and point to IPC-2221's high-voltage guidance and applicable safety standards instead of extrapolating a floor value. Always consult the actual IPC-2221 tables or your fabricator's certified minimums before finalizing a safety-critical or mains-adjacent clearance.

## Protocol routing

`src/design-rules/protocol-routing.ts` covers USB 2.0, USB 3.x, RS-485, I2C, SPI, UART, and 10/100/1000BASE-T Ethernet: topology, differential impedance, termination, pull-up ranges, and length-matching guidance, each citing the governing spec (USB-IF, TIA/EIA-485, NXP UM10204, IEEE 802.3).

```typescript
import { lookupProtocolRouting, listProtocolRoutingKeys } from './design-rules/protocol-routing.js';

lookupProtocolRouting('rs485');
// → { protocol, displayName, topology, terminationOhms: 120, ... }

listProtocolRoutingKeys();
// → ['usb2', 'usb3', 'rs485', 'i2c', 'spi', 'uart', 'ethernet-10-100', 'ethernet-1000']
```

## Decoupling

`src/design-rules/decoupling.ts` gives per-pin decoupling recipes by IC category (`digital-logic`, `mcu`, `analog`, `rf`, `crystal-oscillator`, `power-regulator`), plus rail-level bulk capacitance sizing that reuses the exact same rule as the [power-tree analyzer](./power-tree.md) (`47µF` per amp, `10µF` floor) so the two never disagree.

```typescript
import { lookupDecouplingGuidance, recommendBulkCapacitance } from './design-rules/decoupling.js';

lookupDecouplingGuidance('mcu');
// → { category, displayName, perPinCapacitorsNf, placement, notes, source, caveat }

recommendBulkCapacitance(1.5);
// → { requiredBulkCapacitanceUf, loadA, source, caveat }
```

## DFM checklist

`src/design-rules/dfm-checklist.ts` is a fixed, project-independent checklist of manufacturability considerations (trace/space, drilling, solder mask, silkscreen, panelization, assembly). Unlike [`src/production-qa/generator.ts`](./production-qa.md), which generates a project-specific checklist from real board inputs, this is static reference data.

```typescript
import { listDfmChecklist, getDfmChecklistItem } from './design-rules/dfm-checklist.js';

listDfmChecklist('drilling');
getDfmChecklistItem('annular-ring');
```

## MCP Tool

`easyeda_design_rules_lookup` (group `design-rules`, profile `core`, read-only, no `confirmWrite`) exposes all eight topics through one discriminated-union input. Example call:

```json
{
  "topic": "trace-width",
  "currentA": 2,
  "temperatureRiseC": 10,
  "layer": "external",
  "copperWeightOz": 1
}
```

## MCP Resources & Prompts

- `easyeda://design-rules/reference` — markdown overview of available topics
- `easyeda://design-rules/dfm-checklist` — the full static DFM checklist as JSON
- `review_layout` prompt — walks an agent through PCB constraint checks, production review, and the relevant design-rules lookups before layout sign-off

## File Structure

```
src/design-rules/
├── trace-width.ts       — IPC-2221 trace-width/current-capacity calculator
├── clearance.ts         — Simplified electrical clearance bands
├── protocol-routing.ts  — USB/RS-485/I2C/SPI/UART/Ethernet reference data
├── decoupling.ts        — Per-pin decoupling recipes + bulk capacitance sizing
├── dfm-checklist.ts     — Static DFM reference checklist
└── index.ts             — Barrel exports

tests/unit/design-rules/
├── trace-width.test.ts
├── clearance.test.ts
├── protocol-routing.test.ts
├── decoupling.test.ts
└── dfm-checklist.test.ts
```
