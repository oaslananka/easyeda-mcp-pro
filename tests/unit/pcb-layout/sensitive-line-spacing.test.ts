import { describe, expect, it } from 'vitest';
import { reviewSensitiveLineSpacing } from '../../../src/pcb-layout/sensitive-line-spacing.js';
import type { NativeTrack } from '../../../src/pcb-layout/route-review.js';

const declaration = {
  sensitiveNet: 'XTAL',
  otherNet: 'SW',
  context: 'sensitive-adjacency' as const,
  constraintSource: 'Synthetic source criterion only',
};
const line = (primitiveId: string, net: string, y: number, layer = 1): NativeTrack => ({
  primitiveId,
  net,
  layer,
  startX: 0,
  startY: y,
  endX: 100,
  endY: y,
  width: 4,
});
const a = line('a', 'XTAL', 0),
  b = line('b', 'SW', 10);
describe('source-declared sensitive line spacing (not coupling or EMI assessment)', () => {
  it('reports closest observed same-layer edge gap without inferring a default requirement', () => {
    const r = reviewSensitiveLineSpacing(
      declaration,
      [a, b, line('far', 'SW', 50), line('other-layer', 'SW', 0, 2)],
      true,
    );
    expect(r).toMatchObject({
      evidence: 'observed_same_layer_lines',
      status: 'UNKNOWN',
      sensitive_net: 'XTAL',
      other_net: 'SW',
      line_counts: { sensitive: 1, other: 3 },
      compared_pair_count: 2,
      closest: {
        primitive_ids: ['a', 'b'],
        native_layer: 1,
        observed_edge_gap_mm: expect.closeTo(0.1524, 12),
      },
      electrical_isolation_status: 'UNKNOWN',
      engineering_sign_off: false,
    });
    expect(r.declared_min_edge_gap_mm).toBeUndefined();
  });
  it('warns only on observed contact or a declared shortfall, not equality or a compliant distance', () => {
    for (const [minimum, status] of [
      [0.2, 'WARNING'],
      [0.1524, 'UNKNOWN'],
      [0.1, 'UNKNOWN'],
    ] as const) {
      expect(
        reviewSensitiveLineSpacing({ ...declaration, minEdgeGapMm: minimum }, [a, b], true),
      ).toMatchObject({ status, declared_min_edge_gap_mm: minimum });
    }
    const crossing = { ...b, startX: 50, endX: 50, startY: -10, endY: 10 };
    expect(reviewSensitiveLineSpacing(declaration, [a, crossing], true)).toMatchObject({
      status: 'WARNING',
      closest: { observed_edge_gap_mm: -0.1016 },
    });
  });
  it('does not infer isolation from missing nets, different layers or incomplete geometry', () => {
    for (const [tracks, complete] of [
      [[a], true],
      [[a, { ...b, layer: 2 }], true],
      [[a, b], false],
      [[a, b, { ...b }], true],
      [[a, b, { ...line('bad', 'OTHER', 0), width: 0 }], true],
    ] as const) {
      const r = reviewSensitiveLineSpacing(declaration, [...tracks], complete);
      expect(r).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'unavailable',
        electrical_isolation_status: 'UNKNOWN',
        engineering_sign_off: false,
      });
      expect(r.closest).toBeUndefined();
    }
  });
  it('rejects invalid source criteria and reports missing exact-net counts', () => {
    for (const d of [
      { ...declaration, constraintSource: ' ' },
      { ...declaration, minEdgeGapMm: Infinity },
      { ...declaration, minEdgeGapMm: -1 },
    ]) {
      expect(reviewSensitiveLineSpacing(d, [a, b], true).evidence).toBe('unavailable');
    }
    const r = reviewSensitiveLineSpacing(
      { ...declaration, context: 'feedback', sensitiveNet: 'FB' },
      [a, b],
      true,
    );
    expect(r).toMatchObject({
      evidence: 'unavailable',
      line_counts: { sensitive: 0, other: 1 },
      compared_pair_count: 0,
    });
    expect(r.closest).toBeUndefined();
    expect(
      reviewSensitiveLineSpacing(declaration, [a, { ...b, startY: 4, endY: 4 }], true),
    ).toMatchObject({ status: 'WARNING', closest: { observed_edge_gap_mm: 0 } });
  });

  it('selects deterministic ties by exact primitive identity and rejects contradictory declarations', () => {
    const c = line('c', 'SW', -10);
    const r = reviewSensitiveLineSpacing(declaration, [c, b, a], true);
    expect(r.closest?.primitive_ids).toEqual(['a', 'b']);
    expect(
      reviewSensitiveLineSpacing({ ...declaration, otherNet: 'XTAL' }, [a, b], true).evidence,
    ).toBe('unavailable');
    expect(
      reviewSensitiveLineSpacing({ ...declaration, otherNet: ' SW' }, [a, b], true).evidence,
    ).toBe('unavailable');
  });
});
