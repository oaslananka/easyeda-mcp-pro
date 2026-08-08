import { describe, expect, it } from 'vitest';
import { collectSchematicLayoutTopologyIssues } from '../../../src/workflows/schematic-layout-qa-topology-rules.js';
import type {
  LayoutQaInput,
  LayoutQaPrimitive,
} from '../../../src/workflows/schematic-layout-qa.js';

const component = (id: string, x: number): LayoutQaPrimitive => ({
  id,
  ref: id,
  primitiveType: 'component',
  combinedBounds: { x, y: 100, width: 60, height: 40 },
  pinConnections: [{ pin: '1', netName: 'GND', connected: true }],
  geometrySource: 'runtime',
});

const baseInput = (primitives: LayoutQaPrimitive[]): LayoutQaInput => ({
  projectId: 'topology-rules',
  sheet: {
    pageBounds: { x: 0, y: 0, width: 1000, height: 700 },
    drawableBounds: { x: 10, y: 10, width: 980, height: 680 },
    titleBlockKeepout: { x: 700, y: 10, width: 290, height: 150 },
  },
  primitives,
});

const thresholds = { relatedComponentDistance: 160, excessiveWireLength: 500 };

describe('schematic layout topology rules', () => {
  it('collects electrical identity and expected-topology failures independently of geometry QA', () => {
    const u1 = component('U1', 100);
    u1.pinConnections = [{ pin: '1', connected: false }];
    const duplicate = component('duplicate-u1', 300);
    duplicate.ref = 'U1';
    const port: LayoutQaPrimitive = {
      id: 'port-a',
      primitiveType: 'netport',
      netName: 'VCC',
      connected: false,
      combinedBounds: { x: 500, y: 300, width: 20, height: 10 },
      geometrySource: 'runtime',
    };
    const label: LayoutQaPrimitive = { ...port, id: 'label-a', primitiveType: 'label' };
    const input = baseInput([u1, duplicate, port, label]);
    input.expected = { componentRefs: ['R1'], netNames: ['MISSING'] };

    const codes = collectSchematicLayoutTopologyIssues(input, thresholds).map(
      (value) => value.code,
    );

    expect(codes).toEqual([
      'DANGLING_PIN',
      'DETACHED_NETPORT',
      'DUPLICATE_REFERENCE',
      'DUPLICATE_NET_LABEL',
      'EXPECTED_NET_MISMATCH',
      'EXPECTED_NET_MISMATCH',
    ]);
  });

  it('collects relationship distance and computed orthogonal wire length with existing thresholds', () => {
    const input = baseInput([component('U1', 100), component('R1', 500)]);
    input.relationships = [{ sourceId: 'U1', targetId: 'R1', kind: 'support', maxDistance: 50 }];
    input.wires = [
      {
        id: 'wire-a',
        netName: 'VCC',
        points: [
          { x: 0, y: 0 },
          { x: 400, y: 0 },
          { x: 400, y: 200 },
        ],
      },
    ];

    const issues = collectSchematicLayoutTopologyIssues(input, thresholds);

    expect(issues.map((value) => value.code)).toEqual([
      'RELATED_COMPONENT_DISTANCE',
      'EXCESSIVE_WIRE_LENGTH',
    ]);
    expect(issues[0]?.measured).toBe(400);
    expect(issues[1]?.measured).toBe(600);
  });
});
