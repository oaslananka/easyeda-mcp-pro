import { describe, it, expect } from 'vitest';
import { buildNe555VisibleWireStubs } from '../../../src/workflows/ne555-wire-stubs.js';
import type { Ne555AstableRefs, Ne555AstableNets } from '../../../src/workflows/ne555-astable-template.js';

/* ─── defaults ────────────────────────────────────────────────────────── */

const DEFAULT_REFS: Ne555AstableRefs = {
  timer: 'U1',
  r1: 'R1',
  r2: 'R2',
  cTiming: 'C1',
  cCtrl: 'C2',
  cDecouple: 'C3',
  rLed: 'R3',
  led: 'D1',
};

const DEFAULT_NETS: Ne555AstableNets = {
  vcc: '+5V',
  gnd: 'GND',
  timing: 'TIMING',
  discharge: 'DISCH',
  control: 'CTRL',
  output: 'OUT',
  ledAnode: 'LED_A',
};

/* ─── tests ───────────────────────────────────────────────────────────── */

describe('buildNe555VisibleWireStubs', () => {
  const anchor = { x: 0, y: 0 };

  it('produces the expected total number of routed guide wires', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    expect(wires).toHaveLength(19);
  });

  it('every wire stub has at least 2 points', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    for (const wire of wires) {
      expect(wire.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every wire stub has a non-empty role', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    for (const wire of wires) {
      expect(wire.role).toBeTruthy();
    }
  });

  it('every wire stub has a defined netName', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    for (const wire of wires) {
      expect(wire.netName).toBeDefined();
      expect(wire.netName).not.toBe('');
    }
  });

  it('wire stubs reference all expected net names', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    const netNames = new Set(wires.map((w) => w.netName));
    expect(netNames).toContain(DEFAULT_NETS.vcc);
    expect(netNames).toContain(DEFAULT_NETS.gnd);
    expect(netNames).toContain(DEFAULT_NETS.timing);
    expect(netNames).toContain(DEFAULT_NETS.discharge);
    expect(netNames).toContain(DEFAULT_NETS.control);
    expect(netNames).toContain(DEFAULT_NETS.output);
    expect(netNames).toContain(DEFAULT_NETS.ledAnode);
  });

  it('all refs are covered by wire stub roles', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    const roles = wires.map((w) => w.role);
    const rolesStr = roles.join(' ');
    for (const ref of Object.values(DEFAULT_REFS)) {
      expect(rolesStr).toContain(ref);
    }
  });

  it('translates anchor offset correctly', () => {
    const anchor1 = { x: 0, y: 0 };
    const anchor2 = { x: 100, y: 200 };

    const wires1 = buildNe555VisibleWireStubs(anchor1, DEFAULT_REFS, DEFAULT_NETS);
    const wires2 = buildNe555VisibleWireStubs(anchor2, DEFAULT_REFS, DEFAULT_NETS);

    expect(wires1).toHaveLength(wires2.length);

    // Every corresponding route point should differ by the anchor delta.
    for (let i = 0; i < wires1.length; i++) {
      expect(wires1[i].points).toHaveLength(wires2[i].points.length);
      for (let j = 0; j < wires1[i].points.length; j++) {
        const p1 = wires1[i].points[j];
        const p2 = wires2[i].points[j];
        expect(p2.x - p1.x).toBe(100);
        expect(p2.y - p1.y).toBe(200);
      }
    }
  });

  it('routes every segment orthogonally', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    for (const wire of wires) {
      for (let i = 1; i < wire.points.length; i++) {
        const previous = wire.points[i - 1];
        const current = wire.points[i];
        expect(previous.x === current.x || previous.y === current.y).toBe(true);
      }
    }
  });

  it('includes named power rails and key routed nodes', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    const roles = wires.map((wire) => wire.role);

    expect(roles).toContain('U1-vcc-rail');
    expect(roles).toContain('U1-gnd-rail');
    expect(roles).toContain('R1-R2-disch');
    expect(roles).toContain('R2-C1-timing');
    expect(roles).toContain('R3-D1-anode');
  });

  it('uses custom refs and nets in wire roles and netNames', () => {
    const customRefs: Ne555AstableRefs = {
      timer: 'U99',
      r1: 'R10',
      r2: 'R20',
      cTiming: 'C10',
      cCtrl: 'C20',
      cDecouple: 'C30',
      rLed: 'R30',
      led: 'D10',
    };
    const customNets: Ne555AstableNets = {
      vcc: 'VDD',
      gnd: 'VSS',
      timing: 'TIM_NET',
      discharge: 'DISCH_NET',
      control: 'CTRL_NET',
      output: 'OUT_NET',
      ledAnode: 'ANODE',
    };

    const wires = buildNe555VisibleWireStubs(anchor, customRefs, customNets);

    // Check that custom refs appear in roles
    const rolesStr = wires.map((w) => w.role).join(' ');
    expect(rolesStr).toContain('U99');
    expect(rolesStr).toContain('R10');

    // Check that custom nets are used
    const netNames = new Set(wires.map((w) => w.netName));
    expect(netNames).toContain('VDD');
    expect(netNames).toContain('VSS');
    expect(netNames).toContain('TIM_NET');
  });

  it('wire stubs have lineWidth of 1', () => {
    const wires = buildNe555VisibleWireStubs(anchor, DEFAULT_REFS, DEFAULT_NETS);
    for (const wire of wires) {
      expect(wire.lineWidth).toBe(1);
    }
  });
});
