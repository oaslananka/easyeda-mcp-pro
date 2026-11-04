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
