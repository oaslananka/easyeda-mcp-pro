/**
 * LED blinker template — Level 1 complexity.
 *
 * A simple but complete circuit: LED + current-limiting resistor, with a
 * switch to control power.  This is the simplest circuit that exercises the
 * full MCP workflow pipeline: safe region planning, component placement,
 * pin-to-net connectivity, wire stub generation, and post-write QA.
 *
 * Reference design: LED forward current limited by series resistor.
 *   R = (Vsupply - Vf) / If
 *   Default: (5V - 2V) / 20mA = 150Ω → use 150Ω standard value
 *
 * Schematic topology (left-to-right signal flow):
 *   VCC → Switch → Resistor → LED → GND
 *
 * @module
 */

import {
  planSafeSchematicRegion,
  type SchematicRegionPreference,
} from './schematic-safe-region.js';
import type { WorkflowBlockInput, WorkflowDeviceItem } from './types.js';
import {
  generateStubsForComponents,
  twoPinPassiveStubs,
  type ComponentStubSpec,
  type RelativePinStub,
} from './wire-stub-generator.js';

export interface LedBlinkerDevices {
  resistor: WorkflowDeviceItem;
  led: WorkflowDeviceItem;
  switch: WorkflowDeviceItem;
}

export interface LedBlinkerRefs {
  switch: string;
  resistor: string;
  led: string;
}

export interface LedBlinkerNets {
  vcc: string;
  gnd: string;
  switched: string;
  ledAnode: string;
}

export interface LedBlinkerValues {
  supplyVoltage: number;
  ledForwardVoltage: number;
  ledForwardCurrentMa: number;
  resistorOhms: number;
}

export interface LedBlinkerPinMaps {
  switch: { p1: string; p2: string; p3?: string; p4?: string };
  resistor: { p1: string; p2: string };
  led: { anode: string; cathode: string };
}

export interface LedBlinkerTemplateInput {
  projectId: string;
  mode?: 'preview' | 'apply';
  devices: LedBlinkerDevices;
  anchor?: { x: number; y: number };
  sheetInfo?: unknown;
  preferredRegion?: SchematicRegionPreference;
  margin?: number;
  createNetPorts?: boolean;
  createWireStubs?: boolean;
  refs?: Partial<LedBlinkerRefs>;
  nets?: Partial<LedBlinkerNets>;
  values?: Partial<LedBlinkerValues>;
  pinMaps?: Partial<{
    switch: Partial<{ p1: string; p2: string; p3: string; p4: string }>;
    resistor: Partial<{ p1: string; p2: string }>;
    led: Partial<{ anode: string; cathode: string }>;
  }>;
}

export interface LedBlinkerTemplatePlan {
  workflowInput: WorkflowBlockInput;
  safeRegion: ReturnType<typeof planSafeSchematicRegion>;
  refs: LedBlinkerRefs;
  nets: LedBlinkerNets;
  values: LedBlinkerValues;
  pinMaps: LedBlinkerPinMaps;
  calculated: {
    currentMa: number;
    resistorPowerMw: number;
    ledPowerMw: number;
    totalPowerMw: number;
  };
  designNotes: string[];
  componentCount: number;
}

/** Content bounding box (schematic units) for safe region planning. */
export const LED_BLINKER_CONTENT = {
  width: 380,
  height: 120,
} as const;

const DEFAULT_REFS: LedBlinkerRefs = {
  switch: 'SW1',
  resistor: 'R1',
  led: 'D1',
};

const DEFAULT_NETS: LedBlinkerNets = {
  vcc: '+5V',
  gnd: 'GND',
  switched: 'SW_OUT',
  ledAnode: 'LED_A',
};

const DEFAULT_VALUES: LedBlinkerValues = {
  supplyVoltage: 5,
  ledForwardVoltage: 2.0,
  ledForwardCurrentMa: 20,
  resistorOhms: 150,
};

const DEFAULT_PIN_MAPS: LedBlinkerPinMaps = {
  switch: { p1: '1', p2: '2' },
  resistor: { p1: '1', p2: '2' },
  led: { anode: '1', cathode: '2' },
};

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function calculateLedBlinker(values: LedBlinkerValues) {
  const currentMa = values.ledForwardCurrentMa;
  const currentA = currentMa / 1000;
  const voltageDrop = values.supplyVoltage - values.ledForwardVoltage;
  const resistorPowerMw = round(voltageDrop * currentA * 1000, 1);
  const ledPowerMw = round(values.ledForwardVoltage * currentA * 1000, 1);
  const totalPowerMw = round(resistorPowerMw + ledPowerMw, 1);
  return {
    currentMa: round(currentMa, 1),
    resistorPowerMw,
    ledPowerMw,
    totalPowerMw,
  };
}

function mergePinMaps(input?: LedBlinkerTemplateInput['pinMaps']): LedBlinkerPinMaps {
  return {
    switch: input?.switch
      ? { ...DEFAULT_PIN_MAPS.switch, ...input.switch }
      : DEFAULT_PIN_MAPS.switch,
    resistor: input?.resistor
      ? { ...DEFAULT_PIN_MAPS.resistor, ...input.resistor }
      : DEFAULT_PIN_MAPS.resistor,
    led: input?.led ? { ...DEFAULT_PIN_MAPS.led, ...input.led } : DEFAULT_PIN_MAPS.led,
  };
}

/**
 * Build a Level-1 LED blinker template plan.
 *
 * Layout (left-to-right signal flow):
 *   SW1 (x+0) → R1 (x+130) → D1 (x+260)
 *
 * This layout follows professional schematic conventions:
 * - Signal flows left to right
 * - Power enters from the left
 * - Ground exits from the right (LED cathode)
 * - Components are aligned on the same horizontal axis
 * - Even spacing for visual balance
 */
export function buildLedBlinkerTemplate(input: LedBlinkerTemplateInput): LedBlinkerTemplatePlan {
  const refs = input.refs ? { ...DEFAULT_REFS, ...input.refs } : DEFAULT_REFS;
  const nets = input.nets ? { ...DEFAULT_NETS, ...input.nets } : DEFAULT_NETS;
  const values = input.values ? { ...DEFAULT_VALUES, ...input.values } : DEFAULT_VALUES;
  const pinMaps = mergePinMaps(input.pinMaps);

  const safeRegion = planSafeSchematicRegion({
    sheetInfo: input.sheetInfo,
    contentWidth: LED_BLINKER_CONTENT.width,
    contentHeight: LED_BLINKER_CONTENT.height,
    preferredRegion: input.preferredRegion ?? 'upper-left',
    margin: input.margin,
  });
  const anchor = input.anchor ?? safeRegion.anchor;

  const switchConnections = [
    { pin: pinMaps.switch.p1, netName: nets.vcc },
    { pin: pinMaps.switch.p2, netName: nets.switched },
  ];
  if (pinMaps.switch.p3) switchConnections.push({ pin: pinMaps.switch.p3, netName: nets.vcc });
  if (pinMaps.switch.p4) switchConnections.push({ pin: pinMaps.switch.p4, netName: nets.switched });

  const components: NonNullable<WorkflowBlockInput['components']> = [
    {
      ref: refs.switch,
      role: 'power-switch',
      deviceItem: input.devices.switch,
      placementOffset: { dx: 0, dy: -50 },
      pinConnections: switchConnections,
    },
    {
      ref: refs.resistor,
      role: `current-limiting-resistor-${values.resistorOhms}ohm`,
      deviceItem: input.devices.resistor,
      placementOffset: { dx: 130, dy: -50 },
      pinConnections: [
        { pin: pinMaps.resistor.p1, netName: nets.switched },
        { pin: pinMaps.resistor.p2, netName: nets.ledAnode },
      ],
    },
    {
      ref: refs.led,
      role: 'indicator-led',
      deviceItem: input.devices.led,
      rotation: 180,
      placementOffset: { dx: 260, dy: -50 },
      pinConnections: [
        { pin: pinMaps.led.anode, netName: nets.ledAnode },
        { pin: pinMaps.led.cathode, netName: nets.gnd },
      ],
    },
  ];

  const switchPins: RelativePinStub[] = [
    { pin: pinMaps.switch.p1, netName: nets.vcc, dx: -20, dy: 10, direction: 'left' as const },
    { pin: pinMaps.switch.p2, netName: nets.switched, dx: 20, dy: 10, direction: 'right' as const },
  ];
  if (pinMaps.switch.p3) {
    switchPins.push({
      pin: pinMaps.switch.p3,
      netName: nets.vcc,
      dx: -20,
      dy: -20,
      direction: 'left' as const,
    });
  }
  if (pinMaps.switch.p4) {
    switchPins.push({
      pin: pinMaps.switch.p4,
      netName: nets.switched,
      dx: 20,
      dy: -20,
      direction: 'right' as const,
    });
  }

  const switchStubs: ComponentStubSpec = {
    ref: refs.switch,
    placementOffset: { dx: 0, dy: -50 },
    pins: switchPins,
  };

  const stubSpecs: ComponentStubSpec[] = [
    switchStubs,
    twoPinPassiveStubs(refs.resistor, { dx: 130, dy: -50 }, nets.switched, nets.ledAnode),
    {
      ref: refs.led,
      placementOffset: { dx: 260, dy: -50 },
      pins: [
        { pin: '1', netName: nets.ledAnode, dx: -20, dy: 0, direction: 'left' as const },
        { pin: '2', netName: nets.gnd, dx: 20, dy: 0, direction: 'right' as const },
      ],
    },
  ];

  const wires = input.createWireStubs === true ? generateStubsForComponents(anchor, stubSpecs) : [];

  const workflowInput: WorkflowBlockInput = {
    projectId: input.projectId,
    mode: input.mode ?? 'preview',
    anchor,
    spacing: 70,
    components,
    wires,
    netPortAnchor: input.createNetPorts ? { x: anchor.x, y: anchor.y - 20 } : undefined,
    netPorts: input.createNetPorts
      ? [
          { netName: nets.vcc, portType: 'input' },
          { netName: nets.gnd, portType: 'passive' },
        ]
      : [],
  };

  return {
    workflowInput,
    safeRegion,
    refs,
    nets,
    values,
    pinMaps,
    calculated: calculateLedBlinker(values),
    componentCount: components.length,
    designNotes: [
      `LED blinker: ${refs.switch} controls power, ${refs.resistor} limits current to ${values.ledForwardCurrentMa}mA, ${refs.led} indicates output.`,
      `R = (${values.supplyVoltage}V - ${values.ledForwardVoltage}V) / ${values.ledForwardCurrentMa}mA = ${values.resistorOhms}Ω.`,
      'Signal flows left-to-right: VCC → Switch → Resistor → LED → GND.',
      'Exact pin-to-net connectivity is created by bridge pin readback; extra template guide wires are opt-in until routing can use live symbol pin geometry.',
    ],
  };
}
