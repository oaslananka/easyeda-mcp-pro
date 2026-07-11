import { describe, expect, it } from 'vitest';
import {
  classifyCanonicalNetName,
  normalizeNetName,
} from '../../../src/schematic-model/net-names.js';

describe('normalizeNetName', () => {
  it.each([
    ['SYMBOLS_GND', 'GND', 'ground'],
    ['symbols_+3v3', '+3V3', 'power'],
    ['SYMBOLS_VBUS', 'VBUS', 'power'],
    ['SYMBOLS_VDRIVE', 'VDRIVE', 'power'],
    ['SYMBOLS_PWR_FLAG', 'PWR_FLAG', 'power-flag'],
    ['Ground-GND', 'GND', 'ground'],
    ['Power-5V', '+5V', 'power'],
  ] as const)('normalizes recognized imported power alias %s', (raw, canonical, kind) => {
    const result = normalizeNetName(raw);
    expect(result.canonicalNetName).toBe(canonical);
    expect(result.kind).toBe(kind);
    expect(result.changed).toBe(true);
  });

  it('preserves arbitrary user signal names', () => {
    const result = normalizeNetName('SYMBOLS_CUSTOM_DATA');
    expect(result.canonicalNetName).toBe('SYMBOLS_CUSTOM_DATA');
    expect(result.kind).toBe('signal');
    expect(result.changed).toBe(false);
  });

  it('decodes the imported slash token without changing signal meaning', () => {
    const result = normalizeNetName('SPI0.CS{SLASH}UART1.RX');
    expect(result.canonicalNetName).toBe('SPI0.CS/UART1.RX');
    expect(result.rules).toContain('decode-import-slash-token');
    expect(result.kind).toBe('signal');
  });

  it('turns an empty name into an explicit unnamed net', () => {
    expect(normalizeNetName('').canonicalNetName).toBe('UNNAMED');
    expect(normalizeNetName('').kind).toBe('unnamed');
  });
});

describe('classifyCanonicalNetName', () => {
  it('classifies ground, power and signal names', () => {
    expect(classifyCanonicalNetName('GND')).toBe('ground');
    expect(classifyCanonicalNetName('+1V1')).toBe('power');
    expect(classifyCanonicalNetName('VBUS')).toBe('power');
    expect(classifyCanonicalNetName('QSPI_SS')).toBe('signal');
  });
});
