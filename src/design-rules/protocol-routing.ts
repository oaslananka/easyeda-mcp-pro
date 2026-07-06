/**
 * Protocol routing reference data.
 *
 * This is generic, widely-published reference guidance (impedance targets, topology,
 * pull-up ranges) for common interconnects, not a precision electrical simulation. It
 * exists to give an agent a quick, citable starting point before laying out a bus —
 * always confirm against the current revision of the cited spec and your target
 * silicon's datasheet, since exact numbers vary by spec revision and vendor.
 *
 * @module
 */

export type ProtocolKey =
  'usb2' | 'usb3' | 'rs485' | 'i2c' | 'spi' | 'uart' | 'ethernet-10-100' | 'ethernet-1000';

export interface ProtocolRoutingGuidance {
  protocol: ProtocolKey;
  displayName: string;
  topology: string;
  differentialImpedanceOhms?: number;
  singleEndedImpedanceOhms?: number;
  terminationOhms?: number;
  terminationNotes?: string;
  pullUpResistanceOhms?: { min: number; max: number };
  lengthMatchingGuidance: string;
  maxRecommendedLengthNotes?: string;
  notes: string[];
  source: string;
  caveat: string;
}

const GENERIC_CAVEAT =
  'Generic reference guidance, not a precision simulation — confirm exact values against ' +
  "the current spec revision and your target silicon's datasheet before finalizing layout.";

const CATALOG: Record<ProtocolKey, ProtocolRoutingGuidance> = {
  usb2: {
    protocol: 'usb2',
    displayName: 'USB 2.0 (D+/D-)',
    topology: 'Point-to-point differential pair (host/hub to device), tree topology via hubs',
    differentialImpedanceOhms: 90,
    lengthMatchingGuidance: 'Match D+/D- trace lengths within about 5 mils (~0.13mm) of each other',
    maxRecommendedLengthNotes:
      'Keep the pair as short and direct as practical; avoid vias and sharp bends on the pair',
    notes: [
      'Route D+/D- as a tightly-coupled differential pair with constant spacing',
      'Keep the pair away from clock lines and switching regulators',
      'Avoid splitting the pair across layers; if a layer change is unavoidable, keep both ' +
        'traces on the same layer transition and add a return-path via for the reference plane',
    ],
    source: 'USB 2.0 Specification (USB-IF) — general signal integrity guidance',
    caveat: GENERIC_CAVEAT,
  },
  usb3: {
    protocol: 'usb3',
    displayName: 'USB 3.x SuperSpeed (TX/RX differential pairs)',
    topology:
      'Point-to-point differential pairs, separate from the USB 2.0 pair in the same connector',
    differentialImpedanceOhms: 90,
    lengthMatchingGuidance: 'Match intra-pair lengths within about 5 mils (~0.13mm)',
    maxRecommendedLengthNotes:
      'Minimize vias on SuperSpeed pairs; each via adds discontinuity that matters more at these rates',
    notes: [
      'TX and RX pairs are independent — do not length-match TX to RX, only within each pair',
      'AC-coupling capacitors are typically required in each SuperSpeed pair per the spec',
      'Keep SuperSpeed pairs away from the USB 2.0 D+/D- pair and other noisy digital signals',
    ],
    source: 'USB 3.2 Specification (USB-IF) — general signal integrity guidance',
    caveat: GENERIC_CAVEAT,
  },
  rs485: {
    protocol: 'rs485',
    displayName: 'RS-485 (TIA/EIA-485)',
    topology: 'Multi-drop daisy-chain bus (not star); stub lengths should be minimized',
    differentialImpedanceOhms: 120,
    terminationOhms: 120,
    terminationNotes:
      'Termination resistor matching the cable/trace characteristic impedance at each of the two ' +
      'physical ends of the bus only (not at every node)',
    lengthMatchingGuidance:
      'Match A/B trace lengths where practical; not as critical as USB/Ethernet',
    notes: [
      'Bus must be wired point-to-point in a daisy chain — star topologies cause reflections',
      'Keep stub lengths from the bus to each transceiver as short as possible',
      'Consider a fail-safe biasing network (pull-up on A, pull-down on B) if the bus can be idle/undriven',
    ],
    source: 'TIA/EIA-485-A — general topology and termination guidance',
    caveat: GENERIC_CAVEAT,
  },
  i2c: {
    protocol: 'i2c',
    displayName: 'I2C / I3C (two-wire, SCL/SDA)',
    topology: 'Multi-drop open-drain bus, shared SCL/SDA across all devices',
    pullUpResistanceOhms: { min: 1000, max: 10000 },
    lengthMatchingGuidance: 'No length matching required (single-ended, low-speed, open-drain bus)',
    maxRecommendedLengthNotes:
      'Keep total bus capacitance under the spec limit (400pF for standard I2C); longer buses or ' +
      'more devices need lower pull-up resistance or a bus buffer/repeater',
    notes: [
      'Both SDA and SCL need pull-up resistors — exact value depends on bus speed and total bus capacitance',
      'Lower resistance pulls up faster (needed for Fast-mode/Fast-mode Plus) but draws more current and ' +
        'loads the open-drain drivers harder',
      'Keep the bus short and avoid routing near noisy switching signals, especially at Fast-mode+ speeds',
    ],
    source: 'NXP UM10204 I2C-bus specification — general pull-up and bus-loading guidance',
    caveat: GENERIC_CAVEAT,
  },
  spi: {
    protocol: 'spi',
    displayName: 'SPI (SCLK/MOSI/MISO/CS)',
    topology: 'Point-to-point or single-master multi-slave with dedicated chip-select per device',
    lengthMatchingGuidance:
      'Match SCLK to MOSI/MISO within a small fraction of the clock period at high frequencies; ' +
      'not critical at low speeds',
    maxRecommendedLengthNotes:
      'No formal max length — driven by signal integrity margin at the chosen clock rate, not a spec limit',
    notes: [
      'No standardized impedance/termination requirement — SPI is not a formal spec, behavior varies by vendor',
      'Keep clock and data lines close in length at higher clock rates to avoid setup/hold violations',
      'Each additional slave adds trace stub and capacitive loading on shared MISO/MOSI/SCLK lines',
    ],
    source: 'Vendor SPI application notes (no single governing standards body) — general practice',
    caveat: GENERIC_CAVEAT,
  },
  uart: {
    protocol: 'uart',
    displayName: 'UART (TX/RX, asynchronous serial)',
    topology: 'Point-to-point, single driver/receiver per line',
    lengthMatchingGuidance: 'No length matching required (single-ended, asynchronous)',
    maxRecommendedLengthNotes:
      'Keep runs short relative to baud rate; higher baud rates are more sensitive to noise',
    notes: [
      'No formal impedance/termination requirement for on-board UART traces',
      'For longer runs or high baud rates, consider a differential transceiver (e.g. RS-232/RS-485) instead',
    ],
    source:
      'General serial-communication practice (no single governing standard for on-board UART)',
    caveat: GENERIC_CAVEAT,
  },
  'ethernet-10-100': {
    protocol: 'ethernet-10-100',
    displayName: '10BASE-T / 100BASE-TX Ethernet (2 differential pairs)',
    topology:
      'Point-to-point differential pairs through magnetics to an RJ45 or integrated connector',
    differentialImpedanceOhms: 100,
    lengthMatchingGuidance: 'Match intra-pair lengths within about 50 mils (~1.27mm)',
    notes: [
      'Keep pairs away from each other and from noisy digital/switching signals to control crosstalk',
      'Magnetics (isolation transformer) are required between the PHY and the connector',
      'Maintain consistent differential trace spacing/impedance along the full pair length',
    ],
    source: 'IEEE 802.3 — general differential-pair and magnetics guidance',
    caveat: GENERIC_CAVEAT,
  },
  'ethernet-1000': {
    protocol: 'ethernet-1000',
    displayName: '1000BASE-T Gigabit Ethernet (4 differential pairs)',
    topology:
      'Point-to-point differential pairs (all 4 pairs used bidirectionally) through magnetics',
    differentialImpedanceOhms: 100,
    lengthMatchingGuidance:
      'Match intra-pair lengths within about 50 mils (~1.27mm); also keep inter-pair skew ' +
      'across all 4 pairs tight since 1000BASE-T uses all pairs simultaneously',
    notes: [
      'All four pairs are active simultaneously — inter-pair length/skew matters more than for 10/100BASE-T',
      'Magnetics (isolation transformer) are required between the PHY and the connector',
      'Keep pairs away from each other and from noisy digital/switching signals to control crosstalk',
    ],
    source: 'IEEE 802.3ab — general differential-pair and magnetics guidance',
    caveat: GENERIC_CAVEAT,
  },
};

export function lookupProtocolRouting(protocol: ProtocolKey): ProtocolRoutingGuidance {
  const entry = CATALOG[protocol];
  if (!entry) throw new Error(`Unknown protocol: ${String(protocol)}`);
  return entry;
}

export function listProtocolRoutingKeys(): ProtocolKey[] {
  return Object.keys(CATALOG) as ProtocolKey[];
}
