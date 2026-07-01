# Power Tree Analyzer

The power tree analyzer validates supply sources, regulators, rails, loads, protection devices, bulk capacitance, dropout, and regulator thermal margin.

It is designed for agent workflows where a schematic or CircuitIR model must be checked before design release, PCB handoff, or manufacturing export.

## MCP tool

```text
easyeda_power_tree_analyze
```

The tool is read-only. It does not call the EasyEDA bridge and does not mutate the project. Agents can feed it a power-tree model derived from CircuitIR, schematic inspection, BOM metadata, or a user-authored design model.

## Input model

```typescript
{
  projectId?: string;
  rails: PowerRailInput[];
  sources?: PowerSourceInput[];
  regulators?: PowerRegulatorInput[];
  loads?: PowerLoadInput[];
  protections?: PowerProtectionInput[];
  capacitors?: PowerCapacitorInput[];
  limits?: PowerTreeLimits;
}
```

### Rails

Rails define the voltage domains being analyzed.

```typescript
{
  id: '3v3',
  name: '3V3',
  voltage: 3.3,
  maxCurrentA: 1.2,
  requiresBulkCapacitance: true,
}
```

### Sources

Sources define externally or internally supplied rails.

```typescript
{
  id: 'usb-c',
  kind: 'usb',
  railId: 'vin',
  voltage: 5,
  maxCurrentA: 3,
  requiresProtection: true,
}
```

### Regulators

Regulators connect an input rail to an output rail. Linear/LDO dissipation is estimated as:

```text
P = (Vin - Vout) × Iout
```

Switching regulator dissipation is estimated from efficiency when available:

```text
P_loss = P_out × (1 / efficiency - 1)
```

Thermal estimate:

```text
Tj = ambient + P_loss × RθJA
thermal_margin = Tj_max - Tj
```

### Loads

Loads define nominal and peak current on a rail.

```typescript
{
  id: 'mcu',
  ref: 'U2',
  railId: '3v3',
  currentA: 0.12,
  peakCurrentA: 0.22,
}
```

## Issue codes

| Code                                 | Severity | Meaning                                             |
| ------------------------------------ | -------- | --------------------------------------------------- |
| `POWER_RAIL_OVERCURRENT`             | error    | Peak rail load exceeds available current            |
| `POWER_RAIL_LOW_MARGIN`              | warning  | Rail current margin is below configured min         |
| `POWER_SOURCE_MISSING_PROTECTION`    | warning  | External/protection-sensitive rail lacks protection |
| `POWER_MISSING_BULK_CAPACITANCE`     | warning  | Bulk capacitance is below calculated need           |
| `POWER_REGULATOR_OVERLOAD`           | error    | Regulator output current exceeds rating             |
| `POWER_REGULATOR_DROPOUT`            | error    | Regulator has insufficient voltage headroom         |
| `POWER_REGULATOR_THERMAL_RISK`       | warning  | Regulator thermal margin is low                     |
| `POWER_REGULATOR_THERMAL_OVER_LIMIT` | error    | Estimated junction temperature exceeds limit        |
| `POWER_SEQUENCE_MISSING`             | warning  | Sequencing dependency references unknown rail       |

## Example: passing buck rail

```typescript
const report = analyzePowerTree({
  rails: [
    { id: 'vin', name: 'VIN_USB', voltage: 5, external: true, requiresProtection: true },
    { id: '3v3', name: '3V3', voltage: 3.3, requiresBulkCapacitance: true },
  ],
  sources: [
    {
      id: 'usb-c',
      kind: 'usb',
      railId: 'vin',
      voltage: 5,
      maxCurrentA: 3,
      requiresProtection: true,
    },
  ],
  protections: [{ id: 'f1', ref: 'F1', kind: 'polyfuse', railId: 'vin', currentRatingA: 1.5 }],
  regulators: [
    {
      id: 'u1',
      ref: 'U1',
      kind: 'buck',
      inputRailId: 'vin',
      outputRailId: '3v3',
      maxOutputCurrentA: 1.2,
      efficiency: 0.9,
      thermalResistanceCPerW: 55,
      maxJunctionTempC: 125,
    },
  ],
  loads: [{ id: 'mcu', ref: 'U2', railId: '3v3', currentA: 0.1, peakCurrentA: 0.2 }],
  capacitors: [{ id: 'c1', ref: 'C1', railId: '3v3', role: 'bulk', capacitanceUf: 47 }],
});
```

## Example: failing LDO rail

```typescript
const report = analyzePowerTree({
  rails: [
    { id: 'vin', name: 'VIN', voltage: 3.6 },
    { id: '3v3', name: '3V3', voltage: 3.3 },
  ],
  regulators: [
    {
      id: 'ldo1',
      ref: 'U1',
      kind: 'ldo',
      inputRailId: 'vin',
      outputRailId: '3v3',
      maxOutputCurrentA: 0.8,
      dropoutVoltage: 0.5,
      thermalResistanceCPerW: 150,
      maxJunctionTempC: 85,
    },
  ],
  loads: [{ id: 'load', ref: 'U2', railId: '3v3', currentA: 0.7, peakCurrentA: 0.7 }],
  limits: { ambientTempC: 60 },
});
```

This model produces blocking dropout and thermal findings because the LDO has insufficient input headroom and exceeds the configured junction limit.

## Output

The analyzer returns both machine-readable and user-readable data:

```typescript
{
  passed: boolean;
  rails: RailPowerReport[];
  regulators: RegulatorThermalReport[];
  issues: PowerTreeIssue[];
  summary: {
    railCount: number;
    sourceCount: number;
    regulatorCount: number;
    loadCount: number;
    totalLoadCurrentA: number;
    totalPeakCurrentA: number;
    errorCount: number;
    warningCount: number;
    humanSummary: string;
  };
}
```

Warnings are review items. Errors should block release until corrected.
