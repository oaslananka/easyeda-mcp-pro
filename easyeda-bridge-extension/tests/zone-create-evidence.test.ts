import { describe, expect, it } from 'vitest';
import {
  reconcileZoneCreation,
  snapshotNativeZoneSources,
  planExactZoneRollback,
  type ZoneInventory,
  type ZoneSourceEvidence,
  type ZoneDerivedEvidence,
} from '../src/zone-create-evidence.js';

const old: ZoneSourceEvidence = {
  sourceId: 'e336',
  net: 'GND',
  layer: 1,
  polygonSignature: 'old-rectangle',
  fillMethod: 'solid',
  preserveSilos: false,
  pourName: 'POUR2',
  pourPriority: 1,
  lineWidth: 0.2,
  locked: false,
};
const newer: ZoneSourceEvidence = {
  sourceId: 'new-source',
  net: 'GND',
  layer: 2,
  polygonSignature: JSON.stringify(['R', 12, -20, 40, 30, 0, 0]),
  fillMethod: 'solid',
  preserveSilos: true,
  pourName: 'GND_NEW',
  pourPriority: 1,
  lineWidth: 0.2,
  locked: false,
};
const copper: ZoneDerivedEvidence = {
  sourceId: 'e336',
  pouredId: 'e336',
  fillSignature: 'old-copper',
  hasFilledGeometry: true,
};
const newCopper: ZoneDerivedEvidence = {
  sourceId: 'new-source',
  pouredId: 'new-source',
  fillSignature: 'new-real-filled-copper',
  hasFilledGeometry: true,
};
const prior: ZoneInventory = {
  sources: new Map([[old.sourceId, old]]),
  derived: new Map([[copper.sourceId, copper]]),
};
const expected = {
  net: newer.net,
  layer: newer.layer,
  polygonSignature: newer.polygonSignature,
  fillMethod: newer.fillMethod,
  preserveSilos: newer.preserveSilos,
  pourName: newer.pourName,
  pourPriority: newer.pourPriority,
  lineWidth: newer.lineWidth,
  locked: newer.locked,
};
const current = (
  extraSources: ZoneSourceEvidence[] = [newer],
  extraDerived: ZoneDerivedEvidence[] = [newCopper],
): ZoneInventory => ({
  sources: new Map([[old.sourceId, old], ...extraSources.map((s) => [s.sourceId, s] as const)]),
  derived: new Map([
    [copper.sourceId, copper],
    ...extraDerived.map((d) => [d.sourceId, d] as const),
  ]),
});

describe('native copper zone create independent reconciliation', () => {
  it('accepts exactly one fully matching new source with filled target copper and untouched old geometry', () => {
    expect(reconcileZoneCreation(prior, current(), expected)).toEqual({
      status: 'verified',
      sourceId: 'new-source',
      pouredId: 'new-source',
    });
  });

  it('can independently verify a new target despite an unrelated stale native return object', () => {
    expect(reconcileZoneCreation(prior, current(), expected)).toMatchObject({
      status: 'verified',
      sourceId: 'new-source',
    });
  });

  it('rejects a newly verified Poured identity reused by another existing source', () => {
    const before: ZoneInventory = {
      sources: prior.sources,
      derived: new Map([['e336', { ...copper, pouredId: 'new-source' }]]),
    };
    const after: ZoneInventory = {
      sources: current().sources,
      derived: new Map([...before.derived, ['new-source', newCopper]]),
    };
    expect(reconcileZoneCreation(before, after, expected).status).toBe('ambiguous');
    expect(planExactZoneRollback(before, after, expected)).toMatchObject({
      safeToDelete: false,
    });
  });

  it('reports unchanged inventory without pretending native create succeeded', () => {
    expect(reconcileZoneCreation(prior, current([], []), expected)).toMatchObject({
      status: 'unchanged',
    });
  });

  it.each([
    ['two newly created Pour objects', current([newer, { ...newer, sourceId: 'second' }])],
    [
      'unexpected old Pour change',
      {
        sources: new Map([
          [old.sourceId, { ...old, net: 'VCC' }],
          [newer.sourceId, newer],
        ]),
        derived: current().derived,
      },
    ],
    [
      'existing unrelated Poured geometry changed',
      {
        sources: current().sources,
        derived: new Map([
          [copper.sourceId, { ...copper, fillSignature: 'changed' }],
          [newCopper.sourceId, newCopper],
        ]),
      },
    ],
    ['new source missing any associated Poured', current([newer], [])],
    [
      'new derived copper not truly filled',
      current([newer], [{ ...newCopper, hasFilledGeometry: false }]),
    ],
    [
      'new derived identity mismatched',
      current([newer], [{ ...newCopper, pouredId: 'different' }]),
    ],
    ['new source assigned wrong net', current([{ ...newer, net: 'MISSING' }])],
    ['new source assigned wrong copper layer', current([{ ...newer, layer: 1 }])],
    [
      'new source polygon altered by native creation',
      current([{ ...newer, polygonSignature: 'bad' }]),
    ],
    ['unrequested new Pour properties differ', current([{ ...newer, preserveSilos: false }])],
    [
      'unexpected extra derived copper',
      current([newer], [newCopper, { ...newCopper, sourceId: 'rogue' }]),
    ],
    [
      'new unrelated old-source derived association',
      current([newer], [newCopper, { ...newCopper, sourceId: 'rogue', pouredId: 'rogue' }]),
    ],
  ] as const)('fails closed for %s', (_, observed) => {
    expect(reconcileZoneCreation(prior, observed as ZoneInventory, expected)).toMatchObject({
      status: 'ambiguous',
    });
  });

  it('detects missing baseline objects rather than accepting their removal as cleanup', () => {
    expect(
      reconcileZoneCreation(
        prior,
        { sources: new Map([[newer.sourceId, newer]]), derived: current().derived },
        expected,
      ),
    ).toMatchObject({
      status: 'ambiguous',
    });
  });

  it('does not classify a new unfilled source as unchanged and permit a blind retry', () => {
    expect(reconcileZoneCreation(prior, current([newer], []), expected).status).toBe('ambiguous');
  });
});

describe('immutable native Pour source snapshot', () => {
  const native = (id = 'e336', overrides: Record<string, unknown> = {}) => ({
    getState_PrimitiveId: () => id,
    getState_Net: () => 'GND',
    getState_Layer: () => 1,
    getState_ComplexPolygon: () => ({ getSource: () => ['R', 0, 0, 60, 45, 0, 0] }),
    getState_PourFillMethod: () => 'solid',
    getState_PreserveSilos: () => false,
    getState_PourName: () => 'POUR2',
    getState_PourPriority: () => 1,
    getState_LineWidth: () => 0.2,
    getState_PrimitiveLock: () => false,
    ...overrides,
  });

  it('captures native source properties and polygon by value, without retaining mutable objects', () => {
    const polygon = ['R', 0, 0, 60, 45, 0, 0];
    const item = native('e336', {
      getState_ComplexPolygon: () => ({ getSource: () => polygon }),
    });
    const snapshot = snapshotNativeZoneSources([item]);
    expect(snapshot?.get('e336')).toMatchObject({
      sourceId: 'e336',
      net: 'GND',
      layer: 1,
      polygonSignature: JSON.stringify(polygon),
      fillMethod: 'solid',
      preserveSilos: false,
      pourName: 'POUR2',
      pourPriority: 1,
      lineWidth: 0.2,
      locked: false,
    });
    polygon[1] = 500;
    expect(snapshot?.get('e336')?.polygonSignature).toBe(JSON.stringify(['R', 0, 0, 60, 45, 0, 0]));
  });

  it.each([
    ['duplicate source id', [native(), native()]],
    ['missing primitive id', [native('', { getState_PrimitiveId: () => undefined })]],
    ['missing polygon source', [native('x', { getState_ComplexPolygon: () => null })]],
    ['wrong net type', [native('x', { getState_Net: () => undefined })]],
    ['wrong layer type', [native('x', { getState_Layer: () => '2' })]],
    ['invalid linewidth', [native('x', { getState_LineWidth: () => Number.NaN })]],
    ['unknown lock value', [native('x', { getState_PrimitiveLock: () => undefined })]],
    [
      'malformed polygon',
      [native('x', { getState_ComplexPolygon: () => ({ getSource: () => ['R', 0] }) })],
    ],
    [
      'throwing polygon getter',
      [
        native('x', {
          getState_ComplexPolygon: () => {
            throw Error('native getter error');
          },
        }),
      ],
    ],
  ] as const)(
    'refuses untrustworthy %s before treating it as a stable baseline',
    (_reason, items) => {
      expect(snapshotNativeZoneSources(items)).toBeUndefined();
    },
  );

  it('snapshots an existing simple closed L polygon without assuming all board pours are rectangles', () => {
    const source = [0, 0, 'L', 40, 0, 40, -30, 0, -30, 0, 0];
    const item = native('polyline', {
      getState_ComplexPolygon: () => ({ getSource: () => source }),
    });
    expect(snapshotNativeZoneSources([item])?.get('polyline')?.polygonSignature).toBe(
      JSON.stringify(source),
    );
  });

  it('refuses an invalid or self-crossing existing polyline before mutation', () => {
    const bad = [0, 0, 'L', 40, -40, 0, -40, 40, 0, 0, 0];
    const item = native('invalid', {
      getState_ComplexPolygon: () => ({ getSource: () => bad }),
    });
    expect(snapshotNativeZoneSources([item])).toBeUndefined();
  });

  it('accepts an empty legitimate Pour inventory', () => {
    expect(snapshotNativeZoneSources([])?.size).toBe(0);
  });
});

describe('conservative exact-source rollback decision after an uncertain native create', () => {
  it('permits removing the one new source with verified properties, even if its fill never appeared', () => {
    expect(planExactZoneRollback(prior, current([newer], []), expected)).toEqual({
      safeToDelete: true,
      sourceId: 'new-source',
    });
  });

  it('permits deleting the exact new source when a target-linked filled copper exists', () => {
    expect(planExactZoneRollback(prior, current(), expected)).toEqual({
      safeToDelete: true,
      sourceId: 'new-source',
    });
  });

  it.each([
    ['no newly created source', current([], [])],
    ['two newly created sources', current([newer, { ...newer, sourceId: 'other' }])],
    [
      'unrelated Pour changed',
      {
        sources: new Map([
          [old.sourceId, { ...old, pourName: 'changed' }],
          [newer.sourceId, newer],
        ]),
        derived: current().derived,
      },
    ],
    [
      'unrelated derived copper changed',
      {
        sources: current().sources,
        derived: new Map([
          [copper.sourceId, { ...copper, fillSignature: 'different' }],
          [newCopper.sourceId, newCopper],
        ]),
      },
    ],
    [
      'unexpected additional derived copper',
      current([newer], [newCopper, { ...newCopper, sourceId: 'rogue', pouredId: 'rogue' }]),
    ],
    ['newly created source does not match expected plan', current([{ ...newer, net: 'VCC' }])],
  ] as const)('rejects exact rollback when %s', (_reason, observed) => {
    expect(planExactZoneRollback(prior, observed as ZoneInventory, expected)).toMatchObject({
      safeToDelete: false,
    });
  });
});
