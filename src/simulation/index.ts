/** Offline SPICE circuit verification — public API. */

export { buildSpiceDeck, assertSafeIdentifier } from './netlist.js';
export { detectNgspice, runNgspiceDeck } from './runner.js';
export { parseOperatingPointOutput, parseTransientOutput } from './parser.js';
export { verifyRailAgainstSpec } from './verify.js';
export { DIODE_MODELS, getDiodeModel, listDiodeModels } from './models.js';
export type {
  DcCurrentSource,
  DcVoltageSource,
  DiodeComponent,
  LdoBehavioralComponent,
  NgspiceAvailability,
  OperatingPointAnalysis,
  OperatingPointResult,
  PassiveComponent,
  PulseCurrentSource,
  PulseVoltageSource,
  RailSpec,
  RailVerdict,
  SimAnalysis,
  SimCircuit,
  SimComponent,
  SimComponentKind,
  TransientAnalysis,
  TransientResult,
  TransientSample,
} from './types.js';
export type { DiodeModelEntry } from './models.js';
export type { RunNgspiceOptions, RunNgspiceResult } from './runner.js';
