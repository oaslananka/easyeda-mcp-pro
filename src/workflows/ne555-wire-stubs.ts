import type { WorkflowWireInput } from './types.js';
import type { Ne555AstableNets, Ne555AstableRefs } from './ne555-astable-template.js';

export function buildNe555VisibleWireStubs(
  anchor: { x: number; y: number },
  refs: Ne555AstableRefs,
  nets: Ne555AstableNets,
): WorkflowWireInput[] {
  const at = (dx: number, dy: number) => ({ x: anchor.x + dx, y: anchor.y + dy });
  const wires: WorkflowWireInput[] = [];

  const route = (
    role: string,
    netName: string,
    points: { dx: number; dy: number }[],
  ) => {
    wires.push({
      role,
      netName,
      points: points.map(p => at(p.dx, p.dy)),
      lineWidth: 1,
    });
  };

  // 1. VCC Rail (+5V) and connections
  route(`${refs.timer}-vcc-rail`, nets.vcc, [
    { dx: 80, dy: -40 },
    { dx: 450, dy: -40 },
  ]);
  route(`${refs.r1}-pin1-vcc`, nets.vcc, [
    { dx: 100, dy: -70 },
    { dx: 100, dy: -40 },
  ]);
  route(`${refs.timer}-pin4-reset-vcc`, nets.vcc, [
    { dx: 225, dy: -165 },
    { dx: 225, dy: -40 },
  ]);
  route(`${refs.timer}-pin8-vcc`, nets.vcc, [
    { dx: 335, dy: -135 },
    { dx: 335, dy: -40 },
  ]);
  route(`${refs.cDecouple}-pin1-vcc`, nets.vcc, [
    { dx: 370, dy: -65 },
    { dx: 370, dy: -40 },
  ]);

  // 2. GND Rail (GND) and connections
  route(`${refs.timer}-gnd-rail`, nets.gnd, [
    { dx: 80, dy: -280 },
    { dx: 580, dy: -280 },
  ]);
  route(`${refs.cTiming}-pin2-gnd`, nets.gnd, [
    { dx: 140, dy: -250 },
    { dx: 140, dy: -280 },
  ]);
  route(`${refs.timer}-pin1-gnd`, nets.gnd, [
    { dx: 225, dy: -135 },
    { dx: 225, dy: -280 },
  ]);
  route(`${refs.cCtrl}-pin2-gnd`, nets.gnd, [
    { dx: 410, dy: -245 },
    { dx: 410, dy: -280 },
  ]);
  route(`${refs.cDecouple}-pin2-gnd`, nets.gnd, [
    { dx: 410, dy: -65 },
    { dx: 410, dy: -280 },
  ]);
  route(`${refs.led}-pin2-gnd`, nets.gnd, [
    { dx: 580, dy: -150 },
    { dx: 580, dy: -280 },
  ]);

  // 3. Discharge Node (DISCH)
  route(`${refs.r1}-${refs.r2}-disch`, nets.discharge, [
    { dx: 140, dy: -70 },
    { dx: 140, dy: -112 },
    { dx: 100, dy: -112 },
    { dx: 100, dy: -155 },
  ]);
  route(`${refs.timer}-pin7-disch`, nets.discharge, [
    { dx: 335, dy: -145 },
    { dx: 120, dy: -145 },
    { dx: 120, dy: -112 },
  ]);

  // 4. Timing Node (TIMING)
  route(`${refs.r2}-${refs.cTiming}-timing`, nets.timing, [
    { dx: 140, dy: -155 },
    { dx: 140, dy: -202 },
    { dx: 100, dy: -202 },
    { dx: 100, dy: -250 },
  ]);
  route(`${refs.timer}-pin6-thresh`, nets.timing, [
    { dx: 335, dy: -155 },
    { dx: 335, dy: -202 },
    { dx: 120, dy: -202 },
  ]);
  route(`${refs.timer}-pin2-trig`, nets.timing, [
    { dx: 225, dy: -145 },
    { dx: 225, dy: -202 },
    { dx: 120, dy: -202 },
  ]);

  // 5. Control bypass Node (CTRL)
  route(`${refs.timer}-pin5-ctrl`, nets.control, [
    { dx: 335, dy: -165 },
    { dx: 370, dy: -165 },
    { dx: 370, dy: -245 },
  ]);

  // 6. Output Node (OUT)
  route(`${refs.timer}-pin3-out`, nets.output, [
    { dx: 225, dy: -155 },
    { dx: 225, dy: -190 },
    { dx: 450, dy: -190 },
    { dx: 450, dy: -150 },
  ]);

  // 7. LED Anode (LED_A)
  route(`${refs.rLed}-${refs.led}-anode`, nets.ledAnode, [
    { dx: 490, dy: -150 },
    { dx: 540, dy: -150 },
  ]);

  return wires;
}
