import { describe, expect, it } from 'vitest';
import { validateSchematicModel } from '../../../src/schematic-model/model-validator.js';
import type {
  ComponentModel,
  NetModel,
  PinModel,
  ResolvedAttribute,
  SchematicModel,
  WireModel,
} from '../../../src/schematic-model/geometry-model.js';

const resolved = (value: string): ResolvedAttribute => ({ resolved: value, resolution: 'literal' });
const unresolved: ResolvedAttribute = { resolution: 'missing' };

function componentModel(
  overrides: Partial<ComponentModel> & Pick<ComponentModel, 'canonicalComponentId'>,
): ComponentModel {
  return {
    runtimePrimitiveId: `rt-${overrides.canonicalComponentId}`,
    reference: 'R1',
    symbolSource: 'native-easyeda',
    componentKind: 'part',
    classificationConfidence: 'high',
    classificationReasons: [],
    bomEligible: true,
    electricalEligible: true,
    dnp: false,
    pinIds: [],
    metadata: {
      value: resolved('10k'),
      manufacturerPart: unresolved,
      lcscNumber: unresolved,
      footprint: resolved('0402'),
      deviceName: unresolved,
      description: unresolved,
      datasheet: unresolved,
      dnp: false,
      rawAttributes: {},
    },
    raw: {},
    ...overrides,
  };
}

function pinModel(
  overrides: Partial<PinModel> & Pick<PinModel, 'canonicalPinId' | 'canonicalComponentId'>,
): PinModel {
  return {
    number: '1',
    electricalType: 'passive',
    baseElectricalType: 'passive',
    hidden: false,
    stacked: false,
    internallyConnected: false,
    required: true,
    deliberateNoConnect: false,
    noConnectAllowed: false,
    mechanicallyUnused: false,
    netIds: [],
    raw: {},
    ...overrides,
  };
}

function netModel(overrides: Partial<NetModel> & Pick<NetModel, 'canonicalNetId'>): NetModel {
  return {
    rawNetName: overrides.canonicalNetId,
    canonicalNetName: overrides.canonicalNetId,
    nameCategory: 'signal',
    excludedFromUserSignals: false,
    nodes: [],
    pinIds: [],
    raw: {},
    ...overrides,
  };
}

function wireModel(overrides: Partial<WireModel> & Pick<WireModel, 'canonicalWireId'>): WireModel {
  return {
    runtimePrimitiveId: `rt-${overrides.canonicalWireId}`,
    points: [],
    raw: {},
    ...overrides,
  };
}

function baseModel(overrides: Partial<SchematicModel> = {}): SchematicModel {
  return {
    schemaVersion: '1.0',
    modelHash: 'hash',
    document: { documentId: 'doc-1' },
    components: [],
    pins: [],
    nets: [],
    wires: [],
    labels: [],
    powerSymbols: [],
    noConnects: [],
    buses: [],
    sheets: [],
    texts: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('validateSchematicModel', () => {
  it('reports valid with no diagnostics for a clean model', () => {
    const model = baseModel({
      components: [componentModel({ canonicalComponentId: 'c1', pinIds: ['p1'] })],
      pins: [pinModel({ canonicalPinId: 'p1', canonicalComponentId: 'c1', netIds: ['n1'] })],
      nets: [netModel({ canonicalNetId: 'n1', pinIds: ['p1'] })],
    });
    const result = validateSchematicModel(model);
    expect(result).toEqual({ valid: true, diagnostics: [], errors: [], warnings: [] });
  });

  it('carries forward pre-existing diagnostics from the model', () => {
    const model = baseModel({
      diagnostics: [{ code: 'PRE_EXISTING', severity: 'info', message: 'note' }],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.valid).toBe(true);
  });

  it('flags duplicate canonical component, pin, and net ids', () => {
    const model = baseModel({
      components: [
        componentModel({ canonicalComponentId: 'c1' }),
        componentModel({ canonicalComponentId: 'c1' }),
      ],
      pins: [
        pinModel({ canonicalPinId: 'p1', canonicalComponentId: 'c1' }),
        pinModel({ canonicalPinId: 'p1', canonicalComponentId: 'c1' }),
      ],
      nets: [netModel({ canonicalNetId: 'n1' }), netModel({ canonicalNetId: 'n1' })],
    });
    const result = validateSchematicModel(model);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining(['DUPLICATE_COMPONENT_ID', 'DUPLICATE_PIN_ID', 'DUPLICATE_NET_ID']),
    );
    expect(result.valid).toBe(false);
  });

  it('flags duplicate references only among BOM-eligible components', () => {
    const model = baseModel({
      components: [
        componentModel({ canonicalComponentId: 'c1', reference: 'R1', bomEligible: true }),
        componentModel({ canonicalComponentId: 'c2', reference: 'r1', bomEligible: true }),
        componentModel({ canonicalComponentId: 'c3', reference: 'R1', bomEligible: false }),
      ],
    });
    const result = validateSchematicModel(model);
    const duplicateRefDiagnostics = result.diagnostics.filter(
      (d) => d.code === 'DUPLICATE_REFERENCE',
    );
    expect(duplicateRefDiagnostics).toHaveLength(2);
    expect(duplicateRefDiagnostics.map((d) => d.canonicalComponentId).sort()).toEqual(['c1', 'c2']);
  });

  it('flags a BOM-eligible component with a missing or placeholder reference', () => {
    const model = baseModel({
      components: [
        componentModel({ canonicalComponentId: 'c1', reference: undefined }),
        componentModel({ canonicalComponentId: 'c2', reference: 'R?' }),
      ],
    });
    const result = validateSchematicModel(model);
    const missingRef = result.diagnostics.filter((d) => d.code === 'MISSING_REFERENCE');
    expect(missingRef).toHaveLength(2);
  });

  it('flags a BOM-eligible component with no resolved value or footprint', () => {
    const model = baseModel({
      components: [
        componentModel({
          canonicalComponentId: 'c1',
          metadata: {
            value: unresolved,
            manufacturerPart: unresolved,
            lcscNumber: unresolved,
            footprint: unresolved,
            deviceName: unresolved,
            description: unresolved,
            datasheet: unresolved,
            dnp: false,
            rawAttributes: {},
          },
        }),
      ],
    });
    const result = validateSchematicModel(model);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['MISSING_VALUE', 'MISSING_FOOTPRINT']));
  });

  it('does not flag missing value/reference/footprint for a non-BOM-eligible component', () => {
    const model = baseModel({
      components: [
        componentModel({
          canonicalComponentId: 'c1',
          reference: undefined,
          bomEligible: false,
          metadata: {
            value: unresolved,
            manufacturerPart: unresolved,
            lcscNumber: unresolved,
            footprint: unresolved,
            deviceName: unresolved,
            description: unresolved,
            datasheet: unresolved,
            dnp: false,
            rawAttributes: {},
          },
        }),
      ],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics).toEqual([]);
  });

  it('flags a component referencing a missing canonical pin', () => {
    const model = baseModel({
      components: [componentModel({ canonicalComponentId: 'c1', pinIds: ['missing-pin'] })],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'COMPONENT_PIN_MISSING')).toBe(true);
  });

  it('flags a pin referencing a missing component', () => {
    const model = baseModel({
      pins: [pinModel({ canonicalPinId: 'p1', canonicalComponentId: 'missing-component' })],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'PIN_COMPONENT_MISSING')).toBe(true);
  });

  it('flags a pin referencing a missing net', () => {
    const model = baseModel({
      components: [componentModel({ canonicalComponentId: 'c1' })],
      pins: [
        pinModel({ canonicalPinId: 'p1', canonicalComponentId: 'c1', netIds: ['missing-net'] }),
      ],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'PIN_NET_MISSING')).toBe(true);
  });

  it('flags a pin that belongs to multiple canonical nets', () => {
    const model = baseModel({
      components: [componentModel({ canonicalComponentId: 'c1' })],
      pins: [
        pinModel({
          canonicalPinId: 'p1',
          canonicalComponentId: 'c1',
          netIds: ['n1', 'n2'],
        }),
      ],
      nets: [netModel({ canonicalNetId: 'n1' }), netModel({ canonicalNetId: 'n2' })],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'PIN_ON_MULTIPLE_NETS')).toBe(true);
  });

  it('flags a pin marked deliberate no-connect that is still on a net', () => {
    const model = baseModel({
      components: [componentModel({ canonicalComponentId: 'c1' })],
      pins: [
        pinModel({
          canonicalPinId: 'p1',
          canonicalComponentId: 'c1',
          netIds: ['n1'],
          deliberateNoConnect: true,
        }),
      ],
      nets: [netModel({ canonicalNetId: 'n1' })],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'NO_CONNECT_ON_CONNECTED_PIN')).toBe(true);
  });

  it('flags a net referencing a missing pin', () => {
    const model = baseModel({
      nets: [netModel({ canonicalNetId: 'n1', pinIds: ['missing-pin'] })],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'NET_PIN_MISSING')).toBe(true);
  });

  it('flags a zero-length wire segment', () => {
    const model = baseModel({
      wires: [
        wireModel({
          canonicalWireId: 'w1',
          points: [
            { x: 10, y: 10 },
            { x: 10, y: 10 },
          ],
        }),
      ],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'ZERO_LENGTH_WIRE_SEGMENT')).toBe(true);
  });

  it('flags a duplicate wire segment sharing endpoints on the same net', () => {
    const model = baseModel({
      wires: [
        wireModel({
          canonicalWireId: 'w1',
          canonicalNetName: 'SIG',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        }),
        wireModel({
          canonicalWireId: 'w2',
          canonicalNetName: 'SIG',
          points: [
            { x: 10, y: 0 },
            { x: 0, y: 0 },
          ],
        }),
      ],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'DUPLICATE_WIRE_SEGMENT')).toBe(true);
  });

  it('does not treat identical-endpoint segments on different nets as duplicates', () => {
    const model = baseModel({
      wires: [
        wireModel({
          canonicalWireId: 'w1',
          canonicalNetName: 'SIG_A',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        }),
        wireModel({
          canonicalWireId: 'w2',
          canonicalNetName: 'SIG_B',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
          ],
        }),
      ],
    });
    const result = validateSchematicModel(model);
    expect(result.diagnostics.some((d) => d.code === 'DUPLICATE_WIRE_SEGMENT')).toBe(false);
  });

  it('separates diagnostics into errors and warnings and marks the model invalid on any error', () => {
    const model = baseModel({
      components: [componentModel({ canonicalComponentId: 'c1', reference: undefined })],
    });
    const result = validateSchematicModel(model);
    expect(result.warnings.some((d) => d.code === 'MISSING_REFERENCE')).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
