import {
  planSafeSchematicRegion,
  type SchematicRegionPreference,
} from './schematic-safe-region.js';
import type { WorkflowBlockInput, WorkflowDeviceItem } from './types.js';

export type ServoModuleBlockId =
  | 'power_usb'
  | 'rp2040_core'
  | 'decoupling'
  | 'motor_driver'
  | 'leds'
  | 'connectors'
  | 'level_shifter';

export interface ServoModuleBlockPlan {
  id: ServoModuleBlockId;
  title: string;
  origin: { x: number; y: number };
  size: { width: number; height: number };
  refs: string[];
}

export interface Rp2040ServoModuleDevices {
  resistor0402: WorkflowDeviceItem;
  capacitor0402: WorkflowDeviceItem;
  capacitor0603: WorkflowDeviceItem;
  capacitorPolarized: WorkflowDeviceItem;
  rp2040: WorkflowDeviceItem;
  drv8244: WorkflowDeviceItem;
  w25q16: WorkflowDeviceItem;
  txs0102: WorkflowDeviceItem;
  regulator3v3: WorkflowDeviceItem;
  usbC: WorkflowDeviceItem;
  ws2812b: WorkflowDeviceItem;
  conn01x10: WorkflowDeviceItem;
  conn01x06: WorkflowDeviceItem;
  conn01x03: WorkflowDeviceItem;
  crystal: WorkflowDeviceItem;
  switchSmd: WorkflowDeviceItem;
  fuse: WorkflowDeviceItem;
  diode: WorkflowDeviceItem;
}

export interface Rp2040ServoModuleInput {
  projectId: string;
  mode?: 'preview' | 'apply';
  devices: Rp2040ServoModuleDevices;
  sheetInfo?: unknown;
  anchor?: { x: number; y: number };
  preferredRegion?: SchematicRegionPreference;
  margin?: number;
}

export interface Rp2040ServoModulePlan {
  workflowInput: WorkflowBlockInput;
  safeRegion: ReturnType<typeof planSafeSchematicRegion>;
  blocks: ServoModuleBlockPlan[];
  bom: {
    expectedRefs: string[];
    referenceCount: number;
    symbolGroups: Array<{ symbol: string; refs: string[]; count: number }>;
  };
  warnings: string[];
  notes: string[];
}

const CONTENT = { width: 1260, height: 760 } as const;

const BLOCK_DEFS: Array<
  Omit<ServoModuleBlockPlan, 'origin'> & { offset: { dx: number; dy: number } }
> = [
  {
    id: 'power_usb',
    title: 'power and usb',
    offset: { dx: 0, dy: -40 },
    size: { width: 390, height: 290 },
    refs: ['P1', 'FH1', 'D1', 'U2', 'C5', 'C7', 'C9', 'C10', 'R1', 'R2', 'R3', 'R4'],
  },
  {
    id: 'rp2040_core',
    title: 'rp2040 and reqs',
    offset: { dx: 440, dy: -40 },
    size: { width: 500, height: 460 },
    refs: ['U3', 'U1', 'X1', 'SW1', 'SW2', 'R5', 'R6', 'R7', 'R8', 'R9', 'C1', 'C2', 'C3', 'C4'],
  },
  {
    id: 'decoupling',
    title: 'decoupling and rails',
    offset: { dx: 955, dy: -40 },
    size: { width: 305, height: 270 },
    refs: ['C6', 'C8', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C19', 'C20', 'C21', 'C22'],
  },
  {
    id: 'motor_driver',
    title: 'motor driver',
    offset: { dx: 0, dy: -385 },
    size: { width: 390, height: 210 },
    refs: ['U4', 'R10', 'R11', 'R12', 'C17', 'C18'],
  },
  {
    id: 'level_shifter',
    title: 'level shifter',
    offset: { dx: 520, dy: -535 },
    size: { width: 210, height: 160 },
    refs: ['U5'],
  },
  {
    id: 'leds',
    title: 'LEDs',
    offset: { dx: 440, dy: -625 },
    size: { width: 430, height: 135 },
    refs: ['LED1', 'LED2', 'LED3', 'LED4'],
  },
  {
    id: 'connectors',
    title: 'connectors',
    offset: { dx: 0, dy: -720 },
    size: { width: 900, height: 160 },
    refs: ['J1', 'J2', 'J3', 'J4'],
  },
];

const SYMBOL_GROUPS = [
  {
    symbol: 'symbols_R',
    refs: [
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R10',
      'R11',
      'R12',
      'R13',
      'R14',
      'R15',
    ],
  },
  {
    symbol: 'symbols_C',
    refs: [
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C8',
      'C9',
      'C10',
      'C11',
      'C12',
      'C13',
      'C14',
      'C15',
      'C16',
      'C17',
      'C18',
      'C19',
      'C20',
      'C21',
      'C22',
    ],
  },
  { symbol: 'symbols_C_Polarized', refs: ['C7'] },
  { symbol: 'symbols_DRV8244SQRYJRQ1', refs: ['U4'] },
  { symbol: 'symbols_WS2812B-2020', refs: ['LED1', 'LED2', 'LED3', 'LED4'] },
  { symbol: 'symbols_W25Q16JVSS', refs: ['U1'] },
  { symbol: 'symbols_RP2040', refs: ['U3'] },
  { symbol: 'symbols_TXS0102DCU', refs: ['U5'] },
  { symbol: 'symbols_USB_C_Plug_USB2.0', refs: ['P1'] },
  { symbol: 'symbols_ME6211A33M3G-N', refs: ['U2'] },
  { symbol: 'symbols_ABM8-272-T3_C20625731', refs: ['X1'] },
  { symbol: 'symbols_TS-1088-AR02016', refs: ['SW1', 'SW2'] },
  { symbol: 'symbols_Conn_01x10', refs: ['J1', 'J2'] },
  { symbol: 'symbols_Conn_01x06', refs: ['J4'] },
  { symbol: 'symbols_Conn_01x03', refs: ['J3'] },
  { symbol: 'symbols_01550900M', refs: ['FH1'] },
  { symbol: 'symbols_MBR1020VL', refs: ['D1'] },
] as const;

function devFor(ref: string, devices: Rp2040ServoModuleDevices): WorkflowDeviceItem {
  if (ref.startsWith('R')) return devices.resistor0402;
  if (ref === 'C7') return devices.capacitorPolarized;
  if (['C5', 'C9'].includes(ref)) return devices.capacitor0603;
  if (ref.startsWith('C')) return devices.capacitor0402;
  if (ref === 'U3') return devices.rp2040;
  if (ref === 'U4') return devices.drv8244;
  if (ref === 'U1') return devices.w25q16;
  if (ref === 'U5') return devices.txs0102;
  if (ref === 'U2') return devices.regulator3v3;
  if (ref === 'P1') return devices.usbC;
  if (ref.startsWith('LED')) return devices.ws2812b;
  if (ref === 'J1' || ref === 'J2') return devices.conn01x10;
  if (ref === 'J4') return devices.conn01x06;
  if (ref === 'J3') return devices.conn01x03;
  if (ref === 'X1') return devices.crystal;
  if (ref === 'SW1' || ref === 'SW2') return devices.switchSmd;
  if (ref === 'FH1') return devices.fuse;
  if (ref === 'D1') return devices.diode;
  return devices.resistor0402;
}

const REF_OFFSETS: Record<string, { dx: number; dy: number; rotation?: number }> = {
  P1: { dx: 90, dy: -170 },
  FH1: { dx: 45, dy: -260 },
  D1: { dx: 235, dy: -110 },
  U2: { dx: 270, dy: -125 },
  R1: { dx: 40, dy: -60, rotation: 180 },
  R2: { dx: 45, dy: -105, rotation: 180 },
  R3: { dx: 160, dy: -60, rotation: 180 },
  R4: { dx: 160, dy: -105, rotation: 180 },
  C5: { dx: 315, dy: -70 },
  C7: { dx: 170, dy: -200 },
  C9: { dx: 270, dy: -185 },
  C10: { dx: 340, dy: -185 },

  U3: { dx: 720, dy: -220 },
  U1: { dx: 565, dy: -170 },
  X1: { dx: 565, dy: -330 },
  SW1: { dx: 610, dy: -250 },
  SW2: { dx: 800, dy: -85 },
  R5: { dx: 540, dy: -250, rotation: 270 },
  R6: { dx: 505, dy: -85, rotation: 180 },
  R7: { dx: 630, dy: -335 },
  R8: { dx: 640, dy: -150, rotation: 180 },
  R9: { dx: 675, dy: -150, rotation: 180 },
  C1: { dx: 455, dy: -270 },
  C2: { dx: 540, dy: -390 },
  C3: { dx: 490, dy: -275 },
  C4: { dx: 645, dy: -390 },

  C6: { dx: 980, dy: -115 },
  C8: { dx: 1110, dy: -225 },
  C11: { dx: 965, dy: -35 },
  C12: { dx: 990, dy: -185 },
  C13: { dx: 1030, dy: -185 },
  C14: { dx: 1070, dy: -205 },
  C15: { dx: 1060, dy: -35 },
  C16: { dx: 1055, dy: -80 },
  C19: { dx: 1145, dy: -35 },
  C20: { dx: 1155, dy: -120 },
  C21: { dx: 1195, dy: -165 },
  C22: { dx: 1235, dy: -35 },
  R13: { dx: 1125, dy: -145 },
  R14: { dx: 960, dy: -145 },
  R15: { dx: 960, dy: -185 },

  U4: { dx: 220, dy: -485 },
  R10: { dx: 155, dy: -485, rotation: 90 },
  R11: { dx: 255, dy: -485, rotation: 90 },
  R12: { dx: 45, dy: -505 },
  C17: { dx: 45, dy: -545 },
  C18: { dx: 110, dy: -545 },

  U5: { dx: 590, dy: -545 },
  LED1: { dx: 450, dy: -675 },
  LED2: { dx: 550, dy: -675 },
  LED3: { dx: 650, dy: -675 },
  LED4: { dx: 750, dy: -675 },

  J1: { dx: 95, dy: -790 },
  J2: { dx: 340, dy: -790 },
  J3: { dx: 540, dy: -815 },
  J4: { dx: 700, dy: -790 },
};

function expectedRefs(): string[] {
  return [...new Set(SYMBOL_GROUPS.flatMap((group) => [...group.refs]))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
}

function buildBlocks(anchor: { x: number; y: number }): ServoModuleBlockPlan[] {
  return BLOCK_DEFS.map((block) => ({
    id: block.id,
    title: block.title,
    size: block.size,
    refs: block.refs,
    origin: { x: anchor.x + block.offset.dx, y: anchor.y + block.offset.dy },
  }));
}

export function buildRp2040ServoModuleScaffold(
  input: Rp2040ServoModuleInput,
): Rp2040ServoModulePlan {
  const safeRegion = planSafeSchematicRegion({
    sheetInfo: input.sheetInfo,
    contentWidth: CONTENT.width,
    contentHeight: CONTENT.height,
    preferredRegion: input.preferredRegion ?? 'upper-left',
    margin: input.margin,
  });
  const anchor = input.anchor ?? safeRegion.anchor;
  const refs = expectedRefs();
  const components = refs.map((ref) => {
    const offset = REF_OFFSETS[ref] ?? { dx: 0, dy: 0 };
    return {
      ref,
      role: `servo-module:${ref}`,
      deviceItem: devFor(ref, input.devices),
      placementOffset: { dx: offset.dx, dy: offset.dy },
      rotation: offset.rotation,
      pinConnections: [],
    };
  });

  const workflowInput: WorkflowBlockInput = {
    projectId: input.projectId,
    mode: input.mode ?? 'preview',
    anchor,
    spacing: 50,
    components,
    netPorts: [],
    wires: [],
  };

  return {
    workflowInput,
    safeRegion,
    blocks: buildBlocks(anchor),
    bom: {
      expectedRefs: refs,
      referenceCount: refs.length,
      symbolGroups: SYMBOL_GROUPS.map((group) => ({
        symbol: group.symbol,
        refs: [...group.refs],
        count: group.refs.length,
      })),
    },
    warnings: [
      'This scaffold intentionally places BOM blocks only; exact pin-to-net wiring is not inferred from screenshot+BOM.',
      'Use follow-up block workflows for power/USB, RP2040 core, motor driver, LEDs, connectors, and level shifter netlists.',
      'Apply mode will place components without electrical connectivity, so ERC warnings are expected until block netlists are added.',
    ],
    notes: [
      'Functional blocks mirror the user-provided servo-module reference: power and usb, rp2040 and reqs, motor driver, LEDs, connectors, decoupling, and level shifter.',
      'Detached netports are disabled by default; future netlist milestones should add visible wiring per block.',
    ],
  };
}
