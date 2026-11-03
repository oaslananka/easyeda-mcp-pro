import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reviewDatasheetConstraints,
  type DatasheetConstraint,
} from '../../../src/net-validation/datasheet-review.js';
import type {
  NetValidationEntry,
  DeviceValidationEntry,
} from '../../../src/net-validation/schema.js';

const nets: NetValidationEntry[] = [
  {
    id: 'five',
    name: '5V',
    type: 'power',
    voltage: 5,
    nodes: [
      { deviceRef: 'U1', pin: 'VDD' },
      { deviceRef: 'U1', pin: 'GPIO' },
      { deviceRef: 'U1', pin: 'NCCONNECTED' },
      { deviceRef: 'U2', pin: 'IN' },
    ],
  },
  {
    id: 'three',
    name: '3V3',
    type: 'power',
    voltage: 3.3,
    nodes: [{ deviceRef: 'U2', pin: 'OUT' }],
  },
  {
    id: 'unknown-voltage',
    name: '3V3_NOMINAL',
    type: 'power',
    nodes: [{ deviceRef: 'U1', pin: 'VREF' }],
  },
];
const devices: DeviceValidationEntry[] = [
  {
    id: 'U1',
    ref: 'U1',
    pins: [
      { pin: 'VDD', electricalType: 'power_input' },
      { pin: 'GPIO', electricalType: 'input' },
      { pin: 'NC', electricalType: 'no_connect', noConnectAllowed: true },
      { pin: 'NCCONNECTED', electricalType: 'no_connect', noConnectAllowed: true },
      { pin: 'VREF', electricalType: 'power_input' },
    ],
  },
  {
    id: 'U2',
    ref: 'U2',
    pins: [
      { pin: 'IN', electricalType: 'power_input' },
      { pin: 'OUT', electricalType: 'power_output' },
    ],
  },
];
type Case = {
  id: string;
  constraint: DatasheetConstraint;
  expected: { status: 'WARNING' | 'UNKNOWN'; net?: string; pins: string[] };
};
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/datasheet-constraints-cases.json', import.meta.url),
    'utf8',
  ),
) as Case[];

describe('datasheet provenance-bound ERC observations', () => {
  it('covers nine distinct cases without creating a fabricated PASS', () => {
    expect(fixtures).toHaveLength(12);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
  });

  it.each(fixtures)('$id', ({ constraint, expected }) => {
    const result = reviewDatasheetConstraints([constraint], nets, devices);
    expect(result).toEqual(reviewDatasheetConstraints([constraint], nets, devices));
    expect(result.status).toBe(expected.status);
    expect(result.findings[0]?.status).toBe(expected.status);
    expect(result.findings[0]?.pins).toEqual(expected.pins);
    if (expected.net) expect(result.findings[0]?.nets).toContain(expected.net);
    expect(result.findings[0]?.component_ref).toBe(constraint.componentRef);
    expect(result.findings[0]?.source).toEqual(constraint.reference);
    expect(result.source_authenticity).toBe('CALLER_DECLARED_UNVERIFIED');
    expect(result.netlist_scope).toBe('CALLER_SUPPLIED_NOT_LIVE_VERIFIED');
    expect(result.engineering_sign_off).toBe(false);
    expect(result.findings.map((item) => item.status)).not.toContain('PASS');
  });

  it('rejects corrupt or contradictory caller pin-voltage constraints without a false in-range statement', () => {
    const pin = fixtures[0]!.constraint;
    if (pin.kind !== 'pin_voltage') throw new Error('Fixture contract changed');
    const invalid = [
      { maxVoltageV: Number.NaN },
      { maxVoltageV: Number.POSITIVE_INFINITY },
      { minVoltageV: Number.NaN },
      { minVoltageV: 6, maxVoltageV: 3 },
    ];
    for (const limit of invalid) {
      const result = reviewDatasheetConstraints(
        [{ ...pin, maxVoltageV: undefined, ...limit }],
        nets,
        devices,
      );
      expect(result.status).toBe('UNKNOWN');
      expect(result.findings[0]?.message).toMatch(/invalid/i);
      expect(result.findings[0]?.message).not.toMatch(/inside the caller-supplied/);
      expect(result.engineering_sign_off).toBe(false);
    }
    const missing = reviewDatasheetConstraints(
      [{ ...pin, maxVoltageV: undefined, minVoltageV: undefined }],
      nets,
      devices,
    );
    expect(missing.findings[0]?.message).toMatch(/no numeric/i);
  });

  it('rejects invalid regulator headroom constraints and handles exact arithmetic boundaries', () => {
    const constraint = fixtures[6]!.constraint;
    if (constraint.kind !== 'regulator_headroom') throw new Error('Fixture contract changed');
    for (const minHeadroomV of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      const result = reviewDatasheetConstraints([{ ...constraint, minHeadroomV }], nets, devices);
      expect(result.status).toBe('UNKNOWN');
      expect(result.findings[0]?.message).toMatch(/invalid/i);
      expect(result.findings[0]?.message).not.toMatch(/meets the caller-supplied minimum/);
    }
    const decimalNets: NetValidationEntry[] = [
      { ...nets[0]!, voltage: 0.3 },
      { ...nets[1]!, voltage: 0.2 },
      nets[2]!,
    ];
    const exact = reviewDatasheetConstraints(
      [{ ...constraint, minHeadroomV: 0.1 }],
      decimalNets,
      devices,
    );
    expect(exact.status).toBe('UNKNOWN');
    expect(exact.findings[0]?.message).toMatch(/meets the caller-supplied minimum/);
    const exceeded = reviewDatasheetConstraints(
      [{ ...constraint, minHeadroomV: 0.101 }],
      decimalNets,
      devices,
    );
    expect(exceeded.status).toBe('WARNING');
    expect(exact.engineering_sign_off).toBe(false);
  });

  it('does not trust net names alone, or assume a source-declared range was authenticated', () => {
    const constraint = fixtures[7]!.constraint;
    const result = reviewDatasheetConstraints([constraint], nets, devices);
    expect(result.findings[0]?.observed_voltages_v).toEqual([]);
    expect(result.status).toBe('UNKNOWN');
    expect(result.limitations.join(' ')).toMatch(/guessed voltage/);
  });

  it('cannot assume a missing part or net pin when the caller inventory is incomplete', () => {
    const constraint = fixtures[0]!.constraint;
    const result = reviewDatasheetConstraints([constraint], nets, []);
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.evidence).toBe('incomplete_or_ambiguous');
    const partial = reviewDatasheetConstraints([constraint], nets.slice(1), devices);
    expect(partial.status).toBe('UNKNOWN');
  });

  it('does not count duplicate ambiguous pin connections as verified electrical evidence', () => {
    const duplicateNet: NetValidationEntry = {
      id: 'duplicate',
      name: 'DUPLICATE_RAIL',
      type: 'power',
      voltage: 12,
      nodes: [{ deviceRef: 'U1', pin: 'VDD' }],
    };
    const result = reviewDatasheetConstraints(
      [fixtures[0]!.constraint],
      [...nets, duplicateNet],
      devices,
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.nets).toEqual([]);
  });

  it('keeps absent declared supports unverified, even if another component happens to exist', () => {
    const support = fixtures[5]!.constraint;
    const missing = reviewDatasheetConstraints([support], nets, devices);
    expect(missing.status).toBe('UNKNOWN');
    expect(missing.findings[0]?.message).toMatch(/absent from the supplied device inventory/);
    const present = reviewDatasheetConstraints([support], nets, [
      ...devices,
      { id: 'C404', ref: 'C404' },
    ]);
    expect(present.status).toBe('UNKNOWN');
    expect(present.findings[0]?.message).toMatch(/electrical connection/);
  });

  it('preserves per-constraint evidence and does not hide failures with UNKNOWNs', () => {
    const result = reviewDatasheetConstraints(
      fixtures.map((f) => f.constraint),
      nets,
      devices,
    );
    expect(result.finding_count).toBe(12);
    expect(result.status).toBe('WARNING');
    expect(result.findings.filter((f) => f.status === 'WARNING').length).toBe(5);
    expect(result.findings.filter((f) => f.status === 'UNKNOWN').length).toBe(7);
  });

  it('evaluates an explicitly supplied lower pin voltage bound', () => {
    const lower = {
      kind: 'pin_voltage' as const,
      componentRef: 'U2',
      pin: 'OUT',
      minVoltageV: 4.2,
      reference: fixtures[8]!.constraint.reference,
    };
    const violated = reviewDatasheetConstraints([lower], nets, devices);
    expect(violated.status).toBe('WARNING');
    expect(violated.findings[0]?.observed_voltages_v).toEqual([{ net: '3V3', voltage_v: 3.3 }]);
    const within = reviewDatasheetConstraints([{ ...lower, minVoltageV: 2.5 }], nets, devices);
    expect(within.status).toBe('UNKNOWN');
    expect(within.findings[0]?.evidence).toBe('explicit_netlist');
  });

  it('distinguishes a declared unconnected NC from unavailable pin identity', () => {
    const declared = fixtures[3]!.constraint;
    const observedUnconnected = reviewDatasheetConstraints([declared], nets, devices);
    expect(observedUnconnected.findings[0]?.message).toMatch(/No net connection observed/);
    const missingPin = reviewDatasheetConstraints(
      [{ ...declared, pin: 'UNLISTED_NC' }],
      nets,
      devices,
    );
    expect(missingPin.status).toBe('UNKNOWN');
    expect(missingPin.findings[0]?.message).toMatch(/pin inventory is unavailable/);
  });

  it('does not infer the support net from an unconnected declared target pin', () => {
    const missing = fixtures[5]!.constraint;
    const supportOnNc = reviewDatasheetConstraints([{ ...missing, pin: 'NC' }], nets, devices);
    expect(supportOnNc.status).toBe('UNKNOWN');
    expect(supportOnNc.findings[0]?.nets).toEqual([]);
    expect(supportOnNc.findings[0]?.observed_voltages_v).toEqual([]);
  });

  it('preserves regulator input/output provenance when only one side is observed', () => {
    const source = fixtures[6]!.constraint;
    if (source.kind !== 'regulator_headroom') throw new Error('Fixture contract changed');
    const missingInput = reviewDatasheetConstraints(
      [{ ...source, inputPin: 'UNLISTED_INPUT' }],
      nets,
      devices,
    );
    expect(missingInput.status).toBe('UNKNOWN');
    expect(missingInput.findings[0]?.nets).toEqual(['3V3']);
    expect(missingInput.findings[0]?.observed_voltages_v).toEqual([{ net: '3V3', voltage_v: 3.3 }]);
    const missingOutput = reviewDatasheetConstraints(
      [{ ...source, outputPin: 'UNLISTED_OUTPUT' }],
      nets,
      devices,
    );
    expect(missingOutput.status).toBe('UNKNOWN');
    expect(missingOutput.findings[0]?.nets).toEqual(['5V']);
    expect(missingOutput.findings[0]?.observed_voltages_v).toEqual([{ net: '5V', voltage_v: 5 }]);
  });

  it('never turns an observed regulator headroom within caller limits into hardware approval', () => {
    const source = fixtures[6]!.constraint;
    if (source.kind !== 'regulator_headroom') throw new Error('Fixture contract changed');
    const result = reviewDatasheetConstraints([{ ...source, minHeadroomV: 1.5 }], nets, devices);
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.evidence).toBe('explicit_netlist');
    expect(result.findings[0]?.message).toMatch(/meets the caller-supplied minimum/);
    expect(result.engineering_sign_off).toBe(false);
  });
});
