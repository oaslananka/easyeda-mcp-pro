import { describe, expect, it } from 'vitest';
import {
  applyPreviewMovesToGeometry,
  previewLayoutAutofix,
  type LayoutAutofixAllowlist,
  type LayoutAutofixPreview,
  type LayoutAutofixPreviewInput,
  type LayoutAutofixPrimitive,
} from '../../../src/layout/autofix.js';
import type { SchematicSheetGeometry } from '../../../src/schematic-engine/geometry.js';

function sheet(overrides: Partial<SchematicSheetGeometry> = {}): SchematicSheetGeometry {
  return {
    bounds: { x: 0, y: 0, width: 1189, height: 841 },
    drawableBounds: { x: 40, y: 40, width: 1109, height: 761 },
    grid: 10,
    units: 'easyeda-coordinate',
    pageSize: 'A4',
    coordinateOrigin: { x: 0, y: 0, yAxis: 'up', source: 'live-readback' },
    geometrySource: 'live-readback',
    titleBlockBounds: { x: 800, y: 40, width: 349, height: 180 },
    ...overrides,
  };
}

function primitive(
  overrides: Partial<LayoutAutofixPrimitive> & Pick<LayoutAutofixPrimitive, 'id' | 'primitiveType'>,
): LayoutAutofixPrimitive {
  return {
    origin: { x: 100, y: 100 },
    combinedBounds: { x: 100, y: 100, width: 40, height: 20 },
    ...overrides,
  };
}

const fullAllowlist: LayoutAutofixAllowlist = {
  primitiveTypes: ['component', 'text', 'label', 'annotation', 'section-box', 'section-title'],
  properties: ['position', 'bounds'],
};

function previewInput(
  overrides: Partial<LayoutAutofixPreviewInput> & Pick<LayoutAutofixPreviewInput, 'primitives'>,
): LayoutAutofixPreviewInput {
  return {
    sheet: sheet(),
    allowlist: fullAllowlist,
    ...overrides,
  };
}

describe('previewLayoutAutofix violation detection', () => {
  it('reports no violations for well-formed, non-overlapping primitives', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [primitive({ id: 'A', primitiveType: 'component' })],
      }),
    );
    expect(result.violations).toEqual([]);
  });

  it('flags a primitive extending outside the drawable bounds', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({
            id: 'A',
            primitiveType: 'component',
            origin: { x: 0, y: 0 },
            combinedBounds: { x: 0, y: 0, width: 10, height: 10 },
          }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain('PAGE_BOUNDARY_OVERFLOW');
  });

  it('flags a primitive overlapping the title block', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({
            id: 'A',
            primitiveType: 'component',
            origin: { x: 850, y: 60 },
            combinedBounds: { x: 850, y: 60, width: 40, height: 20 },
          }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain('TITLE_BLOCK_OVERLAP');
  });

  it('does not check title-block overlap when the sheet has no title block bounds', () => {
    const result = previewLayoutAutofix(
      previewInput({
        sheet: sheet({ titleBlockBounds: undefined }),
        primitives: [
          primitive({
            id: 'A',
            primitiveType: 'component',
            origin: { x: 850, y: 60 },
            combinedBounds: { x: 850, y: 60, width: 40, height: 20 },
          }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).not.toContain('TITLE_BLOCK_OVERLAP');
  });

  it('flags two overlapping components as COMPONENT_OVERLAP', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'component' }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain('COMPONENT_OVERLAP');
  });

  it('flags an overlap involving a text-like primitive as TEXT_OVERLAP', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'label' }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain('TEXT_OVERLAP');
  });

  it('does not flag two overlapping section boxes against each other', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'section-box' }),
          primitive({ id: 'B', primitiveType: 'section-box' }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).not.toContain('COMPONENT_OVERLAP');
  });

  it('flags a section box that does not enclose its section content', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({
            id: 'box',
            primitiveType: 'section-box',
            sectionId: 'sec-1',
            origin: { x: 100, y: 100 },
            combinedBounds: { x: 100, y: 100, width: 20, height: 20 },
          }),
          primitive({
            id: 'child',
            primitiveType: 'component',
            sectionId: 'sec-1',
            origin: { x: 300, y: 300 },
            combinedBounds: { x: 300, y: 300, width: 40, height: 20 },
          }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain('SECTION_BOX_TOO_SMALL');
  });

  it('does not flag a section box that already encloses its content', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({
            id: 'box',
            primitiveType: 'section-box',
            sectionId: 'sec-1',
            origin: { x: 90, y: 90 },
            combinedBounds: { x: 90, y: 90, width: 200, height: 200 },
          }),
          primitive({
            id: 'child',
            primitiveType: 'component',
            sectionId: 'sec-1',
            origin: { x: 100, y: 100 },
            combinedBounds: { x: 100, y: 100, width: 40, height: 20 },
          }),
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).not.toContain('SECTION_BOX_TOO_SMALL');
  });
});

describe('previewLayoutAutofix move generation', () => {
  it('generates a position move for an overlap when the allowlist permits it', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'component' }),
        ],
      }),
    );
    expect(result.moves.length).toBeGreaterThan(0);
    expect(result.moves[0]?.resolvesViolationIds.length).toBeGreaterThan(0);
    expect(result.report.remaining).toEqual([]);
  });

  it('skips a violation when no primitive type in the allowlist can resolve it', () => {
    const result = previewLayoutAutofix(
      previewInput({
        allowlist: { primitiveTypes: [], properties: ['position'] },
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'component' }),
        ],
      }),
    );
    expect(result.moves).toEqual([]);
    expect(result.report.skipped.length).toBeGreaterThan(0);
    expect(result.report.remaining.length).toBeGreaterThan(0);
  });

  it('never moves a locked primitive', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'component', locked: true }),
          primitive({ id: 'B', primitiveType: 'component' }),
        ],
      }),
    );
    expect(result.moves.some((move) => move.primitiveId === 'A')).toBe(false);
  });

  it('never moves an electrical primitive type even if allowlisted', () => {
    const result = previewLayoutAutofix(
      previewInput({
        allowlist: { primitiveTypes: ['wire', 'component'], properties: ['position'] },
        primitives: [
          primitive({ id: 'A', primitiveType: 'wire' }),
          primitive({ id: 'B', primitiveType: 'component' }),
        ],
      }),
    );
    expect(result.moves.some((move) => move.primitiveId === 'A')).toBe(false);
  });

  it('stops generating moves once maxMoves is reached', () => {
    const result = previewLayoutAutofix(
      previewInput({
        maxMoves: 0,
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'component' }),
        ],
      }),
    );
    expect(result.moves).toEqual([]);
    expect(result.report.skipped[0]?.reason).toMatch(/move limit was reached/);
  });

  it('resizes a section box in place of moving it when both bounds and position are allowed', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({
            id: 'box',
            primitiveType: 'section-box',
            sectionId: 'sec-1',
            origin: { x: 100, y: 100 },
            combinedBounds: { x: 100, y: 100, width: 20, height: 20 },
          }),
          primitive({
            id: 'child',
            primitiveType: 'component',
            sectionId: 'sec-1',
            origin: { x: 100, y: 100 },
            combinedBounds: { x: 100, y: 100, width: 40, height: 20 },
          }),
        ],
      }),
    );
    const boxMove = result.moves.find((move) => move.primitiveId === 'box');
    expect(boxMove?.property).toBe('bounds');
  });

  it('skips a too-small section box when resizing it would overlap the title block', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({
            id: 'box',
            primitiveType: 'section-box',
            sectionId: 'sec-1',
            origin: { x: 780, y: 30 },
            combinedBounds: { x: 780, y: 30, width: 10, height: 10 },
          }),
          primitive({
            id: 'child',
            primitiveType: 'component',
            sectionId: 'sec-1',
            origin: { x: 780, y: 30 },
            combinedBounds: { x: 780, y: 30, width: 60, height: 30 },
          }),
        ],
      }),
    );
    const boxMove = result.moves.find((move) => move.primitiveId === 'box');
    expect(boxMove).toBeUndefined();
    expect(
      result.report.skipped.some((s) => s.violationId.startsWith('SECTION_BOX_TOO_SMALL')),
    ).toBe(true);
  });

  it('prefers text-type primitives as the move target and picks a deterministic tiebreak', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'label' }),
        ],
      }),
    );
    const move = result.moves.find((m) =>
      m.resolvesViolationIds.some((id) => id.includes('TEXT_OVERLAP')),
    );
    expect(move?.primitiveId).toBe('B');
  });

  it('does not move the same primitive twice across two violations', () => {
    const result = previewLayoutAutofix(
      previewInput({
        primitives: [
          primitive({ id: 'A', primitiveType: 'component' }),
          primitive({ id: 'B', primitiveType: 'component' }),
          primitive({ id: 'C', primitiveType: 'component' }),
        ],
      }),
    );
    const movedIds = result.moves.map((move) => move.primitiveId);
    expect(new Set(movedIds).size).toBe(movedIds.length);
  });
});

describe('applyPreviewMovesToGeometry', () => {
  function movePreview(overrides: Partial<LayoutAutofixPreview> = {}): LayoutAutofixPreview {
    return {
      mode: 'preview',
      requiresConfirmWrite: true,
      violations: [],
      moves: [],
      report: { fixed: [], skipped: [], remaining: [] },
      allowlist: fullAllowlist,
      ...overrides,
    };
  }

  it('returns a cloned copy of a primitive that has no matching move', () => {
    const original = primitive({ id: 'A', primitiveType: 'component' });
    const [result] = applyPreviewMovesToGeometry([original], movePreview());
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });

  it('applies a position move by translating origin and bounds', () => {
    const original = primitive({
      id: 'A',
      primitiveType: 'component',
      origin: { x: 100, y: 100 },
      combinedBounds: { x: 100, y: 100, width: 40, height: 20 },
    });
    const preview = movePreview({
      moves: [
        {
          id: 'move-1',
          primitiveId: 'A',
          primitiveType: 'component',
          property: 'position',
          from: { x: 100, y: 100 },
          to: { x: 150, y: 130 },
          reason: 'test',
          expectedQaImprovement: 'test',
          resolvesViolationIds: [],
        },
      ],
    });
    const [result] = applyPreviewMovesToGeometry([original], preview);
    expect(result?.origin).toEqual({ x: 150, y: 130 });
    expect(result?.combinedBounds).toEqual({ x: 150, y: 130, width: 40, height: 20 });
  });

  it('applies a bounds move by replacing origin and combinedBounds outright', () => {
    const original = primitive({
      id: 'box',
      primitiveType: 'section-box',
      origin: { x: 100, y: 100 },
      combinedBounds: { x: 100, y: 100, width: 20, height: 20 },
    });
    const preview = movePreview({
      moves: [
        {
          id: 'move-1',
          primitiveId: 'box',
          primitiveType: 'section-box',
          property: 'bounds',
          from: { x: 100, y: 100, width: 20, height: 20 },
          to: { x: 90, y: 90, width: 60, height: 60 },
          reason: 'test',
          expectedQaImprovement: 'test',
          resolvesViolationIds: [],
        },
      ],
    });
    const [result] = applyPreviewMovesToGeometry([original], preview);
    expect(result?.origin).toEqual({ x: 90, y: 90 });
    expect(result?.combinedBounds).toEqual({ x: 90, y: 90, width: 60, height: 60 });
  });
});
