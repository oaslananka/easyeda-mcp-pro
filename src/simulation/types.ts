/**
 * Offline SPICE circuit verification — typed circuit description.
 *
 * There is deliberately no "raw SPICE deck" input anywhere in this module or the tools
 * built on it. ngspice's interactive `.control` block supports a `shell` command that
 * runs arbitrary OS commands — accepting free-form deck text from a tool caller would be
 * equivalent to unsandboxed code execution. Every deck this module produces is built from
 * typed, validated component data by `buildSpiceDeck()`; net/ref names are restricted to
 * a safe identifier pattern before being embedded in deck text.
 *
 * @module
 */

export type SimComponentKind =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'dc-voltage-source'
  | 'pulse-voltage-source'
  | 'dc-current-source'
  | 'pulse-current-source'
  | 'ldo-behavioral';

export interface SimComponentBase {
  ref: string;
  kind: SimComponentKind;
  /** Net names this component connects, in device-specific order (see each kind below). */
  nodes: string[];
}

/** resistor(nodes: [a, b]), capacitor(nodes: [a, b]), inductor(nodes: [a, b]) */
export interface PassiveComponent extends SimComponentBase {
  kind: 'resistor' | 'capacitor' | 'inductor';
  value: number;
  /** Initial condition (capacitor voltage / inductor current) for transient analysis. */
  initialCondition?: number;
}

/** A generic silicon diode or LED, referencing a named model in `src/simulation/models.ts`. */
export interface DiodeComponent extends SimComponentBase {
  kind: 'diode' | 'led';
  /** nodes: [anode, cathode] */
  modelName: string;
}

/** dc-voltage-source(nodes: [+, -]) */
export interface DcVoltageSource extends SimComponentBase {
  kind: 'dc-voltage-source';
  voltage: number;
}

/** pulse-voltage-source(nodes: [+, -]) — a step from initial to pulsed voltage. */
export interface PulseVoltageSource extends SimComponentBase {
  kind: 'pulse-voltage-source';
  initialVoltage: number;
  pulsedVoltage: number;
  delaySeconds: number;
  riseSeconds: number;
  fallSeconds: number;
  pulseWidthSeconds: number;
  periodSeconds: number;
}

/** dc-current-source(nodes: [+, -]) — current flows from + to - through the source. */
export interface DcCurrentSource extends SimComponentBase {
  kind: 'dc-current-source';
  current: number;
}

/** pulse-current-source(nodes: [+, -]) — a step-load model for transient analysis. */
export interface PulseCurrentSource extends SimComponentBase {
  kind: 'pulse-current-source';
  initialCurrent: number;
  pulsedCurrent: number;
  delaySeconds: number;
  riseSeconds: number;
  fallSeconds: number;
  pulseWidthSeconds: number;
  periodSeconds: number;
}

/**
 * A deliberately simplified linear regulator model — NOT a manufacturer-verified
 * behavioral model. Output tracks `targetVoltage` while `inputNode` exceeds
 * `targetVoltage + dropoutVoltage`; below that it degrades to input-minus-dropout
 * (a crude dropout approximation), then subtracts `outputResistanceOhms * current`
 * for load regulation. No thermal, noise, transient-response, or protection behavior
 * is modeled — see `docs/simulation.md`.
 */
export interface LdoBehavioralComponent extends SimComponentBase {
  kind: 'ldo-behavioral';
  /** nodes: [inputNode, outputNode, groundNode] */
  targetVoltage: number;
  dropoutVoltage: number;
  outputResistanceOhms: number;
}

export type SimComponent =
  | PassiveComponent
  | DiodeComponent
  | DcVoltageSource
  | PulseVoltageSource
  | DcCurrentSource
  | PulseCurrentSource
  | LdoBehavioralComponent;

export interface SimCircuit {
  title: string;
  groundNode: string;
  components: SimComponent[];
}

export interface OperatingPointAnalysis {
  kind: 'operating-point';
}

export interface TransientAnalysis {
  kind: 'transient';
  stopTimeSeconds: number;
  stepSeconds: number;
}

export type SimAnalysis = OperatingPointAnalysis | TransientAnalysis;

export interface NgspiceAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

export interface OperatingPointResult {
  nodeVoltages: Record<string, number>;
}

export interface TransientSample {
  timeSeconds: number;
  nodeVoltages: Record<string, number>;
}

export interface TransientResult {
  samples: TransientSample[];
}

export interface RailSpec {
  nodeName: string;
  nominalVoltage: number;
  tolerancePercent: number;
}

export interface RailVerdict {
  nodeName: string;
  nominalVoltage: number;
  tolerancePercent: number;
  minAllowedVoltage: number;
  maxAllowedVoltage: number;
  observedVoltage: number;
  withinTolerance: boolean;
}
