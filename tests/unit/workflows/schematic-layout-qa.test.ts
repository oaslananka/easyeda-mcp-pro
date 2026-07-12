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

  it('classifies intentional-NC and symbol-model-limitation diagnostics from message text', () => {
    const qaInput = input();
    qaInput.runtime = {
      bridgeVerified: true,
      documentVerified: true,
      drcAvailable: true,
      ercAvailable: true,
      drc: [{ message: 'Pin marked as intentional no connect' }],
      erc: [{ message: 'Symbol pin type mismatch' }],
    };

    const result = evaluateSchematicLayoutQa(qaInput);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toContain('DRC_INTENTIONAL_NC');
    expect(codes).toContain('ERC_SYMBOL_MODEL_LIMITATION');
    const intentional = result.issues.find((issue) => issue.code === 'DRC_INTENTIONAL_NC');
    expect(intentional?.severity).toBe('info');
    expect(intentional?.blocksCommit).toBe(false);
  });

  it('reports unverified bridge/document state after a write', () => {
    const qaInput = input([component('U1', 100, 100)]);
    qaInput.runtime = { bridgeVerified: false, documentVerified: true };

    const result = evaluateSchematicLayoutQa(qaInput);

    expect(result.issues.map((issue) => issue.code)).toContain('DOCUMENT_STATE_UNVERIFIED');
    expect(result.commitBlocked).toBe(true);
  });

  it('passes through supplied visual heuristic findings', () => {
    const qaInput = input([component('U1', 100, 100)]);
    qaInput.visual = {
      captureAvailable: true,
      findings: [
        {
          code: 'LOCAL_CROWDING',
          severity: 'warning',
          message: 'Visually crowded region',
          confidence: 0.7,
          affectedPrimitiveIds: ['U1'],
          remediation: 'Spread components out.',
        },
      ],
    };

    const result = evaluateSchematicLayoutQa(qaInput);
    const finding = result.issues.find((issue) => issue.source === 'visual_heuristic');

    expect(finding?.code).toBe('LOCAL_CROWDING');
    expect(finding?.confidence).toBe(0.7);
  });

  it('does not flag a satisfied pin mapping or an in-range relationship', () => {
    const u1 = component('U1', 100, 100);
    u1.pinConnections = [{ pin: '1', netName: 'GND', connected: true }];
    const r1 = component('R1', 130, 100);
    const qaInput = input([u1, r1]);
    qaInput.expected = { pinMappings: [{ componentRef: 'U1', pin: '1', netName: 'GND' }] };
    qaInput.relationships = [{ sourceId: 'U1', targetId: 'R1', kind: 'support', maxDistance: 500 }];

    const result = evaluateSchematicLayoutQa(qaInput);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).not.toContain('EXPECTED_NET_MISMATCH');
    expect(codes).not.toContain('RELATED_COMPONENT_DISTANCE');
  });

  it('includes pin-name, label, and annotation text regions in overlap detection', () => {
    const u1 = component('U1', 100, 100, 80, 40);
    u1.pinTextBounds = [{ x: 200, y: 100, width: 20, height: 10 }];
    u1.labelBounds = [{ x: 220, y: 100, width: 20, height: 10 }];
    u1.annotationBounds = [{ x: 240, y: 100, width: 20, height: 10 }];
    const overlappingText: LayoutQaPrimitive = {
      id: 'note-1',
      primitiveType: 'annotation',
      combinedBounds: { x: 205, y: 100, width: 20, height: 10 },
      geometrySource: 'runtime',
    };

    const result = evaluateSchematicLayoutQa(input([u1, overlappingText]));

    expect(result.issues.map((issue) => issue.code)).toContain('TEXT_TEXT_OVERLAP');
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

  it('keeps an unresolved issue in unchangedIssues across a comparison', () => {
    const stuck = () => input([component('U1', 660, 100, 80, 40)]);
    const before = evaluateSchematicLayoutQa(stuck());
    const after = evaluateSchematicLayoutQa(stuck());

    const comparison = compareSchematicLayoutQa(before, after);

    expect(comparison.unchangedIssues.map((issue) => issue.code)).toContain('TITLE_BLOCK_OVERLAP');
    expect(comparison.newIssues).toEqual([]);
    expect(comparison.resolvedIssues).toEqual([]);
    expect(comparison.improved).toBe(false);
  });

  it('flags a primitive that extends past the drawable page bounds', () => {
    const primitive = component('U1', -50, 100, 80, 40);
    const result = evaluateSchematicLayoutQa(input([primitive]));

    expect(result.issues.map((issue) => issue.code)).toContain('PAGE_BOUNDARY_OVERFLOW');
    expect(result.commitBlocked).toBe(true);
  });

  it('flags a section box that conflicts with a foreign component or the title block', () => {
    const section: LayoutQaPrimitive = {
      id: 'sec-1',
      primitiveType: 'section',
      blockId: 'block-a',
      combinedBounds: { x: 90, y: 90, width: 100, height: 100 },
      geometrySource: 'runtime',
    };
    const foreign = component('R1', 100, 100, 40, 20);
    foreign.blockId = 'block-b';

    const result = evaluateSchematicLayoutQa(input([section, foreign]));

    expect(result.issues.map((issue) => issue.code)).toContain('SECTION_BOX_CONFLICT');
  });

  it('does not flag a section box against its own member components', () => {
    const section: LayoutQaPrimitive = {
      id: 'sec-1',
      primitiveType: 'section',
      blockId: 'block-a',
      combinedBounds: { x: 90, y: 90, width: 100, height: 100 },
      geometrySource: 'runtime',
    };
    const member = component('R1', 100, 100, 40, 20);
    member.blockId = 'block-a';

    const result = evaluateSchematicLayoutQa(input([section, member]));

    expect(result.issues.map((issue) => issue.code)).not.toContain('SECTION_BOX_CONFLICT');
  });

  it('flags a dangling pin that is unconnected or has no net name', () => {
    const u1 = component('U1', 100, 100);
    u1.pinConnections = [{ pin: '1', connected: false }];

    const result = evaluateSchematicLayoutQa(input([u1]));

    expect(result.issues.map((issue) => issue.code)).toContain('DANGLING_PIN');
    expect(result.commitBlocked).toBe(true);
  });

  it('flags duplicate visible labels/netports sharing the same net name', () => {
    const labelA: LayoutQaPrimitive = {
      id: 'label-1',
      primitiveType: 'label',
      netName: 'VCC',
      combinedBounds: { x: 100, y: 100, width: 20, height: 10 },
      geometrySource: 'runtime',
    };
    const labelB: LayoutQaPrimitive = {
      id: 'label-2',
      primitiveType: 'netport',
      netName: 'VCC',
      connected: true,
      combinedBounds: { x: 300, y: 100, width: 20, height: 10 },
      geometrySource: 'runtime',
    };

    const result = evaluateSchematicLayoutQa(input([labelA, labelB]));

    expect(result.issues.map((issue) => issue.code)).toContain('DUPLICATE_NET_LABEL');
    expect(result.commitBlocked).toBe(false);
  });

  it('flags excessive whitespace when components occupy too little of the sheet', () => {
    const qaInput = input([
      component('U1', 20, 20, 10, 10),
      component('U2', 500, 400, 10, 10),
      component('U3', 800, 600, 10, 10),
    ]);

    const result = evaluateSchematicLayoutQa(qaInput);

    expect(result.issues.map((issue) => issue.code)).toContain('EXCESSIVE_WHITESPACE');
  });

  it('flags local crowding when a page region exceeds the density threshold', () => {
    const qaInput = input([
      component('U1', 20, 20, 200, 150),
      component('U2', 20, 20, 190, 140),
      component('U3', 20, 20, 180, 130),
    ]);

    const result = evaluateSchematicLayoutQa(qaInput);

    expect(result.issues.map((issue) => issue.code)).toContain('LOCAL_CROWDING');
  });
});
