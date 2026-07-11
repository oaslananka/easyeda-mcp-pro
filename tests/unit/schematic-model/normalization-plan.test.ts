import { describe, expect, it } from 'vitest';
import { previewImportedNormalization } from '../../../src/schematic-model/normalization-plan.js';
import { buildCanonicalSchematicModel } from '../../../src/schematic-model/normalize.js';

describe('previewImportedNormalization', () => {
  it('produces a deterministic read-only plan for imported aliases and U? references', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        {
          primitiveId: 'u-existing',
          componentType: 'part',
          reference: 'U1',
          value: 'NE555',
          footprint: 'DIP-8',
        },
        {
          primitiveId: 'u-imported',
          componentType: 'part',
          reference: 'U?',
          value: '={Value}',
          footprint: '={Footprint}',
          symbolSource: 'KiCad imported',
          attributes: { Value: 'RP2040', Footprint: 'QFN-56' },
        },
      ],
      nets: [
        { netName: 'SYMBOLS_+3V3', nodes: [{ component: 'U?', pin: '1' }] },
        { netName: 'SYMBOLS_GND', nodes: [{ component: 'U?', pin: '2' }] },
      ],
    });

    const first = previewImportedNormalization(model);
    const second = previewImportedNormalization(structuredClone(model));

    expect(second).toEqual(first);
    expect(first.planId).toMatch(/^norm_[a-f0-9]{16}$/);
    expect(first.modelHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.readOnly).toBe(true);
    expect(first.status).toBe('ready');
    expect(first.applicationReady).toBe(true);
    expect(first.safeToAutoApply).toBe(true);
    expect(first.summary).toMatchObject({
      operationCount: 5,
      netRenameCount: 2,
      referenceAnnotationCount: 1,
      valueUpdateCount: 1,
      footprintUpdateCount: 1,
      blockerCount: 0,
    });
    expect(first.operations).toContainEqual(
      expect.objectContaining({
        kind: 'annotate-reference',
        targetId: 'u-imported',
        after: { reference: 'U2' },
        automatic: true,
      }),
    );
    expect(first.operations).toContainEqual(
      expect.objectContaining({
        kind: 'normalize-net-name',
        before: { netName: 'SYMBOLS_+3V3' },
        after: { netName: '+3V3' },
      }),
    );
  });

  it('blocks incomplete source inventories', () => {
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

    const plan = previewImportedNormalization(model, { sourceTruncated: true });

    expect(plan.status).toBe('blocked');
    expect(plan.applicationReady).toBe(false);
    expect(plan.safeToAutoApply).toBe(false);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_COMPONENTS_TRUNCATED' }),
    );
  });

  it('blocks duplicate references and missing metadata without overrides', () => {
    const model = buildCanonicalSchematicModel({
      components: [
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
          reference: 'R1',
          value: '',
          footprint: '',
        },
      ],
    });

    const plan = previewImportedNormalization(model);

    expect(plan.status).toBe('blocked');
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        'DUPLICATE_COMPONENT_REFERENCE',
        'COMPONENT_VALUE_REQUIRES_INPUT',
        'COMPONENT_FOOTPRINT_REQUIRES_INPUT',
      ]),
    );
  });

  it('turns explicit metadata and BOM overrides into confirmation-required operations', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        {
          primitiveId: 'c1',
          componentType: 'part',
          reference: 'C1',
          value: '',
          footprint: '',
        },
        {
          primitiveId: 'helper',
          componentType: 'custom-helper',
          reference: 'X1',
          value: 'Imported module',
        },
      ],
    });

    const plan = previewImportedNormalization(model, {
      componentOverrides: [
        { componentId: 'c1', value: '100nF', footprint: 'C_0603' },
        { componentId: 'helper', bomEligible: false },
      ],
    });

    expect(plan.status).toBe('review');
    expect(plan.applicationReady).toBe(true);
    expect(plan.safeToAutoApply).toBe(false);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.summary.confirmationOperationCount).toBe(3);
    expect(plan.operations.map((operation) => operation.kind)).toEqual(
      expect.arrayContaining(['set-component-value', 'set-component-footprint', 'classify-bom']),
    );
  });

  it('blocks overrides that target stale component IDs', () => {
    const model = buildCanonicalSchematicModel({});

    const plan = previewImportedNormalization(model, {
      componentOverrides: [{ componentId: 'missing', value: '10k' }],
    });

    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: 'OVERRIDE_COMPONENT_NOT_FOUND',
        componentId: 'missing',
      }),
    );
  });

  it('returns noop for a clean native design and preserves arbitrary user net names', () => {
    const model = buildCanonicalSchematicModel({
      components: [
        {
          primitiveId: 'u1',
          componentType: 'part',
          reference: 'U1',
          value: 'RP2040',
          footprint: 'QFN-56',
          deviceUuid: 'native',
        },
      ],
      nets: [{ netName: 'SYMBOLS_CUSTOM_DATA', nodes: [{ component: 'U1', pin: '1' }] }],
    });

    const plan = previewImportedNormalization(model);

    expect(plan.status).toBe('noop');
    expect(plan.applicationReady).toBe(true);
    expect(plan.safeToAutoApply).toBe(true);
    expect(plan.operations).toEqual([]);
  });

  it('requires confirmation when an imported alias would converge with another raw name', () => {
    const model = buildCanonicalSchematicModel({
      nets: [
        { netName: 'GND', nodes: [{ component: 'U1', pin: '1' }] },
        { netName: 'SYMBOLS_GND', nodes: [{ component: 'C1', pin: '2' }] },
      ],
    });

    const plan = previewImportedNormalization(model);

    expect(plan.status).toBe('review');
    expect(plan.summary.netRenameCount).toBe(1);
    expect(plan.operations[0]).toMatchObject({
      kind: 'normalize-net-name',
      requiresConfirmation: true,
      risk: 'medium',
    });
  });

  it('preserves imported power flags and emits a warning instead of a rename operation', () => {
    const model = buildCanonicalSchematicModel({
      nets: [{ netName: 'SYMBOLS_PWR_FLAG', nodes: [] }],
    });

    const plan = previewImportedNormalization(model);

    expect(plan.status).toBe('review');
    expect(plan.operations).toEqual([]);
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'POWER_FLAG_PRESERVED' }));
  });

  it('keeps hashes stable across component and override input ordering', () => {
    const firstModel = buildCanonicalSchematicModel({
      components: [
        { primitiveId: 'c1', componentType: 'part', reference: 'C1', value: '', footprint: '' },
        { primitiveId: 'r1', componentType: 'part', reference: 'R1', value: '', footprint: '' },
      ],
    });
    const secondModel = buildCanonicalSchematicModel({
      components: [...firstModel.components].reverse().map((component) => ({
        primitiveId: component.runtimePrimitiveId,
        componentType: 'part',
        reference: component.reference,
        value: component.rawValue,
        footprint: component.rawFootprint,
      })),
    });
    const first = previewImportedNormalization(firstModel, {
      componentOverrides: [
        { componentId: 'c1', value: '100nF', footprint: 'C_0603' },
        { componentId: 'r1', value: '10k', footprint: 'R_0603' },
      ],
    });
    const second = previewImportedNormalization(secondModel, {
      componentOverrides: [
        { componentId: 'r1', value: '10k', footprint: 'R_0603' },
        { componentId: 'c1', value: '100nF', footprint: 'C_0603' },
      ],
    });

    expect(second.modelHash).toBe(first.modelHash);
    expect(second.planId).toBe(first.planId);
    expect(second.operations).toEqual(first.operations);
  });

  it('rejects duplicate component overrides during schema validation', () => {
    const model = buildCanonicalSchematicModel({});

    expect(() =>
      previewImportedNormalization(model, {
        componentOverrides: [
          { componentId: 'c1', value: '1nF' },
          { componentId: 'c1', value: '10nF' },
        ],
      }),
    ).toThrow(/Duplicate component override/);
  });

  it('does not emit metadata operations when an override equals the current concrete value', () => {
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

    const plan = previewImportedNormalization(model, {
      componentOverrides: [{ componentId: 'r1', value: '10k', footprint: 'R_0603' }],
    });

    expect(plan.status).toBe('noop');
    expect(plan.operations).toEqual([]);
  });
});
