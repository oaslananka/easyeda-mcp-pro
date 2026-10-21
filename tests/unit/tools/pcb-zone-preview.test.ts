import { describe, expect, it } from 'vitest';
import { pcbZonePreviewSchema, previewPcbZone } from '../../../src/tools/pcb-zone-preview.js';

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
    ['invalid layer', { layer: 999 }],
    ['unsupported inner layer', { layer: 15 }],
    ['zero width', { rectangle: { x: 1, y: 2, width: 0, height: 3 } }],
    ['negative width', { rectangle: { x: 1, y: 2, width: -4, height: 3 } }],
    ['out of range', { rectangle: { x: 999_900, y: 2, width: 200, height: 3 } }],
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
