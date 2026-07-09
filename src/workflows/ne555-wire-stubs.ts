import type { WorkflowWireInput } from './types.js';
import type { Ne555AstableNets, Ne555AstableRefs } from './ne555-astable-template.js';

function horizontalStub(
  role: string,
  netName: string,
  x: number,
  y: number,
  direction: 'left' | 'right',
  length = 18,
): WorkflowWireInput {
  const endX = direction === 'left' ? x - length : x + length;
  return {
    role,
    netName,
    points: [
      { x, y },
      { x: endX, y },
    ],
    lineWidth: 1,
  };
}

export function buildNe555VisibleWireStubs(
  anchor: { x: number; y: number },
  refs: Ne555AstableRefs,
  nets: Ne555AstableNets,
): WorkflowWireInput[] {
  const at = (dx: number, dy: number) => ({ x: anchor.x + dx, y: anchor.y + dy });
  const wires: WorkflowWireInput[] = [];

  const u1 = at(280, -150);
  wires.push(horizontalStub(`${refs.timer}-pin1-gnd-stub`, nets.gnd, u1.x - 55, u1.y + 15, 'left'));
  wires.push(
    horizontalStub(`${refs.timer}-pin2-trig-stub`, nets.timing, u1.x - 55, u1.y + 5, 'left'),
  );
  wires.push(
    horizontalStub(`${refs.timer}-pin3-out-stub`, nets.output, u1.x - 55, u1.y - 5, 'left'),
  );
  wires.push(
    horizontalStub(`${refs.timer}-pin4-reset-stub`, nets.vcc, u1.x - 55, u1.y - 15, 'left'),
  );
  wires.push(
    horizontalStub(`${refs.timer}-pin5-ctrl-stub`, nets.control, u1.x + 55, u1.y - 15, 'right'),
  );
  wires.push(
    horizontalStub(`${refs.timer}-pin6-thresh-stub`, nets.timing, u1.x + 55, u1.y - 5, 'right'),
  );
  wires.push(
    horizontalStub(`${refs.timer}-pin7-disch-stub`, nets.discharge, u1.x + 55, u1.y + 5, 'right'),
  );
  wires.push(
    horizontalStub(`${refs.timer}-pin8-vcc-stub`, nets.vcc, u1.x + 55, u1.y + 15, 'right'),
  );

  const twoPin = (
    ref: string,
    center: { x: number; y: number },
    leftNet: string,
    rightNet: string,
  ) => {
    wires.push(horizontalStub(`${ref}-pin1-stub`, leftNet, center.x - 20, center.y, 'left'));
    wires.push(horizontalStub(`${ref}-pin2-stub`, rightNet, center.x + 20, center.y, 'right'));
  };

  twoPin(refs.r1, at(120, -70), nets.vcc, nets.discharge);
  twoPin(refs.r2, at(120, -155), nets.discharge, nets.timing);
  twoPin(refs.cTiming, at(120, -250), nets.timing, nets.gnd);
  twoPin(refs.cCtrl, at(390, -245), nets.control, nets.gnd);
  twoPin(refs.cDecouple, at(390, -65), nets.vcc, nets.gnd);
  twoPin(refs.rLed, at(470, -150), nets.output, nets.ledAnode);
  twoPin(refs.led, at(560, -150), nets.ledAnode, nets.gnd);

  return wires;
}
