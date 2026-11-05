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

  it('does not compare one regulator pin against itself as separate input/output evidence', () => {
    const base = fixtures[6]!.constraint;
    if (base.kind !== 'regulator_headroom') throw new Error('Fixture contract changed');
    for (const pin of ['IN', 'OUT']) {
      for (const minHeadroomV of [0, 0.5]) {
        const result = reviewDatasheetConstraints(
          [{ ...base, inputPin: pin, outputPin: pin, minHeadroomV }],
          nets,
          devices,
        );
        expect(result.findings[0]).toMatchObject({
          status: 'UNKNOWN',
          evidence: 'incomplete_or_ambiguous',
          pins: [pin, pin],
          observed_voltages_v: [],
        });
        expect(result.findings[0]?.message).toMatch(/distinct|same pin|invalid/i);
        expect(result.findings[0]?.message).not.toMatch(/below|meets/);
        expect(result.engineering_sign_off).toBe(false);
      }
    }
    // Two different pins intentionally tied to one net remain a concrete
    // zero-headroom observation; do not discard that discrepancy.
    const sharedInputNet: NetValidationEntry[] = [
      { ...nets[0]!, nodes: [...nets[0]!.nodes, { deviceRef: 'U2', pin: 'OUT' }] },
      { ...nets[1]!, nodes: [] },
      nets[2]!,
    ];
    const tied = reviewDatasheetConstraints(
      [{ ...base, minHeadroomV: 0.5 }],
      sharedInputNet,
      devices,
    );
    expect(tied.findings[0]?.status).toBe('WARNING');
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

  it('rejects global native device ID collisions and unrelated duplicate net identifiers', () => {
    const c = fixtures[0]!.constraint;
    const poisonedDevices: DeviceValidationEntry[] = [
      ...devices,
      { id: 'U1', ref: 'J9', pins: [{ pin: 'SENSE', electricalType: 'input' }] },
    ];
    const unrelated: NetValidationEntry = {
      id: 'three',
      name: 'AUX',
      type: 'signal',
      nodes: [{ deviceRef: 'J9', pin: 'SENSE' }],
    };
    for (const [inventory, componentInventory] of [
      [nets, poisonedDevices],
      [[...nets, unrelated], devices],
      [[...nets, { ...unrelated, id: 'aux', name: '  AUX  ' }], devices],
      [nets, [...devices, { id: ' J9 ', ref: 'J9' }]],
    ] as const) {
      const result = reviewDatasheetConstraints([c], inventory, componentInventory);
      expect(result.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'incomplete_or_ambiguous',
        observed_voltages_v: [],
        nets: [],
      });
      expect(result.findings[0]?.message).toMatch(/unique|ambiguous/i);
    }
    const original = reviewDatasheetConstraints([c], nets, devices);
    expect(original.findings[0]?.status).toBe('WARNING');
  });

  it('does not claim the target component or pin is its own external support', () => {
    const reference = fixtures[0]!.constraint.reference;
    for (const supportPin of ['VDD', 'GPIO', undefined]) {
      const c: DatasheetConstraint = {
        kind: 'required_support',
        componentRef: 'U1',
        pin: 'VDD',
        supportRef: 'U1',
        ...(supportPin === undefined ? {} : { supportPin }),
        function: 'decoupling',
        reference,
      };
      const result = reviewDatasheetConstraints([c], nets, devices);
      expect(result.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'incomplete_or_ambiguous',
        related_component_ref: 'U1',
        observed_voltages_v: [],
      });
      expect(result.findings[0]?.message).toMatch(/same component|self-support/i);
      expect(result.findings[0]?.message).not.toMatch(/Both explicitly named pins share/);
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('flags exact support-pin net mismatch without inventing a matching-net PASS', () => {
    const support = fixtures.find((f) => f.constraint.kind === 'required_support')?.constraint;
    if (support?.kind !== 'required_support') throw new Error('Missing required-support fixture');
    const target = {
      ...support,
      componentRef: 'U1',
      pin: 'VDD',
      supportRef: 'C404',
      supportPin: '1',
    };
    const augmentedDevices: DeviceValidationEntry[] = [
      ...devices,
      {
        id: 'C404',
        ref: 'C404',
        pins: [
          { pin: '1', electricalType: 'passive' },
          { pin: '2', electricalType: 'passive' },
        ],
      },
    ];
    const augmentedNets: NetValidationEntry[] = [
      { ...nets[0]!, nodes: [...nets[0]!.nodes, { deviceRef: 'C404', pin: '1' }] },
      { ...nets[1]!, nodes: [...nets[1]!.nodes, { deviceRef: 'C404', pin: '2' }] },
      nets[2]!,
    ];
    const matched = reviewDatasheetConstraints([target], augmentedNets, augmentedDevices);
    expect(matched.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'explicit_netlist',
      related_component_ref: 'C404',
      related_pin: '1',
      nets: ['5V'],
    });
    expect(matched.findings[0]?.message).toContain('remain unverified');
    const mismatched = reviewDatasheetConstraints(
      [{ ...target, supportPin: '2' }],
      augmentedNets,
      augmentedDevices,
    );
    expect(mismatched.findings[0]).toMatchObject({
      status: 'WARNING',
      evidence: 'explicit_netlist',
      related_component_ref: 'C404',
      related_pin: '2',
      nets: ['5V', '3V3'],
    });
    expect(mismatched.findings[0]?.message).toContain('different nets');
    expect(mismatched.engineering_sign_off).toBe(false);
    const missingSupportPin = reviewDatasheetConstraints(
      [{ ...target, supportPin: '99' }],
      augmentedNets,
      augmentedDevices,
    );
    expect(missingSupportPin.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'incomplete_or_ambiguous',
      related_component_ref: 'C404',
      related_pin: '99',
    });
  });

  it('compares declared I/O-to-supply overvoltage without falsely passing nominal IO', () => {
    const ref = fixtures[0]!.constraint.reference;
    const constraint: DatasheetConstraint = {
      kind: 'io_domain_voltage',
      componentRef: 'U1',
      pin: 'GPIO',
      supplyPin: 'VREF',
      maxAboveSupplyV: 0.3,
      reference: ref,
    };
    const withSupply = [nets[0]!, nets[1]!, { ...nets[2]!, voltage: 3.3 }];
    const over = reviewDatasheetConstraints([constraint], withSupply, devices);
    expect(over.findings[0]).toMatchObject({
      kind: 'io_domain_voltage',
      status: 'WARNING',
      evidence: 'explicit_netlist',
      pins: ['GPIO', 'VREF'],
      nets: ['5V', '3V3_NOMINAL'],
      observed_voltages_v: [
        { net: '5V', voltage_v: 5 },
        { net: '3V3_NOMINAL', voltage_v: 3.3 },
      ],
      source: ref,
    });
    expect(over.engineering_sign_off).toBe(false);

    const within = reviewDatasheetConstraints(
      [constraint],
      [{ ...nets[0]!, voltage: 3.6 }, nets[1]!, withSupply[2]!],
      devices,
    );
    expect(within.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'explicit_netlist',
    });
    expect(within.findings[0]?.message).toContain('remain unverified');

    const supplyUnknown = reviewDatasheetConstraints([constraint], nets, devices);
    expect(supplyUnknown.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'incomplete_or_ambiguous',
      observed_voltages_v: [{ net: '5V', voltage_v: 5 }],
    });
    expect(supplyUnknown.findings[0]?.message).toContain('two explicitly declared');
  });

  it('fails closed on missing I/O pin, invalid domain bounds and reused net IDs', () => {
    const source = fixtures[0]!.constraint.reference;
    const base: DatasheetConstraint = {
      kind: 'io_domain_voltage',
      componentRef: 'U1',
      pin: 'GPIO',
      supplyPin: 'VREF',
      maxAboveSupplyV: 0.3,
      reference: source,
    };
    const declared = [nets[0]!, nets[1]!, { ...nets[2]!, voltage: 3.3 }];
    for (const invalid of [
      { ...base, pin: 'MISSING' },
      { ...base, supplyPin: 'MISSING' },
      { ...base, pin: 'VREF' },
      { ...base, maxAboveSupplyV: -1 },
      { ...base, maxAboveSupplyV: Number.POSITIVE_INFINITY },
    ]) {
      const result = reviewDatasheetConstraints([invalid], declared, devices);
      expect(result.findings[0]?.status).toBe('UNKNOWN');
      expect(result.engineering_sign_off).toBe(false);
    }
    const duplicate = reviewDatasheetConstraints(
      [base],
      [declared[0]!, declared[1]!, { ...declared[2]!, id: declared[0]!.id }],
      devices,
    );
    expect(duplicate.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'incomplete_or_ambiguous',
    });
  });

  it('fails closed for reused net ID, reused net name and duplicate pin nodes', () => {
    const constraint = fixtures[0]!.constraint;
    if (constraint.kind !== 'pin_voltage') throw Error('Missing pin-voltage fixture');
    const other = { ...nets[1]!, nodes: [...nets[1]!.nodes] };
    const cases: NetValidationEntry[][] = [
      [nets[0]!, { ...other, id: nets[0]!.id }, nets[2]!],
      [nets[0]!, { ...other, name: nets[0]!.name }, nets[2]!],
      [
        {
          ...nets[0]!,
          nodes: [
            ...nets[0]!.nodes,
            {
              deviceRef: constraint.componentRef,
              pin: constraint.pin,
            },
          ],
        },
        other,
        nets[2]!,
      ],
    ];
    for (const declaredNets of cases) {
      const result = reviewDatasheetConstraints([constraint], declaredNets, devices);
      expect(result.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'incomplete_or_ambiguous',
        observed_voltages_v: [],
      });
      expect(result.findings[0]?.message).toContain('not uniquely observed');
      expect(result.engineering_sign_off).toBe(false);
    }
    expect(reviewDatasheetConstraints([constraint], nets, devices).findings[0]?.status).toBe(
      'WARNING',
    );
  });

  it('does not infer a support-pin mismatch from reused net identities', () => {
    const source = fixtures.find((f) => f.constraint.kind === 'required_support')?.constraint;
    if (source?.kind !== 'required_support') throw Error('Missing support fixture');
    const constraint = {
      ...source,
      componentRef: 'U1',
      pin: 'VDD',
      supportRef: 'C4',
      supportPin: '1',
    };
    const declaredDevices: DeviceValidationEntry[] = [
      ...devices,
      { id: 'C4', ref: 'C4', pins: [{ pin: '1', electricalType: 'passive' }] },
    ];
    const observedNets = [
      nets[0]!,
      { ...nets[1]!, nodes: [...nets[1]!.nodes, { deviceRef: 'C4', pin: '1' }] },
      nets[2]!,
    ];
    expect(
      reviewDatasheetConstraints([constraint], observedNets, declaredDevices).findings[0]?.status,
    ).toBe('WARNING');
    for (const net of [
      { ...observedNets[1]!, id: observedNets[0]!.id },
      { ...observedNets[1]!, name: observedNets[0]!.name },
    ]) {
      const result = reviewDatasheetConstraints(
        [constraint],
        [observedNets[0]!, net, observedNets[2]!],
        declaredDevices,
      );
      expect(result.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'incomplete_or_ambiguous',
      });
      expect(result.findings[0]?.nets).toEqual([]);
    }
  });

  it('fails closed for repeated component or pin identity in declared inventories', () => {
    const sourceConstraint = fixtures[0]!.constraint;
    const duplicatedDevice = reviewDatasheetConstraints([sourceConstraint], nets, [
      ...devices,
      devices[0]!,
    ]);
    expect(duplicatedDevice.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'incomplete_or_ambiguous',
    });
    const duplicatedPinDevice = {
      ...devices[0]!,
      pins: [...(devices[0]!.pins ?? []), devices[0]!.pins![0]!],
    };
    const duplicatedPin = reviewDatasheetConstraints([sourceConstraint], nets, [
      duplicatedPinDevice,
      devices[1]!,
    ]);
    expect(duplicatedPin.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'incomplete_or_ambiguous',
    });
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
