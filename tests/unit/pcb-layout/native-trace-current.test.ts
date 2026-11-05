import { describe, expect, it } from 'vitest';
import {
  reviewNativeTraceCurrent,
  type NativeTraceCurrentInput,
} from '../../../src/pcb-layout/native-trace-current.js';

const baseline: NativeTraceCurrentInput = {
  declaration: {
    net: 'PWR',
    currentA: 1,
    temperatureRiseC: 10,
    layer: 'external',
    copperWeightOz: 1,
    environment: 'still-air',
  },
  tracks: [
    {
      primitiveId: 't2',
      net: 'PWR',
      layer: 1,
      startX: 100,
      startY: 0,
      endX: 200,
      endY: 0,
      width: 4,
    },
    { primitiveId: 't1', net: 'PWR', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, width: 8 },
    {
      primitiveId: 'other',
      net: 'GND',
      layer: 1,
      startX: 0,
      startY: 10,
      endX: 200,
      endY: 10,
      width: 2,
    },
  ],
  trackCount: 3,
  collectionComplete: true,
  easyedaVersion: '3.2.209',
  extensionVersion: '1.9.0',
};

describe('native bounded-net trace-current reference', () => {
  it('warns only about observed narrow segments relative to declared empirical assumptions', () => {
    const r = reviewNativeTraceCurrent(baseline);
    expect(r).toMatchObject({
      net: 'PWR',
      status: 'WARNING',
      geometry_evidence: 'observed_bounded_segments',
      observed_narrowest_segment_width_mm: 0.1016,
      observed_primitive_ids: ['t1', 't2'],
      source_versions: { easyeda: '3.2.209', extension: '1.9.0' },
      engineering_sign_off: false,
    });
    expect(r.empirical_reference_width_mm).toBeGreaterThan(0.1016);
    expect(r.findings).toContainEqual(
      expect.objectContaining({ id: 'THERMAL_REFERENCE_SHORTFALL', status: 'WARNING' }),
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({ id: 'VIA_CURRENT_UNKNOWN', status: 'UNKNOWN' }),
    );
  });

  it('never issues a thermal PASS even for generously wide actual segments', () => {
    const r = reviewNativeTraceCurrent({
      ...baseline,
      tracks: baseline.tracks.map((track) => ({ ...track, width: 1000 })),
    });
    expect(r.status).toBe('UNKNOWN');
    expect(r.findings).toContainEqual(
      expect.objectContaining({ id: 'THERMAL_ADEQUACY_UNKNOWN', status: 'UNKNOWN' }),
    );
    expect(r.engineering_sign_off).toBe(false);
  });

  it('preserves a manufacturer-declared limit shortfall without claiming its process verified', () => {
    const r = reviewNativeTraceCurrent({
      ...baseline,
      declaration: { ...baseline.declaration, manufacturerMinWidthMm: 0.2 },
    });
    expect(r.findings).toContainEqual(
      expect.objectContaining({ id: 'FABRICATION_DECLARATION_SHORTFALL', status: 'WARNING' }),
    );
    expect(r.limitations.join(' ')).toContain('caller declarations');
  });

  it.each([
    ['disconnected or unreadable collection', { collectionComplete: false }],
    ['truncated collection', { trackCount: 201 }],
    ['wrong selected net', { declaration: { ...baseline.declaration, net: 'UNKNOWN_NET' } }],
    ['unversioned native extension', { extensionVersion: 'undefined' }],
    ['unversioned native editor', { easyedaVersion: null }],
    [
      'a malformed primitive',
      { tracks: [{ ...baseline.tracks[0], width: 0 }, ...baseline.tracks.slice(1)] },
    ],
    [
      'a duplicate primitive identity',
      { tracks: [{ ...baseline.tracks[0], primitiveId: 't1' }, ...baseline.tracks.slice(1)] },
    ],
  ])('fails closed for %s', (_name, override) => {
    const r = reviewNativeTraceCurrent({ ...baseline, ...override });
    expect(r.geometry_evidence).toBe('unavailable');
    expect(r.observed_narrowest_segment_width_mm).toBeUndefined();
    expect(r.observed_primitive_ids).toEqual([]);
    expect(r.status).toBe('UNKNOWN');
    expect(r.findings).toContainEqual(
      expect.objectContaining({ id: 'NATIVE_GEOMETRY_UNKNOWN', status: 'UNKNOWN' }),
    );
  });

  it('does not compare mixed native copper layers against one declared thermal layer class', () => {
    for (const layer of ['external', 'internal'] as const) {
      const mixed = reviewNativeTraceCurrent({
        ...baseline,
        declaration: {
          ...baseline.declaration,
          layer,
          manufacturerMinWidthMm: 0.2,
        },
        tracks: [{ ...baseline.tracks[0]!, layer: 2 }, baseline.tracks[1]!, baseline.tracks[2]!],
      });
      expect(mixed.geometry_evidence).toBe('unavailable');
      expect(mixed.status).toBe('UNKNOWN');
      expect(mixed.observed_narrowest_segment_width_mm).toBeUndefined();
      expect(mixed.observed_primitive_ids).toEqual([]);
      expect(mixed.findings).toContainEqual(
        expect.objectContaining({ id: 'NATIVE_GEOMETRY_UNKNOWN', status: 'UNKNOWN' }),
      );
      expect(
        mixed.findings.some(
          (finding) =>
            finding.id === 'THERMAL_REFERENCE_SHORTFALL' ||
            finding.id === 'FABRICATION_DECLARATION_SHORTFALL',
        ),
      ).toBe(false);
      expect(mixed.limitations.join(' ')).toMatch(/layer/i);
      expect(mixed.engineering_sign_off).toBe(false);
    }

    const singleLayer = reviewNativeTraceCurrent({
      ...baseline,
      tracks: baseline.tracks.map((track) =>
        track.net === 'PWR' ? { ...track, layer: 2 } : track,
      ),
    });
    expect(singleLayer.geometry_evidence).toBe('observed_bounded_segments');
    expect(singleLayer.status).toBe('WARNING');
  });

  it('does not assign a measured current-path width when an unrelated track reuses a native ID', () => {
    const r = reviewNativeTraceCurrent({
      ...baseline,
      tracks: [
        baseline.tracks[0]!,
        baseline.tracks[1]!,
        { ...baseline.tracks[2], primitiveId: 't1' },
      ],
    });
    expect(r.geometry_evidence).toBe('unavailable');
    expect(r.observed_narrowest_segment_width_mm).toBeUndefined();
    expect(r.observed_primitive_ids).toEqual([]);
    expect(r.findings.some((finding) => finding.id === 'THERMAL_REFERENCE_SHORTFALL')).toBe(false);
  });

  it('rejects padded net identities and malformed bounds instead of reporting measured thermal results', () => {
    for (const override of [
      { declaration: { ...baseline.declaration, net: ' PWR ' } },
      { tracks: [{ ...baseline.tracks[0], primitiveId: ' t2 ' }, ...baseline.tracks.slice(1)] },
      { tracks: [{ ...baseline.tracks[0], net: ' PWR ' }, ...baseline.tracks.slice(1)] },
      { tracks: [{ ...baseline.tracks[0], endX: 1e308 }, ...baseline.tracks.slice(1)] },
      { tracks: [{ ...baseline.tracks[0], width: 1e308 }, ...baseline.tracks.slice(1)] },
    ]) {
      const r = reviewNativeTraceCurrent({ ...baseline, ...override });
      expect(r.geometry_evidence).toBe('unavailable');
      expect(r.observed_narrowest_segment_width_mm).toBeUndefined();
      expect(r.observed_primitive_ids).toEqual([]);
      expect(r.status).toBe('UNKNOWN');
      expect(r.findings).toContainEqual(
        expect.objectContaining({ id: 'NATIVE_GEOMETRY_UNKNOWN', status: 'UNKNOWN' }),
      );
    }
  });

  it('marks a malformed declared manufacturer process minimum explicitly unverified', () => {
    for (const limit of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = reviewNativeTraceCurrent({
        ...baseline,
        declaration: { ...baseline.declaration, manufacturerMinWidthMm: limit },
      });
      expect(r.findings).toContainEqual(
        expect.objectContaining({ id: 'FABRICATION_DECLARATION_INVALID', status: 'UNKNOWN' }),
      );
      expect(r.findings.some((finding) => finding.id === 'FABRICATION_DECLARATION_SHORTFALL')).toBe(
        false,
      );
      expect(r.engineering_sign_off).toBe(false);
    }
  });

  it('uses explicit inner/outer copper inputs as declarations, not observed stackup facts', () => {
    const outer = reviewNativeTraceCurrent(baseline);
    const inner = reviewNativeTraceCurrent({
      ...baseline,
      declaration: { ...baseline.declaration, layer: 'internal' },
    });
    expect(inner.empirical_reference_width_mm).toBeGreaterThan(outer.empirical_reference_width_mm);
    expect(inner.limitations.join(' ')).toContain('not verified');
  });
});
