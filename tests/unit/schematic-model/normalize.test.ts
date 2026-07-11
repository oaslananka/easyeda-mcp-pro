import { describe, expect, it } from 'vitest';
import {
  buildCanonicalSchematicModel,
  normalizeSchematicComponent,
  normalizeSchematicNets,
  resolveMetadataExpression,
} from '../../../src/schematic-model/normalize.js';

describe('resolveMetadataExpression', () => {
  it('resolves EasyEDA expression-style attributes case-insensitively', () => {
    const result = resolveMetadataExpression('={Value}', {
      value: '10k',
    });
    expect(result).toEqual({ raw: '={Value}', resolved: '10k', expressionKey: 'Value' });
  });

  it('leaves unresolved expressions intact', () => {
    expect(resolveMetadataExpression('={Unknown}', {})).toEqual({
      raw: '={Unknown}',
      resolved: '={Unknown}',
      expressionKey: undefined,
    });
  });
});

describe('normalizeSchematicComponent', () => {
  it('classifies real imported parts and resolves value/footprint metadata', () => {
    const component = normalizeSchematicComponent({
      primitiveId: 'ie100',
      componentType: 'part',
      reference: 'U?',
      value: '={Value}',
      footprint: '={Footprint}',
      deviceName: 'symbols_RP2040',
      attributes: {
        Value: 'RP2040',
        Footprint: 'Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm',
      },
    });

    expect(component.componentKind).toBe('part');
    expect(component.bomEligible).toBe(true);
    expect(component.electricalEligible).toBe(true);
    expect(component.symbolSource).toBe('imported');
    expect(component.annotated).toBe(false);
    expect(component.value).toBe('RP2040');
    expect(component.footprint).toContain('QFN-56');
  });

  it('excludes sheet frames and power symbols from the BOM', () => {
    const sheet = normalizeSchematicComponent({ componentType: 'sheet', reference: '' });
    const power = normalizeSchematicComponent({
      componentType: 'netflag',
      reference: '#PWR01',
      value: 'GND',
    });

    expect(sheet.componentKind).toBe('sheet-frame');
    expect(sheet.bomEligible).toBe(false);
    expect(power.componentKind).toBe('power-symbol');
    expect(power.bomEligible).toBe(false);
    expect(power.electricalEligible).toBe(true);
  });
});

describe('normalizeSchematicNets', () => {
  it('merges recognized aliases and deduplicates identical nodes', () => {
    const nets = normalizeSchematicNets([
      {
        netName: 'SYMBOLS_GND',
        nodes: [
          { component: 'U1', pin: '1' },
          { component: 'U1', pin: '1' },
        ],
      },
      {
        netName: 'GND',
        nodes: [{ component: 'C1', pin: '2' }],
      },
    ]);

    expect(nets).toHaveLength(1);
    expect(nets[0]).toMatchObject({
      canonicalNetName: 'GND',
      rawNetNames: ['GND', 'SYMBOLS_GND'],
      kind: 'ground',
      imported: true,
    });
    expect(nets[0]?.nodes).toHaveLength(2);
  });
});

describe('buildCanonicalSchematicModel', () => {
  it('builds summary and diagnostics for imported unannotated parts', () => {
    const model = buildCanonicalSchematicModel({
      document: { projectId: 'active', schematicName: 'servo-module', pageName: 'P1' },
      components: [
        {
          primitiveId: 'u1',
          componentType: 'part',
          reference: 'U?',
          value: 'symbols_RP2040',
          footprint: '',
        },
        { primitiveId: 'sheet', componentType: 'sheet' },
        { primitiveId: 'pwr', componentType: 'netflag', reference: '#PWR01', value: 'GND' },
      ],
      nets: [{ netName: 'SYMBOLS_+3V3', nodes: [{ component: 'U?', pin: '1' }] }],
    });

    expect(model.summary).toEqual({
      componentCount: 3,
      bomComponentCount: 1,
      electricalComponentCount: 2,
      netCount: 1,
      importedComponentCount: 1,
    });
    expect(model.nets[0]?.canonicalNetName).toBe('+3V3');
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['COMPONENT_UNANNOTATED', 'COMPONENT_MISSING_FOOTPRINT']),
    );
  });
});
