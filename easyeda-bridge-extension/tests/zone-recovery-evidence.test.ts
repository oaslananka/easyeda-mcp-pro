import { describe, expect, it } from 'vitest';
import {
  encodeZoneWriteReservation,
  decodeZonePendingEvidence,
  assessZoneRecoveryCandidate,
  type ZoneWriteReservation,
} from '../src/zone-recovery-evidence.js';
import type {
  ZoneSourceEvidence,
  ZoneDerivedEvidence,
  ZoneInventory,
} from '../src/zone-create-evidence.js';

const expected = {
  net: 'GND',
  layer: 2,
  polygonSignature: JSON.stringify(['R', 12, -20, 40, 30, 0, 0]),
  fillMethod: 'solid',
  preserveSilos: true,
  pourName: 'NEW-ZONE',
  pourPriority: 1,
  lineWidth: 0.2,
  locked: false,
} as const;
const previousSource: ZoneSourceEvidence = {
  ...expected,
  sourceId: 'old-source',
  layer: 1,
  pourName: 'OLD-ZONE',
};
const previousCopper: ZoneDerivedEvidence = {
  sourceId: 'old-source',
  pouredId: 'old-source',
  fillSignature: 'filled-old-geometry',
  hasFilledGeometry: true,
};
const afterSource: ZoneSourceEvidence = { ...expected, sourceId: 'new-source' };
const afterCopper: ZoneDerivedEvidence = {
  sourceId: 'new-source',
  pouredId: 'new-source',
  fillSignature: 'filled-new-geometry',
  hasFilledGeometry: true,
};
const inventory = (created = false): ZoneInventory => ({
  sources: new Map([
    ['old-source', previousSource],
    ...(created ? [['new-source', afterSource] as const] : []),
  ]),
  derived: new Map([
    ['old-source', previousCopper],
    ...(created ? [['new-source', afterCopper] as const] : []),
  ]),
});
const before = inventory();
const attempt: ZoneWriteReservation = {
  focus: 'project:pcb',
  before,
  expected,
};
const captured = () => {
  const marker = encodeZoneWriteReservation(attempt);
  if (!marker) throw Error('Test fixture should be valid');
  return marker;
};

describe('independent cold-reopen candidate recovery without destructive actions', () => {
  it('persists full before-write source/Poured inventory and exact expected settings', () => {
    const marker = captured();
    const decoded = decodeZonePendingEvidence(marker);
    expect(decoded).toMatchObject({
      version: 2,
      status: 'reconciliation-required',
      focus: 'project:pcb',
      expected,
      before: {
        sources: [previousSource],
        derived: [previousCopper],
      },
    });
    expect(marker).not.toContain('password');
  });

  it('classifies unchanged inventory but never authorizes clearing the fence', () => {
    expect(assessZoneRecoveryCandidate(captured(), 'project:pcb', before)).toEqual({
      status: 'candidate-unchanged',
      persistenceVerified: false,
      releaseAuthorized: false,
    });
  });

  it('identifies a unique genuinely filled source-linked Poured after reopening', () => {
    expect(assessZoneRecoveryCandidate(captured(), 'project:pcb', inventory(true))).toEqual({
      status: 'candidate-created',
      sourceId: 'new-source',
      pouredId: 'new-source',
      persistenceVerified: false,
      releaseAuthorized: false,
    });
  });

  it.each([
    ['focused other PCB', 'different-project:pcb', inventory(true)],
    ['no fresh inventory', 'project:pcb', undefined],
    [
      'baseline copper altered',
      'project:pcb',
      {
        sources: before.sources,
        derived: new Map([
          ['old-source', { ...previousCopper, fillSignature: 'changed-existing-copper' }],
        ]),
      },
    ],
    [
      'new copper unfilled',
      'project:pcb',
      {
        sources: inventory(true).sources,
        derived: new Map([
          ['old-source', previousCopper],
          ['new-source', { ...afterCopper, hasFilledGeometry: false }],
        ]),
      },
    ],
    [
      'unexpected duplicate',
      'project:pcb',
      {
        sources: new Map([
          ...inventory(true).sources,
          ['another-zone', { ...afterSource, sourceId: 'another-zone' }],
        ]),
        derived: inventory(true).derived,
      },
    ],
  ] as const)('fails closed on %s', (_name, focus, observed) => {
    const verdict = assessZoneRecoveryCandidate(captured(), focus, observed);
    expect(verdict).toMatchObject({ status: 'unresolved', releaseAuthorized: false });
  });

  it.each([
    '{}',
    '{bad',
    'null',
    '{"version":1,"status":"reconciliation-required","focus":"project:pcb"}',
    JSON.stringify({
      ...JSON.parse(captured()),
      before: { sources: [previousSource, previousSource], derived: [previousCopper] },
    }),
    JSON.stringify({ ...JSON.parse(captured()), before: { sources: [], derived: ['invalid'] } }),
  ])('does not derive false confidence from legacy or malformed marker %s', (raw) => {
    expect(decodeZonePendingEvidence(raw)).toBeUndefined();
    expect(assessZoneRecoveryCandidate(raw, 'project:pcb', before)).toMatchObject({
      status: 'unresolved',
      releaseAuthorized: false,
    });
  });

  it('refuses malformed inventory collections and unexpected stored inventory keys', () => {
    const valid = JSON.parse(captured());
    expect(
      decodeZonePendingEvidence(
        JSON.stringify({
          ...valid,
          before: { sources: {}, derived: [] },
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeZonePendingEvidence(
        JSON.stringify({
          ...valid,
          before: { ...valid.before, extraneous: true },
        }),
      ),
    ).toBeUndefined();
  });

  it('rejects orphan Poured source links before recording or interpreting pending recovery evidence', () => {
    const orphan = {
      ...previousCopper,
      sourceId: 'orphan-foreign-source',
      pouredId: 'orphan-foreign-poured',
    };
    const mismatchedInventory: ZoneInventory = {
      sources: before.sources,
      derived: new Map([[orphan.sourceId, orphan]]),
    };
    expect(encodeZoneWriteReservation({ ...attempt, before: mismatchedInventory })).toBeUndefined();

    // A schema-shaped legacy marker may still decode for diagnostics, but
    // must never be treated as a trustworthy independent recovery verdict.
    const marker = JSON.parse(captured()) as Record<string, any>;
    marker.before.derived = [orphan];
    const raw = JSON.stringify(marker);
    expect(decodeZonePendingEvidence(raw)).toBeDefined();
    expect(assessZoneRecoveryCandidate(raw, 'project:pcb', mismatchedInventory)).toMatchObject({
      status: 'unresolved',
      reason: expect.stringContaining('without its exact native Pour source'),
      releaseAuthorized: false,
    });
  });

  it('rejects two distinct Pour sources sharing one native Poured primitive identity', () => {
    const secondSource: ZoneSourceEvidence = {
      ...previousSource,
      sourceId: 'second-source',
      pourName: 'SECOND-SOURCE',
    };
    const secondDerived: ZoneDerivedEvidence = {
      ...previousCopper,
      sourceId: 'second-source',
      pouredId: previousCopper.pouredId,
    };
    const duplicateNativePoured: ZoneInventory = {
      sources: new Map([...before.sources, [secondSource.sourceId, secondSource]]),
      derived: new Map([...before.derived, [secondDerived.sourceId, secondDerived]]),
    };

    // Never persist a contradictory baseline before acquiring a host lease.
    expect(
      encodeZoneWriteReservation({ ...attempt, before: duplicateNativePoured }),
    ).toBeUndefined();

    // Previously persisted, structurally valid records may still decode for
    // diagnostics but cannot establish a safe recovery candidate.
    const stored = JSON.parse(captured()) as Record<string, any>;
    stored.before.sources.push(secondSource);
    stored.before.derived.push(secondDerived);
    const historical = JSON.stringify(stored);
    expect(decodeZonePendingEvidence(historical)).toBeDefined();
    expect(
      assessZoneRecoveryCandidate(historical, 'project:pcb', duplicateNativePoured),
    ).toMatchObject({
      status: 'unresolved',
      reason: expect.stringContaining('Poured primitive identity'),
      persistenceVerified: false,
      releaseAuthorized: false,
    });

    // Distinct Pour/Poured pairs are valid recovery evidence.
    const distinctNativePoured: ZoneInventory = {
      ...duplicateNativePoured,
      derived: new Map([
        ...before.derived,
        [secondDerived.sourceId, { ...secondDerived, pouredId: 'second-poured' }],
      ]),
    };
    expect(encodeZoneWriteReservation({ ...attempt, before: distinctNativePoured })).toBeDefined();
  });

  it('rejects empty and oversized recovery payloads before parsing', () => {
    expect(decodeZonePendingEvidence('')).toBeUndefined();
    expect(decodeZonePendingEvidence('x'.repeat(256_001))).toBeUndefined();
  });

  it('fails closed on a malformed serializable object throwing inside JSON.stringify', () => {
    const dangerousExpected = Object.assign(
      Object.create({
        toJSON() {
          throw new Error('unexpected object serialization');
        },
      }),
      expected,
    );
    expect(
      encodeZoneWriteReservation({
        ...attempt,
        expected: dangerousExpected,
      }),
    ).toBeUndefined();
  });

  it('rejects excessive baseline evidence before any write-ahead marker exists', () => {
    const oversized = {
      ...attempt,
      before: {
        sources: before.sources,
        derived: new Map([
          ['old-source', { ...previousCopper, fillSignature: 'X'.repeat(300_000) }],
        ]),
      },
    };
    expect(encodeZoneWriteReservation(oversized)).toBeUndefined();
  });

  it('refuses baseline map keys inconsistent with the native source/derived primitive IDs', () => {
    expect(
      encodeZoneWriteReservation({
        ...attempt,
        before: {
          ...before,
          sources: new Map([['wrong-source-id', previousSource]]),
        },
      }),
    ).toBeUndefined();
    expect(
      encodeZoneWriteReservation({
        ...attempt,
        before: {
          ...before,
          derived: new Map([['wrong-derived-id', previousCopper]]),
        },
      }),
    ).toBeUndefined();
  });

  it('refuses a malformed or incomplete expected Pour plan before any reservation', () => {
    expect(
      encodeZoneWriteReservation({
        ...attempt,
        expected: { ...expected, polygonSignature: '' },
      }),
    ).toBeUndefined();
    expect(
      encodeZoneWriteReservation({
        ...attempt,
        expected: { ...expected, lineWidth: Number.NaN },
      }),
    ).toBeUndefined();
    expect(
      encodeZoneWriteReservation({
        ...attempt,
        focus: ' ',
      }),
    ).toBeUndefined();
  });

  it('protects a 100k-character valid geometry fingerprint through encode/decode', () => {
    const large: ZoneWriteReservation = {
      ...attempt,
      before: {
        ...before,
        derived: new Map([
          [
            'old-source',
            {
              ...previousCopper,
              fillSignature: 'F'.repeat(100_000),
            },
          ],
        ]),
      },
    };
    const raw = encodeZoneWriteReservation(large);
    expect(raw).toBeDefined();
    expect(raw!.length).toBeGreaterThan(100_000);
    expect(decodeZonePendingEvidence(raw!)?.before.derived[0]?.fillSignature).toHaveLength(100_000);
  });

  it('serializes inventory maps in sorted order independent of native iteration order', () => {
    const unordered = {
      ...attempt,
      before: {
        sources: new Map([['zz', { ...previousSource, sourceId: 'zz' }], ...before.sources]),
        derived: new Map([
          ['zz', { ...previousCopper, sourceId: 'zz', pouredId: 'zz' }],
          ...before.derived,
        ]),
      },
    };
    const ordered = {
      ...attempt,
      before: {
        sources: new Map([...unordered.before.sources].reverse()),
        derived: new Map([...unordered.before.derived].reverse()),
      },
    };
    expect(encodeZoneWriteReservation(unordered)).toBe(encodeZoneWriteReservation(ordered));
  });
});
