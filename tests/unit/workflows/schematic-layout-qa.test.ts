import { describe, expect, it } from 'vitest';
import {
  compareSchematicLayoutQa,
  evaluateSchematicLayoutQa,
  type LayoutQaInput,
  type LayoutQaPrimitive,
} from '../../../src/workflows/schematic-layout-qa.js';

const component = (
  id: string,
  x: number,
  y: number,
  width = 60,
  height = 40,
): LayoutQaPrimitive => ({
  id,
  primitiveType: 'component',
  ref: id,
  combinedBounds: { x, y, width, height },
  bodyBounds: { x, y, width, height },
  pinConnections: [{ pin: '1', netName: 'GND', connected: true }],
  geometrySource: 'runtime',
});

const input = (primitives: LayoutQaPrimitive[] = []): LayoutQaInput => ({
  projectId: 'layout-qa',
  sheet: {
    pageBounds: { x: 0, y: 0, width: 1000, height: 700 },
    drawableBounds: { x: 10, y: 10, width: 980, height: 680 },
    titleBlockKeepout: { x: 700, y: 10, width: 290, height: 150 },
  },
  primitives,
  runtime: {
    bridgeVerified: true,
    documentVerified: true,
    drcAvailable: true,
    ercAvailable: true,
    drc: [],
    erc: [],
  },
  visual: { captureAvailable: true, deterministicViewport: true, findings: [] },
});

describe('schematic layout QA', () => {
  it('rejects rendered bounds entering the title block even when the origin is outside', () => {
    const primitive = component('U1', 660, 100, 80, 40);
    const result = evaluateSchematicLayoutQa(input([primitive]));

    expect(primitive.combinedBounds.x).toBeLessThan(700);
    expect(result.status).toBe('fail');
    expect(result.commitBlocked).toBe(true);
    expect(result.summary.criticalIssueCodes).toContain('TITLE_BLOCK_OVERLAP');
    expect(result.scores.overall).toBeGreaterThan(0);
  });

  it('detects component, component-text, and text-text overlaps from rendered bounds', () => {
    const u1 = component('U1', 100, 100, 80, 60);
    u1.referenceBounds = { x: 110, y: 110, width: 30, height: 12 };
    const r1 = component('R1', 150, 120, 60, 30);
    r1.valueBounds = { x: 120, y: 110, width: 30, height: 12 };

    const result = evaluateSchematicLayoutQa(input([u1, r1]));
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toContain('COMPONENT_OVERLAP');
    expect(codes).toContain('COMPONENT_TEXT_OVERLAP');
    expect(codes).toContain('TEXT_TEXT_OVERLAP');
    expect(result.passed).toBe(false);
  });

  it('fails a cosmetic-only connectivity change regardless of aggregate score', () => {
    const qaInput = input([component('U1', 100, 100)]);
    qaInput.connectivity = {
      cosmeticOnly: true,
      beforeFingerprint: 'before',
      afterFingerprint: 'after',
      changedPins: ['U1.1'],
      changedWireEndpoints: ['wire-1'],
    };

    const result = evaluateSchematicLayoutQa(qaInput);

    expect(result.status).toBe('fail');
    expect(result.commitBlocked).toBe(true);
    expect(result.summary.criticalIssueCodes).toContain(
      'CONNECTIVITY_CHANGED_DURING_COSMETIC_EDIT',
    );
  });

  it('classifies native diagnostics and reports visual unavailability as inconclusive', () => {
    const qaInput = input();
    qaInput.visual = { captureAvailable: false };
    qaInput.runtime = {
      bridgeVerified: true,
      documentVerified: true,
      drcAvailable: true,
      ercAvailable: false,
      drc: [{ message: 'Power input has no power flag', severity: 'warning' }],
      erc: [{ message: 'Runtime check unsupported' }],
    };

    const result = evaluateSchematicLayoutQa(qaInput);

    expect(result.status).toBe('inconclusive');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'DRC_MISSING_POWER_FLAG',
        'ERC_RUNTIME_LIMITATION',
        'VISUAL_QA_UNAVAILABLE',
      ]),
    );
    expect(result.evidence.fullPageCapture).toBe(false);
  });

  it('validates topology, detached netports, relationships, and excessive wires', () => {
    const u1 = component('U1', 100, 100);
    u1.pinConnections = [{ pin: '1', netName: 'WRONG', connected: true }];
    const duplicate = component('dup', 300, 100);
    duplicate.ref = 'U1';
    const netport: LayoutQaPrimitive = {
      id: 'port-vcc',
      primitiveType: 'netport',
      netName: 'VCC',
      connected: false,
      combinedBounds: { x: 500, y: 300, width: 20, height: 10 },
      geometrySource: 'runtime',
    };
    const qaInput = input([u1, duplicate, netport]);
    qaInput.expected = {
      componentRefs: ['U1', 'R1'],
      pinMappings: [{ componentRef: 'U1', pin: '1', netName: 'GND' }],
    };
    qaInput.relationships = [{ sourceId: 'U1', targetId: 'dup', kind: 'support', maxDistance: 50 }];
    qaInput.wires = [
      {
        id: 'wire-long',
        netName: 'VCC',
        points: [
          { x: 0, y: 0 },
          { x: 900, y: 0 },
        ],
      },
    ];

    const result = evaluateSchematicLayoutQa(qaInput);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'DUPLICATE_REFERENCE',
        'EXPECTED_NET_MISMATCH',
        'DETACHED_NETPORT',
        'RELATED_COMPONENT_DISTANCE',
        'EXCESSIVE_WIRE_LENGTH',
      ]),
    );
  });

  it('compares new, unchanged, and resolved findings', () => {
    const before = evaluateSchematicLayoutQa(input([component('U1', 660, 100, 80, 40)]));
    const after = evaluateSchematicLayoutQa(input([component('U1', 100, 100, 80, 40)]));

    const comparison = compareSchematicLayoutQa(before, after);

    expect(comparison.resolvedIssues.map((issue) => issue.code)).toContain('TITLE_BLOCK_OVERLAP');
    expect(comparison.newIssues.map((issue) => issue.code)).not.toContain('TITLE_BLOCK_OVERLAP');
    expect(comparison.afterScore).toBeGreaterThan(comparison.beforeScore);
    expect(comparison.improved).toBe(true);
  });
});
