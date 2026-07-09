import {
  planSafeSchematicRegion,
  type SchematicRegionPreference,
} from './schematic-safe-region.js';
import type { WorkflowBlockInput, WorkflowDeviceItem } from './types.js';

export interface TwoPinMap {
  p1: string;
  p2: string;
}

export interface Ne555TimerPinMap {
  gnd: string;
  trig: string;
  out: string;
  reset: string;
  ctrl: string;
  thresh: string;
  disch: string;
  vcc: string;
}

export interface Ne555AstableDevices {
  timer: WorkflowDeviceItem;
  resistor: WorkflowDeviceItem;
  timingCapacitor: WorkflowDeviceItem;
  bypassCapacitor: WorkflowDeviceItem;
  led: WorkflowDeviceItem;
}

export interface Ne555AstableRefs {
  timer: string;
  r1: string;
  r2: string;
  cTiming: string;
  cCtrl: string;
  cDecouple: string;
  rLed: string;
  led: string;
}

export interface Ne555AstableNets {
  vcc: string;
  gnd: string;
  timing: string;
  discharge: string;
  control: string;
  output: string;
  ledAnode: string;
}

export interface Ne555AstableValues {
  supplyVoltage: number;
  r1Ohms: number;
  r2Ohms: number;
  timingCapacitanceUf: number;
  controlCapacitanceNf: number;
  decouplingCapacitanceNf: number;
  ledSeriesOhms: number;
}

export interface Ne555AstablePinMaps {
  timer: Ne555TimerPinMap;
  resistor: TwoPinMap;
  capacitor: TwoPinMap;
  led: { anode: string; cathode: string };
}

export interface Ne555AstableTemplateInput {
  projectId: string;
  mode?: 'preview' | 'apply';
  devices: Ne555AstableDevices;
  anchor?: { x: number; y: number };
  sheetInfo?: unknown;
  preferredRegion?: SchematicRegionPreference;
  margin?: number;
  refs?: Partial<Ne555AstableRefs>;
  nets?: Partial<Ne555AstableNets>;
  values?: Partial<Ne555AstableValues>;
  pinMaps?: Partial<{
    timer: Partial<Ne555TimerPinMap>;
    resistor: Partial<TwoPinMap>;
    capacitor: Partial<TwoPinMap>;
    led: Partial<{ anode: string; cathode: string }>;
  }>;
}

export interface Ne555AstableTemplatePlan {
  workflowInput: WorkflowBlockInput;
  safeRegion: ReturnType<typeof planSafeSchematicRegion>;
  refs: Ne555AstableRefs;
  nets: Ne555AstableNets;
  values: Ne555AstableValues;
  pinMaps: Ne555AstablePinMaps;
  calculated: {
    frequencyHz: number;
    periodSeconds: number;
    highTimeSeconds: number;
    lowTimeSeconds: number;
    dutyCyclePercent: number;
  };
  designNotes: string[];
  componentCount: number;
}

export const NE555_ASTABLE_CONTENT = {
  width: 620,
  height: 360,
} as const;

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

const DEFAULT_VALUES: Ne555AstableValues = {
  supplyVoltage: 5,
  r1Ohms: 1000,
  r2Ohms: 68000,
  timingCapacitanceUf: 10,
  controlCapacitanceNf: 10,
  decouplingCapacitanceNf: 100,
  ledSeriesOhms: 330,
};

const DEFAULT_PIN_MAPS: Ne555AstablePinMaps = {
  timer: {
    gnd: '1',
    trig: '2',
    out: '3',
    reset: '4',
    ctrl: '5',
    thresh: '6',
    disch: '7',
    vcc: '8',
  },
  resistor: { p1: '1', p2: '2' },
  capacitor: { p1: '1', p2: '2' },
  led: { anode: '1', cathode: '2' },
};

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function calculateNe555Astable(values: Ne555AstableValues) {
  const capacitanceF = values.timingCapacitanceUf * 1e-6;
  const highTimeSeconds = 0.693 * (values.r1Ohms + values.r2Ohms) * capacitanceF;
  const lowTimeSeconds = 0.693 * values.r2Ohms * capacitanceF;
  const periodSeconds = highTimeSeconds + lowTimeSeconds;
  const frequencyHz = periodSeconds > 0 ? 1 / periodSeconds : 0;
  const dutyCyclePercent = periodSeconds > 0 ? (highTimeSeconds / periodSeconds) * 100 : 0;
  return {
    frequencyHz: round(frequencyHz, 3),
    periodSeconds: round(periodSeconds, 3),
    highTimeSeconds: round(highTimeSeconds, 3),
    lowTimeSeconds: round(lowTimeSeconds, 3),
    dutyCyclePercent: round(dutyCyclePercent, 1),
  };
}

function mergePinMaps(input?: Ne555AstableTemplateInput['pinMaps']): Ne555AstablePinMaps {
  return {
    timer: input?.timer ? { ...DEFAULT_PIN_MAPS.timer, ...input.timer } : DEFAULT_PIN_MAPS.timer,
    resistor: input?.resistor
      ? { ...DEFAULT_PIN_MAPS.resistor, ...input.resistor }
      : DEFAULT_PIN_MAPS.resistor,
    capacitor: input?.capacitor
      ? { ...DEFAULT_PIN_MAPS.capacitor, ...input.capacitor }
      : DEFAULT_PIN_MAPS.capacitor,
    led: input?.led ? { ...DEFAULT_PIN_MAPS.led, ...input.led } : DEFAULT_PIN_MAPS.led,
  };
}

export function buildNe555AstableTemplate(
  input: Ne555AstableTemplateInput,
): Ne555AstableTemplatePlan {
  const refs = input.refs ? { ...DEFAULT_REFS, ...input.refs } : DEFAULT_REFS;
  const nets = input.nets ? { ...DEFAULT_NETS, ...input.nets } : DEFAULT_NETS;
  const values = input.values ? { ...DEFAULT_VALUES, ...input.values } : DEFAULT_VALUES;
  const pinMaps = mergePinMaps(input.pinMaps);
  const safeRegion = planSafeSchematicRegion({
    sheetInfo: input.sheetInfo,
    contentWidth: NE555_ASTABLE_CONTENT.width,
    contentHeight: NE555_ASTABLE_CONTENT.height,
    preferredRegion: input.preferredRegion ?? 'upper-left',
    margin: input.margin,
  });
  const anchor = input.anchor ?? safeRegion.anchor;

  const components: NonNullable<WorkflowBlockInput['components']> = [
    {
      ref: refs.timer,
      role: 'ne555-timer',
      deviceItem: input.devices.timer,
      placementOffset: { dx: 280, dy: -150 },
      pinConnections: [
        { pin: pinMaps.timer.gnd, netName: nets.gnd },
        { pin: pinMaps.timer.trig, netName: nets.timing },
        { pin: pinMaps.timer.out, netName: nets.output },
        { pin: pinMaps.timer.reset, netName: nets.vcc },
        { pin: pinMaps.timer.ctrl, netName: nets.control },
        { pin: pinMaps.timer.thresh, netName: nets.timing },
        { pin: pinMaps.timer.disch, netName: nets.discharge },
        { pin: pinMaps.timer.vcc, netName: nets.vcc },
      ],
    },
    {
      ref: refs.r1,
      role: `timing-resistor-r1-${values.r1Ohms}ohm`,
      deviceItem: input.devices.resistor,
      placementOffset: { dx: 120, dy: -70 },
      pinConnections: [
        { pin: pinMaps.resistor.p1, netName: nets.vcc },
        { pin: pinMaps.resistor.p2, netName: nets.discharge },
      ],
    },
    {
      ref: refs.r2,
      role: `timing-resistor-r2-${values.r2Ohms}ohm`,
      deviceItem: input.devices.resistor,
      placementOffset: { dx: 120, dy: -155 },
      pinConnections: [
        { pin: pinMaps.resistor.p1, netName: nets.discharge },
        { pin: pinMaps.resistor.p2, netName: nets.timing },
      ],
    },
    {
      ref: refs.cTiming,
      role: `timing-capacitor-${values.timingCapacitanceUf}uf`,
      deviceItem: input.devices.timingCapacitor,
      placementOffset: { dx: 120, dy: -250 },
      pinConnections: [
        { pin: pinMaps.capacitor.p1, netName: nets.timing },
        { pin: pinMaps.capacitor.p2, netName: nets.gnd },
      ],
    },
    {
      ref: refs.cCtrl,
      role: `control-bypass-${values.controlCapacitanceNf}nf`,
      deviceItem: input.devices.bypassCapacitor,
      placementOffset: { dx: 390, dy: -245 },
      pinConnections: [
        { pin: pinMaps.capacitor.p1, netName: nets.control },
        { pin: pinMaps.capacitor.p2, netName: nets.gnd },
      ],
    },
    {
      ref: refs.cDecouple,
      role: `supply-decoupling-${values.decouplingCapacitanceNf}nf`,
      deviceItem: input.devices.bypassCapacitor,
      placementOffset: { dx: 390, dy: -65 },
      pinConnections: [
        { pin: pinMaps.capacitor.p1, netName: nets.vcc },
        { pin: pinMaps.capacitor.p2, netName: nets.gnd },
      ],
    },
    {
      ref: refs.rLed,
      role: `led-series-resistor-${values.ledSeriesOhms}ohm`,
      deviceItem: input.devices.resistor,
      placementOffset: { dx: 470, dy: -150 },
      pinConnections: [
        { pin: pinMaps.resistor.p1, netName: nets.output },
        { pin: pinMaps.resistor.p2, netName: nets.ledAnode },
      ],
    },
    {
      ref: refs.led,
      role: 'output-led-indicator',
      deviceItem: input.devices.led,
      placementOffset: { dx: 560, dy: -150 },
      pinConnections: [
        { pin: pinMaps.led.anode, netName: nets.ledAnode },
        { pin: pinMaps.led.cathode, netName: nets.gnd },
      ],
    },
  ];

  const workflowInput: WorkflowBlockInput = {
    projectId: input.projectId,
    mode: input.mode ?? 'preview',
    anchor,
    spacing: 70,
    components,
    netPortAnchor: { x: anchor.x, y: anchor.y - 20 },
    netPorts: [
      { netName: nets.vcc, portType: 'input' },
      { netName: nets.gnd, portType: 'passive' },
      { netName: nets.output, portType: 'output' },
      { netName: nets.timing, portType: 'passive' },
      { netName: nets.discharge, portType: 'passive' },
      { netName: nets.control, portType: 'passive' },
    ],
  };

  return {
    workflowInput,
    safeRegion,
    refs,
    nets,
    values,
    pinMaps,
    calculated: calculateNe555Astable(values),
    componentCount: components.length,
    designNotes: [
      'NE555 astable LED flasher: U1 is centered, timing network is left, decoupling/control bypass are near U1, and output LED chain is right.',
      'Pin 2 TRIG and pin 6 THRESH are tied to the timing node; pin 7 DISCH is between R1 and R2.',
      'Pin 4 RESET is tied to VCC; pin 5 CTRL is bypassed to GND; C3 is a local VCC/GND decoupling capacitor.',
      'Use post-write QA with circuit policy after apply; duplicate net names, free wire-only nets, and floating pins are blocking failures.',
    ],
  };
}
