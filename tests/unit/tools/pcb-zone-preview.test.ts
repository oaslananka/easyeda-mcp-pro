import { describe, expect, it } from 'vitest';
import {
  pcbZonePreviewSchema,
  previewPcbZone,
  summarizeZoneLiveReadiness,
} from '../../../src/tools/pcb-zone-preview.js';

const valid = {
  rectangle: { x: 140, y: 140, width: 2780, height: 2000 },
  layer: 2,
  netName: 'GND',
  fillMethod: 'solid',
  preserveSilos: true,
  pourName: 'Z480_GOOD',
  pourPriority: 2,
  lineWidth: 0.2,
  locked: false,
} as const;

describe('native PCB copper zone preview', () => {
  it('normalizes the exact nine native inputs deterministically without a native call', () => {
    const parsed = pcbZonePreviewSchema.parse(valid);
    const first = previewPcbZone(parsed);
    const second = previewPcbZone(parsed);
    expect(first).toEqual(second);
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.target).toBe('PCB_PrimitivePour.create');
    expect(first.nativeArguments).toEqual({
      net: 'GND',
      layer: 2,
      polygonSource: ['R', 140, 140, 2780, 2000, 0, 0],
      fillMethod: 'solid',
      preserveSilos: true,
      pourName: 'Z480_GOOD',
      pourPriority: 2,
      lineWidth: 0.2,
      locked: false,
    });
    expect(first.requiredApplyChecks.join(' ')).toContain('netName must exist');
  });

  it.each([
    ['another net', { netName: 'VCC' }, 'native-net-unsupported'],
    ['TOP layer', { layer: 1 }, 'native-layer-unsupported'],
    ['island preservation disabled', { preserveSilos: false }, 'native-islands-mode-unsupported'],
    ['primitive locked', { locked: true }, 'native-lock-mode-unsupported'],
  ] as const)(
    'marks %s as outside the live-measured native settings profile',
    (_, changed, blocker) => {
      const preview = previewPcbZone(
        pcbZonePreviewSchema.parse({ ...valid, pourPriority: 1, ...changed }),
      );
      expect(preview.nativeProfile).toEqual({
        observedInDisposableRuntime: false,
        evidenceRuntime: '3.2.209',
        blockers: [blocker],
      });
    },
  );

  it.each([
    [
      'native API unavailable',
      { nativeCapabilities: false },
      'native-zone-capabilities-unavailable',
    ],
    ['net absent', { netVerified: false }, 'net-not-in-active-pcb'],
    ['copper layer unavailable', { layerVerified: false }, 'copper-layer-unverified'],
  ] as const)(
    'surfaces %s as a live blocker without inventing readiness',
    (_, changed, blocker) => {
      const result = summarizeZoneLiveReadiness({
        runtimeVersion: '3.2.209',
        runtimeVerified: true,
        activePcb: true,
        nativeCapabilities: true,
        netVerified: true,
        layerVerified: true,
        boardGeometry: { containmentVerified: true },
        readyToApply: false,
        blockers: [],
        ...changed,
      });
      expect(result).toMatchObject({
        checked: true,
        readyToApply: false,
        blockers: expect.arrayContaining([blocker]),
      });
    },
  );

  it('does not elevate outline evidence after runtime or PCB identity verification fails', () => {
    const base = {
      runtimeVersion: '3.2.209',
      runtimeVerified: true,
      activePcb: true,
      nativeCapabilities: true,
      netVerified: true,
      layerVerified: true,
      boardGeometry: { containmentVerified: true },
      readyToApply: false,
      blockers: [],
    };
    for (const unsafe of [
      { ...base, runtimeVerified: false },
      { ...base, activePcb: false },
    ]) {
      expect(summarizeZoneLiveReadiness(unsafe)).toMatchObject({
        checked: true,
        boardContainmentVerified: false,
        readyToApply: false,
        blockers: expect.arrayContaining(['candidate-board-containment-unverified']),
      });
    }
  });

  it('treats the isolated native settings profile as evidence only, not write authorization', () => {
    const matched = previewPcbZone(
      pcbZonePreviewSchema.parse({
        ...valid,
        pourPriority: 1,
      }),
    );
    expect(matched.nativeProfile).toEqual({
      observedInDisposableRuntime: true,
      evidenceRuntime: '3.2.209',
      blockers: [],
    });
    expect(matched.requiredApplyChecks.join(' ')).toContain('strictly contained');
    const unsupported = previewPcbZone(pcbZonePreviewSchema.parse(valid));
    expect(unsupported.nativeProfile).toMatchObject({
      observedInDisposableRuntime: false,
      blockers: ['native-priority-unsupported'],
    });
  });

  it('accepts native negative-Y board coordinates and a top-edge rectangle near positive Y limit', () => {
    expect(
      pcbZonePreviewSchema.safeParse({
        ...valid,
        rectangle: { x: 2420, y: -1800, width: 520, height: 420 },
      }).success,
    ).toBe(true);
    expect(
      pcbZonePreviewSchema.safeParse({
        ...valid,
        rectangle: { x: 1, y: 999_900, width: 10, height: 200 },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['invalid layer', { layer: 999 }],
    ['unsupported inner layer', { layer: 15 }],
    ['zero width', { rectangle: { x: 1, y: 2, width: 0, height: 3 } }],
    ['negative width', { rectangle: { x: 1, y: 2, width: -4, height: 3 } }],
    ['out of range', { rectangle: { x: 999_900, y: 2, width: 200, height: 3 } }],
    ['past negative native Y limit', { rectangle: { x: 10, y: -999_900, width: 30, height: 200 } }],
    ['blank net', { netName: ' ' }],
    ['no net', { netName: undefined }],
    ['missing island flag', { preserveSilos: undefined }],
    ['missing fill method', { fillMethod: undefined }],
    ['unsupported fill method', { fillMethod: 'grid' }],
    ['missing priority', { pourPriority: undefined }],
    ['negative priority', { pourPriority: -1 }],
    ['missing lock', { locked: undefined }],
    ['missing width', { lineWidth: undefined }],
    ['unknown property', { autoCreateNet: true }],
  ])('rejects %s before native execution', (_title, override) => {
    expect(pcbZonePreviewSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});
