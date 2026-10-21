import { bench, describe } from 'vitest';

import { planFunctionalLayout, type FunctionalLayoutComponent } from '../../src/layout/planner.js';
import type { SchematicSheetGeometry } from '../../src/schematic-engine/geometry.js';

function sheet(pageSize: 'A4' | 'A3'): SchematicSheetGeometry {
  const a3 = pageSize === 'A3';
  return {
    bounds: { x: 0, y: 0, width: a3 ? 1682 : 1189, height: a3 ? 1189 : 841 },
    drawableBounds: { x: 40, y: 40, width: a3 ? 1602 : 1109, height: a3 ? 1109 : 761 },
    grid: 10,
    units: 'easyeda-coordinate',
    pageSize,
    coordinateOrigin: { x: 0, y: 0, yAxis: 'up', source: 'live-readback' },
    geometrySource: 'live-readback',
    titleBlockBounds: a3
      ? { x: 1200, y: 40, width: 442, height: 220 }
      : { x: 800, y: 40, width: 349, height: 180 },
  };
}

const ne555: FunctionalLayoutComponent[] = [
  { id: 'U1', blockId: 'timing', role: 'main', renderedSize: { width: 120, height: 80 } },
  {
    id: 'R1',
    blockId: 'timing',
    role: 'feedback-network',
    parentId: 'U1',
    renderedSize: { width: 40, height: 20 },
  },
  {
    id: 'R2',
    blockId: 'timing',
    role: 'feedback-network',
    parentId: 'U1',
    renderedSize: { width: 40, height: 20 },
  },
  {
    id: 'C1',
    blockId: 'timing',
    role: 'decoupling-capacitor',
    parentId: 'U1',
    renderedSize: { width: 30, height: 30 },
  },
  { id: 'J1', blockId: 'io', role: 'main', renderedSize: { width: 80, height: 60 } },
  {
    id: 'R3',
    blockId: 'io',
    role: 'led-current-limit',
    parentId: 'J1',
    renderedSize: { width: 40, height: 20 },
  },
];

/** Several MCU-like blocks, each with decoupling and pull-up support parts. */
function multiBlockDesign(blockCount: number): FunctionalLayoutComponent[] {
  const components: FunctionalLayoutComponent[] = [];
  for (let b = 0; b < blockCount; b += 1) {
    const main = `U${b + 1}`;
    components.push({
      id: main,
      blockId: `block-${b}`,
      role: 'main',
      renderedSize: { width: 100, height: 80 },
    });
    for (let s = 0; s < 3; s += 1) {
      components.push({
        id: `C${b * 3 + s + 1}`,
        blockId: `block-${b}`,
        role: 'decoupling-capacitor',
        parentId: main,
        renderedSize: { width: 30, height: 30 },
      });
    }
  }
  return components;
}

const multiBlock = multiBlockDesign(4);

describe('schematic layout', () => {
  bench('planFunctionalLayout - NE555 astable (A4)', () => {
    planFunctionalLayout({
      sheet: sheet('A4'),
      components: ne555,
      constraints: { maximumSupportDistanceByRole: { 'decoupling-capacitor': 80 } },
    });
  });

  bench('planFunctionalLayout - 4 blocks with A3 fallback', () => {
    planFunctionalLayout({
      sheet: sheet('A4'),
      a3FallbackSheet: sheet('A3'),
      allowA3Fallback: true,
      components: multiBlock,
    });
  });
});
