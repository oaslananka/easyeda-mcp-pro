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
    expect(fixtures).toHaveLength(9);
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
    expect(result.finding_count).toBe(9);
    expect(result.status).toBe('WARNING');
    expect(result.findings.filter((f) => f.status === 'WARNING').length).toBe(5);
    expect(result.findings.filter((f) => f.status === 'UNKNOWN').length).toBe(4);
  });
});
