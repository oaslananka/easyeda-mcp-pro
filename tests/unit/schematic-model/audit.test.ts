import { describe, expect, it } from 'vitest';
import { auditImportedDesign } from '../../../src/schematic-model/audit.js';
import { buildCanonicalSchematicModel } from '../../../src/schematic-model/normalize.js';

describe('auditImportedDesign', () => {
  it('reports imported aliases and actionable component problems without mutating the model', () => {
    const model = buildCanonicalSchematicModel({
      document: { projectId: 'servo-module' },
      components: [
        {
          primitiveId: 'u-a',
          componentType: 'part',
          reference: 'U?',
          value: '={Value}',
          footprint: '',
          symbolSource: 'KiCad imported',
        },
        {
          primitiveId: 'r-a',
          componentType: 'part',
          reference: 'R1',
          value: '10k',
          footprint: 'R_0603',
        },
        {
          primitiveId: 'r-b',
          componentType: 'part',
          reference: 'r1',
          value: '1k',
          footprint: 'R_0603',
        },
        {
          primitiveId: 'helper-a',
          componentType: 'custom-helper',
          reference: 'X1',
          value: 'Imported helper',
        },
      ],
      nets: [
        { netName: 'SYMBOLS_GND', nodes: [{ component: 'U?', pin: '1' }] },
        { netName: 'GND', nodes: [{ component: 'R1', pin: '2' }] },
        { netName: 'SYMBOLS_+3V3', nodes: [{ component: 'U?', pin: '2' }] },
        { netName: 'SYMBOLS_PWR_FLAG', nodes: [] },
      ],
    });
    const before = structuredClone(model);

    const result = auditImportedDesign(model);

    expect(model).toEqual(before);
    expect(result.status).toBe('blocked');
    expect(result.readOnly).toBe(true);
    expect(result.safeToNormalize).toBe(false);
    expect(result.summary.duplicateReferenceCount).toBe(1);
    expect(result.summary.unannotatedComponentCount).toBe(1);
    expect(result.summary.missingFootprintCount).toBe(1);
    expect(result.summary.unresolvedExpressionCount).toBe(1);
    expect(result.summary.ambiguousBomCount).toBe(1);
    expect(result.summary.importedNetCount).toBe(3);
    expect(result.summary.aliasedNetCount).toBe(1);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'DUPLICATE_COMPONENT_REFERENCE',
        severity: 'error',
        componentRef: 'R1',
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'IMPORTED_NET_ALIAS', netName: '+3V3' }),
    );
    expect(result.normalizationPreview.netAliases).toContainEqual(
      expect.objectContaining({
        canonicalNetName: 'GND',
        rawNetNames: ['GND', 'SYMBOLS_GND'],
      }),
    );
    expect(result.normalizationPreview.componentRepairs).toContainEqual(
      expect.objectContaining({
        componentId: 'u-a',
        actions: expect.arrayContaining([
          'annotate-reference',
          'assign-footprint',
          'resolve-value-expression',
        ]),
      }),
    );
  });

  it('can suppress informational findings while retaining the normalization preview', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        {
          primitiveId: 'u1',
          componentType: 'part',
          reference: 'U1',
          value: 'RP2040',
          footprint: 'QFN-56',
          deviceUuid: 'native-device',
        },
      ],
      nets: [{ netName: 'SYMBOLS_GND', nodes: [{ component: 'U1', pin: 'GND' }] }],
    });

    const result = auditImportedDesign(model, { includeInfo: false });

    expect(result.status).toBe('clean');
    expect(result.summary.infoCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.summary.importedNetCount).toBe(1);
    expect(result.normalizationPreview.netAliases).toHaveLength(1);
  });

  it('does not treat power symbols or power flags as duplicate BOM references', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        { primitiveId: 'p1', componentType: 'netflag', reference: '#PWR01', value: 'GND' },
        { primitiveId: 'p2', componentType: 'netflag', reference: '#PWR01', value: 'GND' },
        { primitiveId: 'f1', componentType: 'netflag', reference: '#FLG01', value: 'PWR_FLAG' },
      ],
    });

    const result = auditImportedDesign(model);

    expect(result.summary.duplicateReferenceCount).toBe(0);
    expect(
      result.findings.some((finding) => finding.code === 'DUPLICATE_COMPONENT_REFERENCE'),
    ).toBe(false);
  });

  it('returns review instead of blocked for fixable metadata warnings only', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        {
          primitiveId: 'c1',
          componentType: 'part',
          reference: 'C1',
          value: '100nF',
          footprint: '',
        },
      ],
    });

    const result = auditImportedDesign(model, { includeInfo: false });

    expect(result.status).toBe('review');
    expect(result.safeToNormalize).toBe(true);
    expect(result.summary.errorCount).toBe(0);
    expect(result.summary.warningCount).toBe(1);
  });

  it('marks a truncated source inventory as incomplete and unsafe to normalize', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        {
          primitiveId: 'r1',
          componentType: 'part',
          reference: 'R1',
          value: '10k',
          footprint: 'R_0603',
        },
      ],
    });

    const result = auditImportedDesign(model, { includeInfo: false, sourceTruncated: true });

    expect(result.status).toBe('review');
    expect(result.safeToNormalize).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_COMPONENTS_TRUNCATED',
        severity: 'warning',
      }),
    );
  });
});
