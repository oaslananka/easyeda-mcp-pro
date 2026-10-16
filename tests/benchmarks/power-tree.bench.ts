import { bench, describe } from 'vitest';

import { analyzePowerTree, type PowerTreeInput } from '../../src/power-tree/index.js';

const mcuBoard: PowerTreeInput = {
  projectId: 'mcu-board',
  rails: [
    { id: 'vin', name: 'VIN_USB', voltage: 5, external: true, requiresProtection: true },
    { id: '3v3', name: '3V3', voltage: 3.3, requiresBulkCapacitance: true },
  ],
  sources: [
    {
      id: 'usb-c',
      kind: 'usb',
      railId: 'vin',
      voltage: 5,
      maxCurrentA: 3,
      requiresProtection: true,
    },
  ],
  protections: [{ id: 'f1', ref: 'F1', kind: 'polyfuse', railId: 'vin', currentRatingA: 1.5 }],
  regulators: [
    {
      id: 'u1',
      ref: 'U1',
      kind: 'buck',
      inputRailId: 'vin',
      outputRailId: '3v3',
      maxOutputCurrentA: 1.2,
      efficiency: 0.9,
      thermalResistanceCPerW: 55,
      maxJunctionTempC: 125,
    },
  ],
  loads: [
    { id: 'mcu', ref: 'U2', railId: '3v3', currentA: 0.12, peakCurrentA: 0.22 },
    { id: 'radio', ref: 'U3', railId: '3v3', currentA: 0.08, peakCurrentA: 0.18 },
  ],
  capacitors: [
    { id: 'cin', ref: 'C1', railId: 'vin', role: 'bulk', capacitanceUf: 22, voltageRating: 10 },
    { id: 'cout', ref: 'C2', railId: '3v3', role: 'bulk', capacitanceUf: 47, voltageRating: 6.3 },
  ],
};

/** A wide power tree: one 12 V input feeding `railCount` LDO-regulated rails. */
function widePowerTree(railCount: number): PowerTreeInput {
  const input: Required<
    Pick<PowerTreeInput, 'rails' | 'sources' | 'regulators' | 'loads' | 'capacitors'>
  > &
    PowerTreeInput = {
    projectId: 'wide-tree',
    rails: [{ id: 'vin', name: 'VIN_12V', voltage: 12, external: true }],
    sources: [{ id: 'dc-jack', kind: 'barrel-jack', railId: 'vin', voltage: 12, maxCurrentA: 10 }],
    regulators: [],
    loads: [],
    capacitors: [],
  };
  for (let i = 0; i < railCount; i += 1) {
    const railId = `rail-${i}`;
    input.rails.push({
      id: railId,
      name: `V${i}_3V3`,
      voltage: 3.3,
      requiresBulkCapacitance: true,
    });
    input.regulators.push({
      id: `reg-${i}`,
      ref: `U${100 + i}`,
      kind: 'ldo',
      inputRailId: 'vin',
      outputRailId: railId,
      maxOutputCurrentA: 0.5,
      thermalResistanceCPerW: 60,
      maxJunctionTempC: 125,
    });
    for (let l = 0; l < 4; l += 1) {
      input.loads.push({
        id: `load-${i}-${l}`,
        ref: `U${1000 + i * 4 + l}`,
        railId,
        currentA: 0.05,
        peakCurrentA: 0.09,
      });
    }
    input.capacitors.push({
      id: `cap-${i}`,
      ref: `C${100 + i}`,
      railId,
      role: 'bulk',
      capacitanceUf: 10,
      voltageRating: 6.3,
    });
  }
  return input;
}

const wideTree = widePowerTree(50);

describe('power tree analysis', () => {
  bench('analyzePowerTree - USB buck MCU board', () => {
    analyzePowerTree(mcuBoard);
  });

  bench('analyzePowerTree - 50 LDO rails / 200 loads', () => {
    analyzePowerTree(wideTree);
  });
});
