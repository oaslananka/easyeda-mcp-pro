import { bench, describe } from 'vitest';

import { validateNets } from '../../src/net-validation/validation.js';
import { VALID_INPUT } from '../../src/net-validation/fixtures.js';
import type {
  DeviceValidationEntry,
  NetValidationEntry,
  NetValidationInput,
} from '../../src/net-validation/schema.js';

const SIGNAL_PREFIXES = ['I2C_SDA', 'SPI_MOSI', 'UART_TX', 'ADC_SENSE', 'MCU_CLK', 'LED_EN'];

/** Builds a synthetic design with `deviceCount` MCU-like devices sharing power rails. */
function syntheticDesign(deviceCount: number): NetValidationInput {
  const devices: DeviceValidationEntry[] = [];
  const nets: NetValidationEntry[] = [
    { id: 'n-vin', name: 'VIN', type: 'power', voltage: 5, nodes: [] },
    { id: 'n-3v3', name: '3V3', type: 'power', voltage: 3.3, nodes: [] },
    { id: 'n-gnd', name: 'GND', type: 'ground', nodes: [] },
  ];
  const [vin, v3v3, gnd] = nets as [NetValidationEntry, NetValidationEntry, NetValidationEntry];
  vin.nodes.push({ deviceRef: 'J1', pin: '1', electricalType: 'power_source' });
  gnd.nodes.push({ deviceRef: 'J1', pin: '2', electricalType: 'passive' });

  for (let i = 0; i < deviceCount; i += 1) {
    const ref = `U${i + 1}`;
    devices.push({
      id: `dev-${i}`,
      ref,
      category: 'mcu',
      requiresDecoupling: true,
      pins: [
        { pin: '1', name: 'VDD', electricalType: 'power_input', required: true },
        { pin: '2', name: 'GND', electricalType: 'power_input', required: true },
        ...SIGNAL_PREFIXES.map((_, idx) => ({
          pin: String(idx + 3),
          electricalType: 'bidirectional' as const,
        })),
      ],
    });
    v3v3.nodes.push({ deviceRef: ref, pin: '1', electricalType: 'power_input' });
    gnd.nodes.push({ deviceRef: ref, pin: '2', electricalType: 'power_input' });
    SIGNAL_PREFIXES.forEach((prefix, idx) => {
      nets.push({
        id: `n-${ref}-${prefix}`,
        name: `${prefix}_${i}`,
        type: 'signal',
        nodes: [
          { deviceRef: ref, pin: String(idx + 3), electricalType: 'bidirectional' },
          { deviceRef: `R${i * SIGNAL_PREFIXES.length + idx + 1}`, pin: '1' },
        ],
      });
    });
  }
  return { nets, devices };
}

const medium = syntheticDesign(25);
const large = syntheticDesign(100);

describe('net validation', () => {
  bench('validateNets - reference fixture', () => {
    validateNets(VALID_INPUT);
  });

  bench('validateNets - 25 devices / 150 signal nets', () => {
    validateNets(medium);
  });

  bench('validateNets - 100 devices / 600 signal nets', () => {
    validateNets(large);
  });
});
