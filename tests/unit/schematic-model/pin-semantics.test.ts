import { describe, expect, it } from 'vitest';
import {
  isDriverType,
  isInputType,
  isOpenDriverType,
  isPassiveType,
  normalizePinElectricalType,
  pinSemanticFlags,
} from '../../../src/schematic-model/pin-semantics.js';
import type { RawPinInput } from '../../../src/schematic-model/geometry-model.js';

function pin(overrides: Partial<RawPinInput> = {}): RawPinInput {
  return { number: '1', ...overrides };
}

describe('normalizePinElectricalType', () => {
  it('defaults to unspecified for null/undefined/empty input', () => {
    expect(normalizePinElectricalType(undefined)).toEqual({
      electricalType: 'unspecified',
      baseElectricalType: 'unspecified',
    });
    expect(normalizePinElectricalType(null)).toEqual({
      electricalType: 'unspecified',
      baseElectricalType: 'unspecified',
    });
    expect(normalizePinElectricalType('')).toEqual({
      electricalType: 'unspecified',
      baseElectricalType: 'unspecified',
    });
  });

  it.each([
    ['hidden', 'hidden', 'unspecified'],
    ['STACKED', 'stacked', 'unspecified'],
    [' internal ', 'internal', 'unspecified'],
  ] as const)('recognizes the meta type %s', (raw, electricalType, baseElectricalType) => {
    expect(normalizePinElectricalType(raw)).toEqual({ electricalType, baseElectricalType });
  });

  it.each([
    ['in', 'input'],
    ['Input', 'input'],
    ['out', 'output'],
    ['bidir', 'bidirectional'],
    ['io', 'bidirectional'],
    ['passive', 'passive'],
    ['power-in', 'powerInput'],
    ['pwr_in', 'powerInput'],
    ['power out', 'powerOutput'],
    ['pwrout', 'powerOutput'],
    ['powerSource', 'powerOutput'],
    ['open-collector', 'openCollector'],
    ['opendrain', 'openCollector'],
    ['open_emitter', 'openEmitter'],
    ['tri-state', 'triState'],
    ['no-connect', 'noConnect'],
    ['NC', 'noConnect'],
    ['unknown', 'unspecified'],
  ] as const)(
    'maps alias %s to base type %s, ignoring case/spacing/punctuation',
    (raw, expected) => {
      expect(normalizePinElectricalType(raw)).toEqual({
        electricalType: expected,
        baseElectricalType: expected,
      });
    },
  );

  it('falls back to unspecified for an unrecognized raw type', () => {
    expect(normalizePinElectricalType('totally-not-a-type')).toEqual({
      electricalType: 'unspecified',
      baseElectricalType: 'unspecified',
    });
  });
});

describe('pinSemanticFlags', () => {
  it('derives all flags as false for a plain passive pin', () => {
    expect(pinSemanticFlags(pin({ electricalType: 'passive' }))).toEqual({
      hidden: false,
      stacked: false,
      internallyConnected: false,
      deliberateNoConnect: false,
      noConnectAllowed: false,
      mechanicallyUnused: false,
    });
  });

  it('derives hidden/stacked/internal from the electrical type when the raw flag is absent', () => {
    expect(pinSemanticFlags(pin({ electricalType: 'hidden' })).hidden).toBe(true);
    expect(pinSemanticFlags(pin({ electricalType: 'stacked' })).stacked).toBe(true);
    expect(pinSemanticFlags(pin({ electricalType: 'internal' })).internallyConnected).toBe(true);
  });

  it('honors explicit raw boolean flags even when the electrical type disagrees', () => {
    const flags = pinSemanticFlags(
      pin({ electricalType: 'passive', hidden: true, stacked: true, internallyConnected: true }),
    );
    expect(flags.hidden).toBe(true);
    expect(flags.stacked).toBe(true);
    expect(flags.internallyConnected).toBe(true);
  });

  it('derives no-connect flags from a noConnect electrical type', () => {
    const flags = pinSemanticFlags(pin({ electricalType: 'nc' }));
    expect(flags.deliberateNoConnect).toBe(true);
    expect(flags.noConnectAllowed).toBe(true);
  });

  it('honors an explicit deliberateNoConnect/noConnectAllowed override', () => {
    const flags = pinSemanticFlags(
      pin({ electricalType: 'passive', deliberateNoConnect: true, noConnectAllowed: true }),
    );
    expect(flags.deliberateNoConnect).toBe(true);
    expect(flags.noConnectAllowed).toBe(true);
  });

  it('passes through mechanicallyUnused only from the raw flag', () => {
    expect(pinSemanticFlags(pin({ mechanicallyUnused: true })).mechanicallyUnused).toBe(true);
    expect(pinSemanticFlags(pin()).mechanicallyUnused).toBe(false);
  });
});

describe('type predicates', () => {
  it('isDriverType recognizes output-like types', () => {
    expect(isDriverType('output')).toBe(true);
    expect(isDriverType('powerOutput')).toBe(true);
    expect(isDriverType('triState')).toBe(true);
    expect(isDriverType('input')).toBe(false);
  });

  it('isOpenDriverType recognizes open-collector/open-emitter', () => {
    expect(isOpenDriverType('openCollector')).toBe(true);
    expect(isOpenDriverType('openEmitter')).toBe(true);
    expect(isOpenDriverType('output')).toBe(false);
  });

  it('isInputType recognizes input and power input', () => {
    expect(isInputType('input')).toBe(true);
    expect(isInputType('powerInput')).toBe(true);
    expect(isInputType('output')).toBe(false);
  });

  it('isPassiveType recognizes passive and unspecified', () => {
    expect(isPassiveType('passive')).toBe(true);
    expect(isPassiveType('unspecified')).toBe(true);
    expect(isPassiveType('input')).toBe(false);
  });
});
