import { describe, expect, it } from 'vitest';
import {
  lookupProtocolRouting,
  listProtocolRoutingKeys,
  type ProtocolKey,
} from '../../../src/design-rules/protocol-routing.js';

describe('lookupProtocolRouting', () => {
  it('returns guidance for every listed protocol key', () => {
    for (const key of listProtocolRoutingKeys()) {
      const guidance = lookupProtocolRouting(key);
      expect(guidance.protocol).toBe(key);
      expect(guidance.displayName.length).toBeGreaterThan(0);
      expect(guidance.topology.length).toBeGreaterThan(0);
      expect(guidance.lengthMatchingGuidance.length).toBeGreaterThan(0);
      expect(guidance.notes.length).toBeGreaterThan(0);
      expect(guidance.source.length).toBeGreaterThan(0);
      expect(guidance.caveat).toMatch(/Generic reference guidance/);
    }
  });

  it('lists the expected protocol keys', () => {
    const keys = listProtocolRoutingKeys();
    expect(keys).toEqual(
      expect.arrayContaining([
        'usb2',
        'usb3',
        'rs485',
        'i2c',
        'spi',
        'uart',
        'ethernet-10-100',
        'ethernet-1000',
      ]),
    );
  });

  it('gives differential pairs a differential impedance and single-ended buses none', () => {
    expect(lookupProtocolRouting('usb2').differentialImpedanceOhms).toBe(90);
    expect(lookupProtocolRouting('usb3').differentialImpedanceOhms).toBe(90);
    expect(lookupProtocolRouting('rs485').differentialImpedanceOhms).toBe(120);
    expect(lookupProtocolRouting('ethernet-10-100').differentialImpedanceOhms).toBe(100);
    expect(lookupProtocolRouting('ethernet-1000').differentialImpedanceOhms).toBe(100);
    expect(lookupProtocolRouting('i2c').differentialImpedanceOhms).toBeUndefined();
    expect(lookupProtocolRouting('spi').differentialImpedanceOhms).toBeUndefined();
    expect(lookupProtocolRouting('uart').differentialImpedanceOhms).toBeUndefined();
  });

  it('gives I2C a pull-up resistance range', () => {
    const i2c = lookupProtocolRouting('i2c');
    expect(i2c.pullUpResistanceOhms).toBeDefined();
    expect(i2c.pullUpResistanceOhms!.min).toBeLessThan(i2c.pullUpResistanceOhms!.max);
  });

  it('gives RS-485 a 120 ohm termination', () => {
    const rs485 = lookupProtocolRouting('rs485');
    expect(rs485.terminationOhms).toBe(120);
  });

  it('rejects an unknown protocol key', () => {
    expect(() => lookupProtocolRouting('bogus' as ProtocolKey)).toThrow();
  });
});
