/**
 * Optional source-declared electrical observations against explicit netlist
 * pin topology. This does NOT verify the datasheet itself or infer net voltage
 * from names. Native ERC and the power-tree analyzer remain authoritative for
 * their separate validated scope.
 */
import type { NetValidationEntry, DeviceValidationEntry } from './schema.js';

export interface DatasheetReference {
  partNumber: string;
  package: string;
  revision: string;
  source: string;
  section: string;
}

export type DatasheetConstraint =
  | {
      kind: 'pin_voltage';
      componentRef: string;
      pin: string;
      reference: DatasheetReference;
      expectedNet?: string;
      minVoltageV?: number;
      maxVoltageV?: number;
    }
  | {
      kind: 'io_domain_voltage';
      componentRef: string;
      pin: string;
      supplyPin: string;
      /** Caller-declared maximum I/O voltage above its explicitly stated supply. */
      maxAboveSupplyV: number;
      reference: DatasheetReference;
    }
  | {
      kind: 'intentional_nc';
      componentRef: string;
      pin: string;
      reference: DatasheetReference;
    }
  | {
      kind: 'required_support';
      componentRef: string;
      pin: string;
      supportRef: string;
      /** Exact declared support pin; missing means connectivity is unverified. */
      supportPin?: string;
      function: 'pull' | 'decoupling' | 'reset_boot' | 'esd' | 'protection';
      reference: DatasheetReference;
    }
  | {
      kind: 'regulator_headroom';
      componentRef: string;
      inputPin: string;
      outputPin: string;
      minHeadroomV: number;
      reference: DatasheetReference;
    };

type Observation = 'WARNING' | 'UNKNOWN';

export interface DatasheetFinding {
  id: string;
  kind: DatasheetConstraint['kind'];
  status: Observation;
  component_ref: string;
  related_component_ref?: string;
  related_pin?: string;
  pins: string[];
  nets: string[];
  observed_voltages_v: Array<{ net: string; voltage_v: number }>;
  source: DatasheetReference;
  message: string;
  evidence: 'explicit_netlist' | 'incomplete_or_ambiguous';
}

export interface DatasheetReview {
  status: Observation;
  source_authenticity: 'CALLER_DECLARED_UNVERIFIED';
  netlist_scope: 'CALLER_SUPPLIED_NOT_LIVE_VERIFIED';
  finding_count: number;
  findings: DatasheetFinding[];
  limitations: string[];
  engineering_sign_off: false;
}

type PinLookup =
  | { status: 'CONNECTED'; net: NetValidationEntry }
  | { status: 'UNCONNECTED' }
  | { status: 'UNKNOWN' };

function uniqueExactIdentities(values: string[]): boolean {
  return (
    values.every(
      (value) => typeof value === 'string' && value.length > 0 && value.trim() === value,
    ) && new Set(values).size === values.length
  );
}

function sourceIdentityUnambiguous(
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): boolean {
  return (
    devices !== undefined &&
    uniqueExactIdentities(nets.map((net) => net.id)) &&
    uniqueExactIdentities(nets.map((net) => net.name)) &&
    uniqueExactIdentities(devices.map((device) => device.id)) &&
    uniqueExactIdentities(devices.map((device) => device.ref))
  );
}

function findPinNet(
  componentRef: string,
  pin: string,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): PinLookup {
  if (!sourceIdentityUnambiguous(nets, devices)) return { status: 'UNKNOWN' };
  const matchedDevices = devices?.filter((device) => device.ref === componentRef);
  if (
    matchedDevices?.length !== 1 ||
    matchedDevices[0]?.pins?.filter((p) => p.pin === pin).length !== 1
  )
    return { status: 'UNKNOWN' };
  const matched = nets.filter((net) =>
    net.nodes.some((node) => node.deviceRef === componentRef && node.pin === pin),
  );
  if (matched.length > 1) return { status: 'UNKNOWN' };
  const one = matched[0];
  if (!one) return { status: 'UNCONNECTED' };
  // A single matching record is not unique when another net reuses
  // its ID/name or the record itself repeats the pin node.
  if (
    one.nodes.filter((node) => node.deviceRef === componentRef && node.pin === pin).length !== 1 ||
    nets.some((net) => net !== one && (net.id === one.id || net.name === one.name))
  ) {
    return { status: 'UNKNOWN' };
  }
  return { status: 'CONNECTED', net: one };
}

function finding(
  index: number,
  constraint: DatasheetConstraint,
  status: Observation,
  message: string,
  pins: string[],
  nets: string[],
  observed_voltages_v: DatasheetFinding['observed_voltages_v'] = [],
  evidence: DatasheetFinding['evidence'] = 'incomplete_or_ambiguous',
): DatasheetFinding {
  return {
    id: 'datasheet:' + index + ':' + constraint.kind + ':' + constraint.componentRef,
    kind: constraint.kind,
    status,
    component_ref: constraint.componentRef,
    pins,
    nets,
    observed_voltages_v,
    source: constraint.reference,
    message,
    evidence,
  };
}

function voltageObservation(pin: PinLookup): DatasheetFinding['observed_voltages_v'] {
  return pin.status === 'CONNECTED' &&
    typeof pin.net.voltage === 'number' &&
    Number.isFinite(pin.net.voltage)
    ? [{ net: pin.net.name, voltage_v: pin.net.voltage }]
    : [];
}

function invalidPinVoltageBounds(
  constraint: Extract<DatasheetConstraint, { kind: 'pin_voltage' }>,
): boolean {
  const { minVoltageV, maxVoltageV } = constraint;
  return (
    (minVoltageV !== undefined && !Number.isFinite(minVoltageV)) ||
    (maxVoltageV !== undefined && !Number.isFinite(maxVoltageV)) ||
    (minVoltageV !== undefined && maxVoltageV !== undefined && minVoltageV > maxVoltageV)
  );
}

function pinVoltageConstraintIssue(
  c: Extract<DatasheetConstraint, { kind: 'pin_voltage' }>,
  index: number,
  names: string[],
  measured: DatasheetFinding['observed_voltages_v'],
): DatasheetFinding | undefined {
  if (invalidPinVoltageBounds(c)) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'Caller-declared pin-voltage limits are invalid or contradictory; no range comparison is possible.',
      [c.pin],
      names,
      measured,
      'explicit_netlist',
    );
  }
  if (c.minVoltageV === undefined && c.maxVoltageV === undefined) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'No numeric caller-declared pin-voltage limit is available for comparison.',
      [c.pin],
      names,
      measured,
      'explicit_netlist',
    );
  }
  return undefined;
}

function reviewPinVoltage(
  c: Extract<DatasheetConstraint, { kind: 'pin_voltage' }>,
  index: number,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): DatasheetFinding {
  const pin = findPinNet(c.componentRef, c.pin, nets, devices);
  const names = pin.status === 'CONNECTED' ? [pin.net.name] : [];
  const measured = voltageObservation(pin);
  if (pin.status !== 'CONNECTED') {
    return finding(
      index,
      c,
      'UNKNOWN',
      'Exact component/pin connection is not uniquely observed in the declared netlist.',
      [c.pin],
      names,
    );
  }
  if (c.expectedNet !== undefined && pin.net.name !== c.expectedNet) {
    return finding(
      index,
      c,
      'WARNING',
      'Observed connected net differs from the explicitly declared pin-net requirement.',
      [c.pin],
      names,
      measured,
      'explicit_netlist',
    );
  }
  if (!measured.length) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'Net has no explicitly declared numeric voltage; its name is not a verified voltage source.',
      [c.pin],
      names,
    );
  }
  const invalidConstraint = pinVoltageConstraintIssue(c, index, names, measured);
  if (invalidConstraint) return invalidConstraint;
  const value = measured[0]?.voltage_v;
  if (value === undefined) throw new Error('Unreachable: numeric voltage was not observed');
  const violated =
    (c.minVoltageV !== undefined && value < c.minVoltageV) ||
    (c.maxVoltageV !== undefined && value > c.maxVoltageV);
  return finding(
    index,
    c,
    violated ? 'WARNING' : 'UNKNOWN',
    violated
      ? 'Declared net voltage exceeds the caller-supplied limit for this exact component pin.'
      : 'Declared net voltage is inside the caller-supplied pin limit; actual rail tolerance and datasheet authenticity remain unverified.',
    [c.pin],
    names,
    measured,
    'explicit_netlist',
  );
}

function invalidIoDomainComparison(
  constraint: Extract<DatasheetConstraint, { kind: 'io_domain_voltage' }>,
  differenceV: number,
): boolean {
  return (
    constraint.pin === constraint.supplyPin ||
    !Number.isFinite(constraint.maxAboveSupplyV) ||
    constraint.maxAboveSupplyV < 0 ||
    !Number.isFinite(differenceV)
  );
}

function reviewIoDomainVoltage(
  c: Extract<DatasheetConstraint, { kind: 'io_domain_voltage' }>,
  index: number,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): DatasheetFinding {
  const io = findPinNet(c.componentRef, c.pin, nets, devices);
  const supply = findPinNet(c.componentRef, c.supplyPin, nets, devices);
  const observed = [...voltageObservation(io), ...voltageObservation(supply)];
  const names = [
    ...(io.status === 'CONNECTED' ? [io.net.name] : []),
    ...(supply.status === 'CONNECTED' ? [supply.net.name] : []),
  ];
  const pins = [c.pin, c.supplyPin];
  if (io.status !== 'CONNECTED' || supply.status !== 'CONNECTED' || observed.length !== 2) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'Unique I/O and supply pin connections with two explicitly declared numeric net voltages are required.',
      pins,
      names,
      observed,
    );
  }
  const ioVoltage = observed[0]?.voltage_v;
  const supplyVoltage = observed[1]?.voltage_v;
  const difference = (ioVoltage ?? Number.NaN) - (supplyVoltage ?? Number.NaN);
  if (invalidIoDomainComparison(c, difference)) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'The I/O supply pin identity, declared allowance or voltage difference is invalid.',
      pins,
      names,
      observed,
      'explicit_netlist',
    );
  }
  // 1e-12 V only compensates floating-point rounding, not electrical tolerance.
  const violated = difference > c.maxAboveSupplyV + 1e-12;
  return finding(
    index,
    c,
    violated ? 'WARNING' : 'UNKNOWN',
    violated
      ? 'Caller-declared I/O voltage exceeds the source-declared supply-relative upper bound.'
      : 'Declared I/O voltage is within the supply-relative upper bound; logic levels, negative limits, rail tolerance and physical behavior remain unverified.',
    pins,
    names,
    observed,
    'explicit_netlist',
  );
}

function reviewNoConnect(
  c: Extract<DatasheetConstraint, { kind: 'intentional_nc' }>,
  index: number,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): DatasheetFinding {
  const pin = findPinNet(c.componentRef, c.pin, nets, devices);
  if (pin.status === 'CONNECTED') {
    return finding(
      index,
      c,
      'WARNING',
      'Explicitly declared intentional NC is connected in the supplied netlist.',
      [c.pin],
      [pin.net.name],
      voltageObservation(pin),
      'explicit_netlist',
    );
  }
  return finding(
    index,
    c,
    'UNKNOWN',
    pin.status === 'UNCONNECTED'
      ? 'No net connection observed; native no-connect marker and exact datasheet intent are not independently verified.'
      : 'Exact pin inventory is unavailable; no-connect cannot be established.',
    [c.pin],
    [],
  );
}

function supportMessage(
  mismatched: boolean,
  target: PinLookup,
  support: PinLookup | undefined,
  supportPresent: boolean | undefined,
): string {
  if (mismatched)
    return 'Declared support pin and target pin connect to different nets in the caller-supplied netlist.';
  if (support === undefined)
    return supportPresent
      ? 'Named support component is declared, but its electrical connection, value, location and function are unverified.'
      : 'Named required support component is absent from the supplied device inventory; completeness and live absence are unverified.';
  return target.status === 'CONNECTED' && support.status === 'CONNECTED'
    ? 'Both explicitly named pins share a declared net; component function, support value, other terminal, location and physical adequacy remain unverified.'
    : 'One or both exact pin connections are missing or ambiguous; support topology cannot be established.';
}

function findSupportPin(
  c: Extract<DatasheetConstraint, { kind: 'required_support' }>,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): PinLookup | undefined {
  return c.supportPin === undefined
    ? undefined
    : findPinNet(c.supportRef, c.supportPin, nets, devices);
}

function unverifiedSelfSupport(
  c: Extract<DatasheetConstraint, { kind: 'required_support' }>,
  index: number,
): DatasheetFinding {
  return {
    ...finding(
      index,
      c,
      'UNKNOWN',
      'The same component cannot independently evidence its own declared external support; select a distinct support part.',
      [c.pin],
      [],
    ),
    related_component_ref: c.supportRef,
    ...(c.supportPin === undefined ? {} : { related_pin: c.supportPin }),
  };
}

function reviewSupport(
  c: Extract<DatasheetConstraint, { kind: 'required_support' }>,
  index: number,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): DatasheetFinding {
  if (c.componentRef === c.supportRef) return unverifiedSelfSupport(c, index);
  const target = findPinNet(c.componentRef, c.pin, nets, devices);
  const support = findSupportPin(c, nets, devices);
  const names = [
    ...(target.status === 'CONNECTED' ? [target.net.name] : []),
    ...(support?.status === 'CONNECTED' ? [support.net.name] : []),
  ];
  const distinctNets = [...new Set(names)];
  const mismatched =
    target.status === 'CONNECTED' &&
    support?.status === 'CONNECTED' &&
    (target.net.id !== support.net.id || target.net.name !== support.net.name);
  const supportPresent = devices?.some((device) => device.ref === c.supportRef);
  const message = supportMessage(mismatched, target, support, supportPresent);
  return {
    ...finding(
      index,
      c,
      mismatched ? 'WARNING' : 'UNKNOWN',
      message,
      [c.pin],
      distinctNets,
      voltageObservation(target),
      target.status === 'CONNECTED' && support?.status === 'CONNECTED'
        ? 'explicit_netlist'
        : 'incomplete_or_ambiguous',
    ),
    related_component_ref: c.supportRef,
    ...(c.supportPin === undefined ? {} : { related_pin: c.supportPin }),
  };
}

function reviewHeadroom(
  c: Extract<DatasheetConstraint, { kind: 'regulator_headroom' }>,
  index: number,
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): DatasheetFinding {
  const input = findPinNet(c.componentRef, c.inputPin, nets, devices);
  const output = findPinNet(c.componentRef, c.outputPin, nets, devices);
  const observed = [...voltageObservation(input), ...voltageObservation(output)];
  const names = [
    ...(input.status === 'CONNECTED' ? [input.net.name] : []),
    ...(output.status === 'CONNECTED' ? [output.net.name] : []),
  ];
  if (input.status !== 'CONNECTED' || output.status !== 'CONNECTED' || observed.length !== 2) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'Exact input/output pin net connectivity and two explicit numeric voltages are required.',
      [c.inputPin, c.outputPin],
      names,
      observed,
    );
  }
  const inputVoltage = observed[0]?.voltage_v;
  const outputVoltage = observed[1]?.voltage_v;
  if (inputVoltage === undefined || outputVoltage === undefined) {
    throw new Error('Unreachable: declared input/output voltages were not observed');
  }
  const margin = inputVoltage - outputVoltage;
  if (!Number.isFinite(c.minHeadroomV) || c.minHeadroomV < 0 || !Number.isFinite(margin)) {
    return finding(
      index,
      c,
      'UNKNOWN',
      'Caller-declared minimum headroom or computed voltage margin is invalid; no comparison is possible.',
      [c.inputPin, c.outputPin],
      names,
      observed,
      'explicit_netlist',
    );
  }
  // Numerical subtraction of caller-declared rails has finite binary rounding error;
  // 1e-12 V is not a regulator dropout or electrical design margin.
  const violated = margin < c.minHeadroomV - 1e-12;
  return finding(
    index,
    c,
    violated ? 'WARNING' : 'UNKNOWN',
    violated
      ? 'Declared regulator input-output voltage margin is below the specified minimum.'
      : 'Declared input-output voltage margin meets the caller-supplied minimum; load, dropout variation and physical validity remain unverified.',
    [c.inputPin, c.outputPin],
    names,
    observed,
    'explicit_netlist',
  );
}

export function reviewDatasheetConstraints(
  constraints: DatasheetConstraint[],
  nets: NetValidationEntry[],
  devices: DeviceValidationEntry[] | undefined,
): DatasheetReview {
  const findings = constraints.map((constraint, index) => {
    switch (constraint.kind) {
      case 'pin_voltage':
        return reviewPinVoltage(constraint, index, nets, devices);
      case 'io_domain_voltage':
        return reviewIoDomainVoltage(constraint, index, nets, devices);
      case 'intentional_nc':
        return reviewNoConnect(constraint, index, nets, devices);
      case 'required_support':
        return reviewSupport(constraint, index, nets, devices);
      case 'regulator_headroom':
        return reviewHeadroom(constraint, index, nets, devices);
    }
  });
  return {
    status: findings.some((f) => f.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    source_authenticity: 'CALLER_DECLARED_UNVERIFIED',
    netlist_scope: 'CALLER_SUPPLIED_NOT_LIVE_VERIFIED',
    finding_count: findings.length,
    findings,
    limitations: [
      'This tool does not authenticate or retrieve the exact component datasheet, package or revision; citation details are supplied by the caller.',
      'Net voltages must be explicitly numeric input properties; guessed voltage from names is rejected for datasheet limits.',
      'Caller-supplied device and pin inventories are not proven complete, so absent support parts and intentional no-connect remain UNKNOWN.',
      'No native ERC run, power-tree current budget, real pin-to-net readback, rail tolerance, regulator load/temperature, protection topology or pad placement is claimed.',
      'A clean semantic ERC and an observed in-range sample do not establish datasheet, manufacturing or circuit compliance.',
    ],
    engineering_sign_off: false,
  };
}
