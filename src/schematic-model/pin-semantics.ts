import type { BasePinElectricalType, PinElectricalType, RawPinInput } from './geometry-model.js';

const PIN_TYPE_ALIASES: Readonly<Record<string, BasePinElectricalType>> = {
  input: 'input',
  in: 'input',
  output: 'output',
  out: 'output',
  bidirectional: 'bidirectional',
  bidir: 'bidirectional',
  io: 'bidirectional',
  passive: 'passive',
  powerinput: 'powerInput',
  powerin: 'powerInput',
  pwrin: 'powerInput',
  poweroutput: 'powerOutput',
  powerout: 'powerOutput',
  pwrout: 'powerOutput',
  powersource: 'powerOutput',
  opencollector: 'openCollector',
  opendrain: 'openCollector',
  openemitter: 'openEmitter',
  tristate: 'triState',
  three_state: 'triState',
  noconnect: 'noConnect',
  nc: 'noConnect',
  unspecified: 'unspecified',
  unknown: 'unspecified',
};

function normalizedTypeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function normalizePinElectricalType(rawType: string | null | undefined): {
  electricalType: PinElectricalType;
  baseElectricalType: BasePinElectricalType;
} {
  if (!rawType) {
    return { electricalType: 'unspecified', baseElectricalType: 'unspecified' };
  }
  const key = normalizedTypeKey(rawType);
  if (key === 'hidden') return { electricalType: 'hidden', baseElectricalType: 'unspecified' };
  if (key === 'stacked') return { electricalType: 'stacked', baseElectricalType: 'unspecified' };
  if (key === 'internal') return { electricalType: 'internal', baseElectricalType: 'unspecified' };
  const baseElectricalType = PIN_TYPE_ALIASES[key] ?? 'unspecified';
  return { electricalType: baseElectricalType, baseElectricalType };
}

export function pinSemanticFlags(raw: RawPinInput): {
  hidden: boolean;
  stacked: boolean;
  internallyConnected: boolean;
  deliberateNoConnect: boolean;
  noConnectAllowed: boolean;
  mechanicallyUnused: boolean;
} {
  const normalized = normalizePinElectricalType(raw.electricalType);
  return {
    hidden: raw.hidden === true || normalized.electricalType === 'hidden',
    stacked: raw.stacked === true || normalized.electricalType === 'stacked',
    internallyConnected:
      raw.internallyConnected === true || normalized.electricalType === 'internal',
    deliberateNoConnect:
      raw.deliberateNoConnect === true || normalized.baseElectricalType === 'noConnect',
    noConnectAllowed:
      raw.noConnectAllowed === true || normalized.baseElectricalType === 'noConnect',
    mechanicallyUnused: raw.mechanicallyUnused === true,
  };
}

export function isDriverType(type: BasePinElectricalType): boolean {
  return ['output', 'powerOutput', 'triState'].includes(type);
}

export function isOpenDriverType(type: BasePinElectricalType): boolean {
  return type === 'openCollector' || type === 'openEmitter';
}

export function isInputType(type: BasePinElectricalType): boolean {
  return type === 'input' || type === 'powerInput';
}

export function isPassiveType(type: BasePinElectricalType): boolean {
  return type === 'passive' || type === 'unspecified';
}
