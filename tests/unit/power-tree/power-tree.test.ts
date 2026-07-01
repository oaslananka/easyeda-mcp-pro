import { describe, it, expect } from 'vitest';
import { analyzePowerTree } from '../../../src/power-tree/index.js';

describe('analyzePowerTree', () => {
  it('passes a protected buck-regulated MCU power tree with healthy margins', () => {
    const report = analyzePowerTree({
      projectId: 'safe-power-tree',
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
      loads: [
        { id: 'mcu', ref: 'U2', railId: '3v3', currentA: 0.12, peakCurrentA: 0.22 },
        { id: 'radio', ref: 'U3', railId: '3v3', currentA: 0.08, peakCurrentA: 0.18 },
      ],
      capacitors: [
        { id: 'cin', ref: 'C1', railId: 'vin', role: 'bulk', capacitanceUf: 22, voltageRating: 10 },
        {
          id: 'cout',
          ref: 'C2',
          railId: '3v3',
          role: 'bulk',
          capacitanceUf: 47,
          voltageRating: 6.3,
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.summary.humanSummary).toContain('Power tree passed');
    expect(report.rails.find((rail) => rail.railId === '3v3')?.marginPercent).toBeGreaterThan(60);
    expect(report.regulators[0].estimatedDissipationW).toBeGreaterThan(0);
  });

  it('flags rail overcurrent and low/negative current margin', () => {
    const report = analyzePowerTree({
      rails: [{ id: '3v3', name: '3V3', voltage: 3.3, maxCurrentA: 0.5 }],
      loads: [
        { id: 'mcu', ref: 'U1', railId: '3v3', currentA: 0.2, peakCurrentA: 0.3 },
        { id: 'modem', ref: 'U2', railId: '3v3', currentA: 0.4, peakCurrentA: 0.45 },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'POWER_RAIL_OVERCURRENT')).toBe(true);
    const rail = report.rails[0];
    expect(rail.peakCurrentA).toBe(0.75);
    expect(rail.marginA).toBeLessThan(0);
  });

  it('flags low but non-blocking current margin', () => {
    const report = analyzePowerTree({
      rails: [{ id: '5v', name: '5V', voltage: 5, maxCurrentA: 1 }],
      loads: [{ id: 'load', ref: 'J1', railId: '5v', currentA: 0.7, peakCurrentA: 0.85 }],
      limits: { minCurrentMarginPercent: 20 },
    });

    expect(report.passed).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'POWER_RAIL_LOW_MARGIN')).toBe(true);
    expect(report.summary.warningCount).toBe(2); // low margin + missing bulk for a high-current rail
  });

  it('flags missing input protection and insufficient bulk capacitance', () => {
    const report = analyzePowerTree({
      rails: [
        {
          id: 'vin',
          name: 'VIN',
          voltage: 12,
          external: true,
          requiresProtection: true,
          requiresBulkCapacitance: true,
        },
      ],
      sources: [
        {
          id: 'barrel',
          kind: 'barrel-jack',
          railId: 'vin',
          voltage: 12,
          maxCurrentA: 2,
          requiresProtection: true,
        },
      ],
      loads: [{ id: 'motor', ref: 'M1', railId: 'vin', currentA: 0.5, peakCurrentA: 1.5 }],
      capacitors: [
        { id: 'c1', ref: 'C1', railId: 'vin', role: 'bulk', capacitanceUf: 10, voltageRating: 25 },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['POWER_SOURCE_MISSING_PROTECTION', 'POWER_MISSING_BULK_CAPACITANCE']),
    );
  });

  it('flags LDO dropout and thermal over-limit', () => {
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

    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['POWER_REGULATOR_DROPOUT', 'POWER_REGULATOR_THERMAL_OVER_LIMIT']),
    );
    expect(report.regulators[0].estimatedDissipationW).toBeCloseTo(0.21, 3);
    expect(report.regulators[0].estimatedJunctionTempC).toBeCloseTo(91.5, 1);
  });

  it('flags regulator overload independently from rail capacity', () => {
    const report = analyzePowerTree({
      rails: [
        { id: 'vin', name: 'VIN', voltage: 5 },
        { id: '1v8', name: '1V8', voltage: 1.8 },
      ],
      regulators: [
        {
          id: 'u1',
          ref: 'U1',
          kind: 'buck',
          inputRailId: 'vin',
          outputRailId: '1v8',
          maxOutputCurrentA: 0.4,
          efficiency: 0.85,
        },
      ],
      loads: [{ id: 'fpga', ref: 'U2', railId: '1v8', currentA: 0.5, peakCurrentA: 0.65 }],
    });

    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'POWER_REGULATOR_OVERLOAD')).toBe(true);
  });

  it('warns when a sequencing dependency references an unmodeled rail', () => {
    const report = analyzePowerTree({
      rails: [{ id: 'core', name: 'VCORE', voltage: 1.2, sequenceAfterRailRefs: ['3v3'] }],
      loads: [],
    });

    expect(report.passed).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'POWER_SEQUENCE_MISSING')).toBe(true);
  });
});
