import { describe, it, expect } from 'vitest';
import { compile, setValidationStatus, isReadyForEasyEDA } from '../../../src/circuit/compiler.js';
import { DESIGN_INTENT_SCHEMA_VERSION } from '../../../src/circuit/design-intent.js';
import { BoardType, ValidationStatus } from '../../../src/circuit/types.js';
import { CircuitError, CircuitErrorCode } from '../../../src/circuit/errors.js';

// ── Valid DesignIntent for compilation tests ──────────────────────────────

const powerSupplyIntent = {
  $schema: DESIGN_INTENT_SCHEMA_VERSION,
  project: {
    name: '12V-to-3V3 Power Supply',
    goal: 'A regulated 3.3V power supply from a 12V input, delivering 500mA',
    boardType: BoardType.PowerSupply,
  },
  requirements: {
    functionalBlocks: [
      {
        id: 'req-input',
        name: 'Input Protection',
        type: 'protection',
        purpose: 'Reverse polarity and over-current protection on 12V input',
      },
      {
        id: 'req-regulator',
        name: 'Voltage Regulator',
        type: 'power-management',
        purpose: '12V to 3.3V step-down conversion at 500mA',
      },
      {
        id: 'req-output',
        name: 'Output Filtering',
        type: 'power-management',
        purpose: 'Output ripple filtering and decoupling',
      },
    ],
    power: {
      rails: [
        {
          id: '12V_IN',
          voltage: 12.0,
          maxCurrentAmps: 1.0,
          description: 'Input from external supply',
        },
        {
          id: '3V3_OUT',
          voltage: 3.3,
          tolerance: 3,
          maxCurrentAmps: 0.5,
          description: 'Regulated output',
        },
      ],
    },
    mechanical: {
      widthMm: 30,
      heightMm: 20,
      layers: 2,
    },
    manufacturing: {
      volume: 'prototype',
      process: 'lead-free',
    },
  },
  assumptions: ['Input is a regulated 12V DC supply', 'Output load is max 500mA'],
  unknowns: ['Specific regulator IC not yet selected'],
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('compile', () => {
  it('compiles a valid DesignIntent into a CircuitIR', () => {
    const result = compile(powerSupplyIntent);
    expect(result.circuitIR).toBeDefined();
    expect(result.designIntent).toBeDefined();
    // Two rails with no explicit block/rail mapping is an ambiguous case;
    // the compiler flags it instead of guessing a device-to-rail assignment.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('2 power rails');

    // Check compilation output
    const cir = result.circuitIR;
    expect(cir.$schema).toBe('circuit-ir/v1');
    expect(cir.metadata.validationStatus).toBe(ValidationStatus.Draft);
    expect(cir.metadata.designIntentRef).toBe('12V-to-3V3 Power Supply');
  });

  it('compiles blocks from functional block requirements', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    // 3 functional blocks → 3 CircuitIR blocks
    expect(cir.blocks).toHaveLength(3);

    // Block IDs follow pattern
    expect(cir.blocks[0].id).toBe('block-req-input');
    expect(cir.blocks[1].id).toBe('block-req-regulator');
    expect(cir.blocks[2].id).toBe('block-req-output');

    // Each block has traceability refs
    for (const block of cir.blocks) {
      expect(block.designIntentRef).toHaveLength(1);
      expect(block.designIntentRef[0].requirementId).toBeDefined();
    }
  });

  it('compiles power rails from rail requirements', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    expect(cir.rails).toHaveLength(2);
    expect(cir.rails[0].voltage).toBe(12.0);
    expect(cir.rails[1].voltage).toBe(3.3);
    expect(cir.rails[1].tolerance).toBe(3);
  });

  it('creates a candidate device plan for each block', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    // One planned device per block
    expect(cir.devices).toHaveLength(3);
    for (const device of cir.devices) {
      expect(device.blockRef).toMatch(/^block-req-/);
      expect(device.designIntentRef).toHaveLength(1);
      expect(device.metadata.map((m) => m.key)).toEqual(
        expect.arrayContaining(['role', 'packageHint', 'planningState']),
      );
    }

    // Roles are inferred from block type/purpose and drive the refdes family.
    const byBlock = Object.fromEntries(cir.devices.map((d) => [d.blockRef, d]));
    expect(byBlock['block-req-input'].ref).toMatch(/^D\d+$/);
    expect(byBlock['block-req-regulator'].ref).toMatch(/^U\d+$/);
    // "Output ripple filtering and decoupling" is keyword-classified as a
    // passive support device, not a generic IC.
    expect(byBlock['block-req-output'].ref).toMatch(/^C\d+$/);
  });

  it('creates power nets for each rail plus a synthesized ground net', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    expect(cir.nets).toHaveLength(3);
    expect(cir.nets[0].name).toBe('12V_IN');
    expect(cir.nets[1].name).toBe('3V3_OUT');
    expect(cir.nets[2]).toMatchObject({ name: 'GND', type: 'ground', nodes: [] });
  });

  it('does not synthesize a ground net when there are no power rails', () => {
    // A design must declare at least one rail per DesignIntent validation,
    // so exercise the zero-rails compiler path directly via skipValidation.
    const zeroRailsIntent = {
      ...powerSupplyIntent,
      requirements: {
        ...powerSupplyIntent.requirements,
        electrical: {},
        power: { rails: [] },
        safety: {},
      },
    };
    const result = compile(zeroRailsIntent, { skipValidation: true });
    expect(result.circuitIR.nets.find((n) => n.name === 'GND')).toBeUndefined();
  });

  it('synthesizes power domains for each rail', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    expect(cir.powerDomains).toHaveLength(2);
    expect(cir.powerDomains[0]).toMatchObject({
      id: 'pd-rail-12V_IN',
      nominalVoltage: 12,
      sourceRailRef: 'rail-12V_IN',
      railRefs: ['rail-12V_IN'],
    });
    expect(cir.nets[0]).toMatchObject({
      railRef: 'rail-12V_IN',
      powerDomainRef: 'pd-rail-12V_IN',
      signalClassRef: 'sc-power',
    });
  });

  it('synthesizes signal classes from electrical intent', () => {
    const highSpeedIntent = {
      ...powerSupplyIntent,
      requirements: {
        ...powerSupplyIntent.requirements,
        electrical: { frequencyMaxHz: 48_000_000, currentMaxAmps: 1, vinMax: 12 },
      },
    };
    const result = compile(highSpeedIntent);
    const cir = result.circuitIR;

    expect(cir.signalClasses.map((signalClass) => signalClass.id)).toContain('sc-power');
    expect(cir.signalClasses.map((signalClass) => signalClass.id)).toContain('sc-high-speed');
    expect(cir.signalClasses.find((signalClass) => signalClass.id === 'sc-power')).toMatchObject({
      kind: 'power',
      netNames: ['12V_IN', '3V3_OUT'],
      routing: { traceWidthMm: 0.5, clearanceMm: 0.2 },
    });
  });

  it('synthesizes physical constraints from mechanical and safety intent', () => {
    const safetyIntent = {
      ...powerSupplyIntent,
      requirements: {
        ...powerSupplyIntent.requirements,
        mechanical: { ...powerSupplyIntent.requirements.mechanical, mountingHoles: true },
        safety: { isolation: true },
      },
    };
    const result = compile(safetyIntent);
    const cir = result.circuitIR;

    expect(cir.physicalConstraints.map((constraint) => constraint.id)).toEqual([
      'pc-board-outline',
      'pc-mounting-holes',
      'pc-isolation-clearance',
    ]);
  });

  it('wires devices to the sole power domain when there is exactly one rail', () => {
    const singleRailIntent = {
      $schema: DESIGN_INTENT_SCHEMA_VERSION,
      project: {
        name: 'USB Sensor Node',
        goal: 'A USB-powered MCU board reading a sensor over I2C',
        boardType: BoardType.McuBoard,
      },
      requirements: {
        functionalBlocks: [
          {
            id: 'req-usb',
            name: 'USB-C Connector',
            type: 'interface',
            purpose: 'USB-C connector for power and data',
          },
          {
            id: 'req-mcu',
            name: 'Main MCU',
            type: 'microcontroller',
            purpose: 'Runs the application firmware',
          },
          {
            id: 'req-sensor',
            name: 'Temperature Sensor',
            type: 'sensor',
            purpose: 'I2C temperature sensor',
          },
        ],
        power: {
          rails: [{ id: '5V_USB', voltage: 5.0, maxCurrentAmps: 0.5 }],
        },
        mechanical: { widthMm: 25, heightMm: 15, layers: 2 },
        manufacturing: {},
      },
      assumptions: [],
      unknowns: [],
    };

    const result = compile(singleRailIntent);
    const cir = result.circuitIR;

    // Unambiguous single-rail design: every device and the domain's
    // loadDeviceRefs get wired automatically, with no ambiguity warning.
    expect(result.warnings).toEqual([]);
    expect(cir.powerDomains).toHaveLength(1);
    expect(cir.powerDomains[0].loadDeviceRefs.sort()).toEqual(cir.devices.map((d) => d.id).sort());
    for (const device of cir.devices) {
      expect(device.powerDomainRef).toBe(cir.powerDomains[0].id);
    }

    // Role inference: connector, MCU/module, and sensor cases.
    const byBlock = Object.fromEntries(cir.devices.map((d) => [d.blockRef, d]));
    expect(byBlock['block-req-usb'].ref).toMatch(/^J\d+$/);
    expect(byBlock['block-req-mcu'].ref).toMatch(/^U\d+$/);
    expect(byBlock['block-req-sensor'].ref).toMatch(/^U\d+$/);

    // The connector block gets a synthesized candidate Interface.
    expect(cir.interfaces).toHaveLength(1);
    expect(cir.interfaces[0]).toMatchObject({
      name: 'USB-C Connector',
      type: 'connector',
      blockRef: 'block-req-usb',
      pinout: [],
    });
  });

  it('flags a generic/low-confidence role with a compiler warning', () => {
    const vagueIntent = {
      $schema: DESIGN_INTENT_SCHEMA_VERSION,
      project: {
        name: 'Custom Board',
        goal: 'A board with an unclassified block',
        boardType: BoardType.Custom,
      },
      requirements: {
        functionalBlocks: [
          {
            id: 'req-mystery',
            name: 'Mystery Block',
            type: 'custom',
            purpose: 'Something not yet decided',
          },
        ],
        power: { rails: [{ id: 'VCC', voltage: 3.3 }] },
        mechanical: {},
        manufacturing: {},
      },
      assumptions: [],
      unknowns: ['Component role has not been decided'],
    };

    const result = compile(vagueIntent);
    expect(result.warnings.some((w) => w.includes('generic placeholder device'))).toBe(true);
    const device = result.circuitIR.devices[0];
    expect(device.metadata).toContainEqual({ key: 'planningState', value: 'placeholder' });
  });

  it('preserves traceability IDs from DesignIntent to CircuitIR', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    // Each block's designIntentRef points back to the originating req id
    const blockIds = cir.blocks.map((b) => b.designIntentRef[0]?.requirementId);
    expect(blockIds).toContain('req-input');
    expect(blockIds).toContain('req-regulator');
    expect(blockIds).toContain('req-output');
  });

  it('copies mechanical constraints into PCB intent', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    expect(cir.pcb.widthMm).toBe(30);
    expect(cir.pcb.heightMm).toBe(20);
    expect(cir.pcb.layerCount).toBe(2);
  });

  it('copies manufacturing intent', () => {
    const result = compile(powerSupplyIntent);
    const cir = result.circuitIR;

    expect(cir.manufacturing.process).toBe('lead-free');
  });

  it('throws CircuitError on invalid DesignIntent', () => {
    expect(() => compile({ project: {} })).toThrow(CircuitError);
  });

  it('throws CircuitError with DESIGN_INTENT_INVALID code on bad input', () => {
    try {
      compile({ project: { name: 'Test' } } as unknown);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitError);
      expect((err as CircuitError).code).toBe(CircuitErrorCode.DESIGN_INTENT_INVALID);
    }
  });

  it('skips validation when skipValidation is true', () => {
    const raw = { project: { name: 'Raw' } } as unknown;
    // This would throw without skipValidation...
    // With skipValidation it will fail at output validation instead since
    // the raw input won't produce valid CircuitIR
    expect(() => compile(raw, { skipValidation: true })).toThrow();
  });
});

describe('setValidationStatus', () => {
  it('transitions draft to validated', () => {
    const result = compile(powerSupplyIntent);
    const validated = setValidationStatus(result.circuitIR, ValidationStatus.Validated);
    expect(validated.metadata.validationStatus).toBe(ValidationStatus.Validated);
  });

  it('transitions draft to rejected', () => {
    const result = compile(powerSupplyIntent);
    const rejected = setValidationStatus(result.circuitIR, ValidationStatus.Rejected);
    expect(rejected.metadata.validationStatus).toBe(ValidationStatus.Rejected);
  });

  it('returns a new object without mutating the original', () => {
    const result = compile(powerSupplyIntent);
    const original = result.circuitIR;
    const updated = setValidationStatus(original, ValidationStatus.Validated);
    expect(original.metadata.validationStatus).toBe(ValidationStatus.Draft);
    expect(updated.metadata.validationStatus).toBe(ValidationStatus.Validated);
  });
});

describe('isReadyForEasyEDA', () => {
  it('returns false for draft CircuitIR', () => {
    const result = compile(powerSupplyIntent);
    expect(isReadyForEasyEDA(result.circuitIR)).toBe(false);
  });

  it('returns true for validated CircuitIR', () => {
    const result = compile(powerSupplyIntent);
    const validated = setValidationStatus(result.circuitIR, ValidationStatus.Validated);
    expect(isReadyForEasyEDA(validated)).toBe(true);
  });

  it('returns false for rejected CircuitIR', () => {
    const result = compile(powerSupplyIntent);
    const rejected = setValidationStatus(result.circuitIR, ValidationStatus.Rejected);
    expect(isReadyForEasyEDA(rejected)).toBe(false);
  });
});
