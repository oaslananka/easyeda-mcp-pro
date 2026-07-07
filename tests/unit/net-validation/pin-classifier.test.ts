import { describe, it, expect } from 'vitest';
import {
  classifyNetType,
  classifyPinElectricalType,
} from '../../../src/net-validation/pin-classifier.js';

describe('classifyNetType', () => {
  it('classifies power rail names', () => {
    expect(classifyNetType('3V3')).toBe('power');
    expect(classifyNetType('VCC')).toBe('power');
    expect(classifyNetType('VIN')).toBe('power');
  });

  it('classifies ground names', () => {
    expect(classifyNetType('GND')).toBe('ground');
    expect(classifyNetType('AGND')).toBe('ground');
  });

  it('falls back to signal for unrecognized names', () => {
    expect(classifyNetType('I2C_SDA')).toBe('signal');
    expect(classifyNetType('')).toBe('signal');
  });
});

describe('classifyPinElectricalType', () => {
  it('classifies power/ground pin names ahead of loose IN/OUT substrings', () => {
    // Live-verified footgun: "VIN"/"VOUT" contain "IN"/"OUT" as substrings —
    // must resolve to power, not input/output, or every regulator looks floating.
    expect(classifyPinElectricalType('VIN', undefined)).toBe('power_input');
    expect(classifyPinElectricalType('VOUT', undefined)).toBe('power_output');
    expect(classifyPinElectricalType('GND', undefined)).toBe('power_input');
    expect(classifyPinElectricalType('VCC', undefined)).toBe('power_input');
  });

  it('classifies output/input pins from real op-amp pin names', () => {
    // Live-verified against LM358DR2G's actual symbol pin names.
    expect(classifyPinElectricalType('1OUT', undefined)).toBe('output');
    expect(classifyPinElectricalType('1IN-', undefined)).toBe('input');
    expect(classifyPinElectricalType('1IN+', undefined)).toBe('input');
  });

  it('classifies no-connect and bidirectional hints', () => {
    expect(classifyPinElectricalType('NC', undefined)).toBe('no_connect');
    expect(classifyPinElectricalType('SDA', undefined)).toBe('bidirectional');
  });

  it('falls back to native pinType only when the name gives no signal', () => {
    expect(classifyPinElectricalType('1', 'IN')).toBe('input');
    expect(classifyPinElectricalType('1', 'OUT')).toBe('output');
  });

  it('does not trust native pinType over a name-derived classification', () => {
    // Live-verified: a plain resistor's pins report native pinType "IN" —
    // nonsensical for a passive part. A numeric pin name gives no signal, so
    // this case does fall back to native; the point is the name check runs
    // FIRST and wins whenever it has an opinion (see the VIN/VOUT case above).
    expect(classifyPinElectricalType('OUT', 'IN')).toBe('output');
  });

  it('returns undefined for an unclassifiable pin with unreliable native data', () => {
    // Live-verified: a real op-amp's pins report native pinType "Undefined".
    expect(classifyPinElectricalType('1', 'Undefined')).toBeUndefined();
    expect(classifyPinElectricalType('', undefined)).toBeUndefined();
  });
});
