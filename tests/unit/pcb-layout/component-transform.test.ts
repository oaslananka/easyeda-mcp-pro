import { describe, expect, it } from 'vitest';
import {
  normalizePcbRotation,
  parsePcbComponentTransformState,
  pcbComponentStateMatches,
  pcbLayerToSide,
  pcbSideToLayer,
  planPcbComponentTransform,
} from '../../../src/pcb-layout/component-transform.js';

describe('PCB component transform contract', () => {
  it('maps only the verified top and bottom component layers', () => {
    expect(pcbSideToLayer('top')).toBe(1);
    expect(pcbSideToLayer('bottom')).toBe(2);
    expect(pcbLayerToSide(1)).toBe('top');
    expect(pcbLayerToSide(2)).toBe('bottom');
    expect(pcbLayerToSide(12)).toBeUndefined();
  });

  it('normalizes equivalent EasyEDA rotations modulo 360', () => {
    expect(normalizePcbRotation(-90)).toBe(270);
    expect(normalizePcbRotation(450)).toBe(90);
    expect(normalizePcbRotation(-360)).toBe(0);
  });

  it('rejects read-back that is not on a supported component layer', () => {
    expect(
      parsePcbComponentTransformState({
        primitiveId: 'c1',
        x: 1,
        y: 2,
        rotation: 0,
        layer: 12,
        locked: false,
      }),
    ).toBeUndefined();
  });

  it('omits a semantic rotation no-op from the native change set', () => {
    const before = {
      primitiveId: 'c1',
      side: 'top' as const,
      layer: 1 as const,
      xMil: 1,
      yMil: 2,
      rotationDeg: 270,
      locked: false,
    };
    const plan = planPcbComponentTransform(before, { side: 'bottom', rotationDeg: -90 });

    expect(plan.changes).toEqual([{ field: 'side', before: 'top', after: 'bottom' }]);
    expect(plan.nativeProperty).toEqual({ layer: 2 });
  });

  it('maps explicit mil coordinates and degree rotation to native EasyEDA fields', () => {
    const before = {
      primitiveId: 'c1',
      side: 'top' as const,
      layer: 1 as const,
      xMil: 100,
      yMil: -200,
      rotationDeg: 0,
      locked: false,
    };
    const plan = planPcbComponentTransform(before, {
      xMil: 125,
      yMil: -175,
      rotationDeg: 450,
    });

    expect(plan.planned).toMatchObject({ xMil: 125, yMil: -175, rotationDeg: 90 });
    expect(plan.nativeProperty).toEqual({ x: 125, y: -175, rotation: 90 });
  });

  it('matches live read-back rotations modulo 360', () => {
    const expected = {
      primitiveId: 'c1',
      side: 'bottom' as const,
      layer: 2 as const,
      xMil: 10,
      yMil: 20,
      rotationDeg: 270,
      locked: false,
    };
    expect(pcbComponentStateMatches({ ...expected, rotationDeg: -90 }, expected)).toBe(true);
  });
});
