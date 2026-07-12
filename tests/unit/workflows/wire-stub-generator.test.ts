import { describe, it, expect } from 'vitest';
import {
  generateWireStubs,
  generateStubsForComponents,
  twoPinPassiveStubs,
} from '../../../src/workflows/wire-stub-generator.js';

describe('Wire Stub Generator', () => {
  describe('generateWireStubs', () => {
    it('generates axis-aligned stubs correctly for all directions', () => {
      const pins = [
        { ref: 'R1', pin: '1', netName: 'NET_A', x: 100, y: 100, direction: 'left' as const, length: 10 },
        { ref: 'R1', pin: '2', netName: 'NET_B', x: 200, y: 100, direction: 'right' as const, length: 15 },
        { ref: 'U1', pin: '1', netName: 'NET_C', x: 300, y: 100, direction: 'up' as const, length: 20 },
        { ref: 'U1', pin: '2', netName: 'NET_D', x: 300, y: 200, direction: 'down' as const, length: 25 },
      ];

      const stubs = generateWireStubs(pins);
      expect(stubs).toHaveLength(4);

      // Check left stub
      expect(stubs[0].ref).toBe('R1-pin1-stub');
      expect(stubs[0].role).toBe('R1-pin1-NET_A-stub');
      expect(stubs[0].netName).toBe('NET_A');
      expect(stubs[0].points).toEqual([
        { x: 100, y: 100 },
        { x: 90, y: 100 },
      ]);

      // Check right stub
      expect(stubs[1].points).toEqual([
        { x: 200, y: 100 },
        { x: 215, y: 100 },
      ]);

      // Check up stub
      expect(stubs[2].points).toEqual([
        { x: 300, y: 100 },
        { x: 300, y: 120 },
      ]);

      // Check down stub
      expect(stubs[3].points).toEqual([
        { x: 300, y: 200 },
        { x: 300, y: 175 },
      ]);
    });

    it('uses default values when optional parameters are omitted', () => {
      const pins = [
        { ref: 'R1', pin: '1', netName: 'NET_A', x: 100, y: 100 },
      ];

      const stubs = generateWireStubs(pins);
      expect(stubs[0].points).toEqual([
        { x: 100, y: 100 },
        { x: 118, y: 100 }, // Default direction is right, default length is 18
      ]);
      expect(stubs[0].lineWidth).toBe(1); // Default line width is 1
    });

    it('respects custom overrides in options', () => {
      const pins = [
        { ref: 'R1', pin: '1', netName: 'NET_A', x: 100, y: 100 },
      ];

      const stubs = generateWireStubs(pins, { defaultLength: 30, lineWidth: 2 });
      expect(stubs[0].points[1].x).toBe(130);
      expect(stubs[0].lineWidth).toBe(2);
    });
  });

  describe('generateStubsForComponents', () => {
    it('translates relative stubs based on component offset and anchor', () => {
      const anchor = { x: 500, y: 500 };
      const specs = [
        {
          ref: 'R1',
          placementOffset: { dx: 50, dy: -50 },
          pins: [
            { pin: '1', netName: 'VCC', dx: -20, dy: 0, direction: 'left' as const },
            { pin: '2', netName: 'SW', dx: 20, dy: 0, direction: 'right' as const },
          ],
        },
      ];

      const stubs = generateStubsForComponents(anchor, specs);
      expect(stubs).toHaveLength(2);

      // Component position: x = 550, y = 450
      // Pin 1 absolute pos: x = 530, y = 450
      // Pin 1 stub end: x = 512, y = 450 (left by 18)
      expect(stubs[0].points).toEqual([
        { x: 530, y: 450 },
        { x: 512, y: 450 },
      ]);

      // Pin 2 absolute pos: x = 570, y = 450
      // Pin 2 stub end: x = 588, y = 450 (right by 18)
      expect(stubs[1].points).toEqual([
        { x: 570, y: 450 },
        { x: 588, y: 450 },
      ]);
    });
  });

  describe('twoPinPassiveStubs', () => {
    it('creates standard left/right stub specs for a passive component', () => {
      const spec = twoPinPassiveStubs('C1', { dx: 100, dy: 200 }, 'VCC', 'GND');
      expect(spec.ref).toBe('C1');
      expect(spec.placementOffset).toEqual({ dx: 100, dy: 200 });
      expect(spec.pins).toHaveLength(2);

      expect(spec.pins[0]).toEqual({
        pin: '1',
        netName: 'VCC',
        dx: -20,
        dy: 0,
        direction: 'left',
      });
      expect(spec.pins[1]).toEqual({
        pin: '2',
        netName: 'GND',
        dx: 20,
        dy: 0,
        direction: 'right',
      });
    });
  });
});
