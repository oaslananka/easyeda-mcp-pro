import type { WorkflowWireInput } from './types.js';
import type { Ne555AstableNets, Ne555AstableRefs } from './ne555-astable-template.js';

/**
 * Short, per-pin visual wire stubs for the NE555 astable template.
 *
 * Each of U1's 8 pins gets a single 15-unit stub pointing away from the
 * shared pin column (left side pins 1-4 stub left, right side pins 5-8 stub
 * right) rather than a long bus/junction route. An earlier version tried to
 * route full VCC/GND rails and DISCH/TIMING/CTRL/OUT junctions all the way
 * back to U1's pins; because pins 1-4 all exit at the same x-column (and 5-8
 * at another), any two of those long routes shared that column for more
 * than a single point and tripped EasyEDA's same-coordinate net-collision
 * guard the moment a live apply actually tried to draw them (see #253) --
 * this was never caught before because `createWireStubs` had no live/golden
 * coverage. Short, pin-local stubs are collision-free by construction: they
 * never re-visit another pin's column or another net's rail/junction. Exact
 * pin-to-net connectivity is created by connectPinToNet regardless -- these
 * stubs are a readability aid, not the electrical connection.
 */
export function buildNe555VisibleWireStubs(
  anchor: { x: number; y: number },
  refs: Ne555AstableRefs,
  nets: Ne555AstableNets,
): WorkflowWireInput[] {
  const at = (dx: number, dy: number) => ({ x: anchor.x + dx, y: anchor.y + dy });
  const wires: WorkflowWireInput[] = [];

  const route = (role: string, netName: string, points: { dx: number; dy: number }[]) => {
    wires.push({
      role,
      netName,
      points: points.map((p) => at(p.dx, p.dy)),
      lineWidth: 1,
    });
  };

  // VCC rail and non-U1-pin connections (safe: none of these share a column
  // or row with each other or with the short U1 pin stubs below).
  route(`${refs.timer}-vcc-rail`, nets.vcc, [
    { dx: 80, dy: -40 },
    { dx: 450, dy: -40 },
  ]);
  route(`${refs.r1}-pin1-vcc`, nets.vcc, [
    { dx: 100, dy: -70 },
    { dx: 100, dy: -40 },
  ]);
  route(`${refs.cDecouple}-pin1-vcc`, nets.vcc, [
    { dx: 370, dy: -65 },
    { dx: 370, dy: -40 },
  ]);

  // GND rail and non-U1-pin connections.
  route(`${refs.timer}-gnd-rail`, nets.gnd, [
    { dx: 80, dy: -280 },
    { dx: 580, dy: -280 },
  ]);
  route(`${refs.cTiming}-pin2-gnd`, nets.gnd, [
    { dx: 140, dy: -250 },
    { dx: 140, dy: -280 },
  ]);
  route(`${refs.cCtrl}-pin2-gnd`, nets.gnd, [
    { dx: 410, dy: -245 },
    { dx: 410, dy: -280 },
  ]);
  route(`${refs.cDecouple}-pin2-gnd`, nets.gnd, [
    { dx: 410, dy: -65 },
    { dx: 410, dy: -80 },
  ]);
  // No dedicated LED-cathode-to-GND stub: D1's two pins sit close enough
  // together that every coordinate tried here landed on the runtime's own
  // auto-drawn stub for D1's anode pin (a different net), which the bridge
  // correctly refuses to short together (see the collision-avoidance test
  // below). connectPinToNet still makes the real electrical connection;
  // `${refs.rLed}-${refs.led}-anode` still shows D1's anode side visually.

  // Discharge/timing junction between R1/R2/C1 (safe: local to that cluster).
  route(`${refs.r1}-${refs.r2}-disch`, nets.discharge, [
    { dx: 140, dy: -70 },
    { dx: 140, dy: -112 },
    { dx: 100, dy: -112 },
    { dx: 100, dy: -155 },
  ]);
  route(`${refs.r2}-${refs.cTiming}-timing`, nets.timing, [
    { dx: 140, dy: -155 },
    { dx: 140, dy: -202 },
    { dx: 100, dy: -202 },
    { dx: 100, dy: -250 },
  ]);

  // LED anode chain.
  route(`${refs.rLed}-${refs.led}-anode`, nets.ledAnode, [
    { dx: 490, dy: -150 },
    { dx: 540, dy: -150 },
  ]);

  // U1 pin stubs: left column (pins 1-4, x=225) stub left to x=210; right
  // column (pins 5-8, x=335) stub right to x=350. Every stub sits at that
  // pin's own y, so no two stubs (left or right) ever share a coordinate.
  route(`${refs.timer}-pin1-gnd-stub`, nets.gnd, [
    { dx: 225, dy: -135 },
    { dx: 210, dy: -135 },
  ]);
  route(`${refs.timer}-pin2-trig-stub`, nets.timing, [
    { dx: 225, dy: -145 },
    { dx: 210, dy: -145 },
  ]);
  route(`${refs.timer}-pin3-out-stub`, nets.output, [
    { dx: 225, dy: -155 },
    { dx: 210, dy: -155 },
  ]);
  route(`${refs.timer}-pin4-reset-vcc-stub`, nets.vcc, [
    { dx: 225, dy: -165 },
    { dx: 210, dy: -165 },
  ]);
  route(`${refs.timer}-pin5-ctrl-stub`, nets.control, [
    { dx: 335, dy: -165 },
    { dx: 350, dy: -165 },
  ]);
  route(`${refs.timer}-pin6-thresh-stub`, nets.timing, [
    { dx: 335, dy: -155 },
    { dx: 350, dy: -155 },
  ]);
  route(`${refs.timer}-pin7-disch-stub`, nets.discharge, [
    { dx: 335, dy: -145 },
    { dx: 350, dy: -145 },
  ]);
  route(`${refs.timer}-pin8-vcc-stub`, nets.vcc, [
    { dx: 335, dy: -135 },
    { dx: 350, dy: -135 },
  ]);

  return wires;
}
