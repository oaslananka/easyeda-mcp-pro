import { describe, expect, it } from 'vitest';
import { collectSchematicLayoutGeometryIssues } from '../../../src/workflows/schematic-layout-qa-geometry-rules.js';
import type {
  LayoutQaInput,
  LayoutQaPrimitive,
} from '../../../src/workflows/schematic-layout-qa.js';

const thresholds = {
  componentClearance: 8,
  minimumUtilization: 0.12,
  maximumLocalDensity: 0.7,
};

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
  geometrySource: 'runtime',
});

const input = (primitives: LayoutQaPrimitive[]): LayoutQaInput => ({
  projectId: 'geometry-rules',
  sheet: {
    pageBounds: { x: 0, y: 0, width: 1000, height: 700 },
    drawableBounds: { x: 10, y: 10, width: 980, height: 680 },
    titleBlockKeepout: { x: 700, y: 10, width: 290, height: 150 },
  },
  primitives,
});

describe('schematic layout geometry rules', () => {
  it('collects boundary and hard-keepout violations without runtime dependencies', () => {
    const outside = component('U1', 980, 650, 40, 60);
    outside.geometrySource = 'derived';
    const keepout = component('R1', 300, 300, 40, 30);
    const qaInput = input([outside, keepout]);
    qaInput.sheet.hardKeepouts = [
      { id: 'reserved-zone', bounds: { x: 290, y: 290, width: 80, height: 80 } },
    ];

    const issues = collectSchematicLayoutGeometryIssues(qaInput, thresholds);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PAGE_BOUNDARY_OVERFLOW',
          affectedPrimitiveIds: ['U1'],
          source: 'derived_geometry',
          confidence: 0.85,
        }),
        expect.objectContaining({
          code: 'PAGE_BOUNDARY_OVERFLOW',
          affectedPrimitiveIds: ['R1'],
          message: expect.stringContaining('reserved-zone'),
        }),
      ]),
    );
  });

  it('composes component, text, and section conflict rules', () => {
    const u1 = component('U1', 100, 100, 80, 60);
    u1.referenceBounds = { x: 110, y: 110, width: 30, height: 12 };
    const r1 = component('R1', 150, 120, 60, 30);
    r1.valueBounds = { x: 120, y: 110, width: 30, height: 12 };
    const section: LayoutQaPrimitive = {
      id: 'section-power',
      primitiveType: 'section',
      blockId: 'power',
      combinedBounds: { x: 90, y: 90, width: 160, height: 100 },
      geometrySource: 'runtime',
    };

    const codes = collectSchematicLayoutGeometryIssues(input([u1, r1, section]), thresholds).map(
      (issue) => issue.code,
    );

    expect(codes).toEqual(
      expect.arrayContaining([
        'COMPONENT_OVERLAP',
        'COMPONENT_TEXT_OVERLAP',
        'TEXT_TEXT_OVERLAP',
        'SECTION_BOX_CONFLICT',
      ]),
    );
  });

  it('ignores a section intersecting only its own block members', () => {
    const member = component('U1', 120, 120);
    member.blockId = 'power';
    const section: LayoutQaPrimitive = {
      id: 'section-power',
      primitiveType: 'section',
      blockId: 'power',
      combinedBounds: { x: 100, y: 100, width: 120, height: 100 },
      geometrySource: 'runtime',
    };

    const issues = collectSchematicLayoutGeometryIssues(input([section, member]), thresholds);

    expect(issues.some((issue) => issue.code === 'SECTION_BOX_CONFLICT')).toBe(false);
  });

  it('collects global whitespace and local-density warnings from configured thresholds', () => {
    const qaInput = input([
      component('U1', 20, 20, 20, 20),
      component('U2', 50, 20, 20, 20),
      component('U3', 80, 20, 20, 20),
    ]);

    const codes = collectSchematicLayoutGeometryIssues(qaInput, {
      componentClearance: 0,
      minimumUtilization: 0.5,
      maximumLocalDensity: 0.005,
    }).map((issue) => issue.code);

    expect(codes).toContain('EXCESSIVE_WHITESPACE');
    expect(codes).toContain('LOCAL_CROWDING');
  });
});
