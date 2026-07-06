/**
 * Diode/LED SPICE model library — typed data with provenance, not manufacturer-certified
 * parameters. See each entry's `caveat` before trusting a result derived from it.
 *
 * @module
 */

export interface DiodeModelEntry {
  name: string;
  displayName: string;
  /** Parameters for a SPICE `.model NAME D (...)` card, ngspice-compatible. */
  params: Record<string, number>;
  source: string;
  caveat: string;
}

export const DIODE_MODELS: Record<string, DiodeModelEntry> = {
  'generic-silicon-switching': {
    name: 'generic-silicon-switching',
    displayName: 'Generic silicon switching diode (1N4148-class)',
    params: {
      IS: 2.52e-9,
      N: 1.752,
      RS: 0.568,
      CJO: 4e-12,
      TT: 20e-9,
      BV: 100,
      IBV: 1e-4,
    },
    source:
      'Commonly published 1N4148-class SPICE parameters used across multiple vendor/simulator ' +
      'model libraries — not sourced from a specific manufacturer datasheet.',
    caveat:
      "Approximate, non-manufacturer-certified model. Verify against the actual selected part's " +
      'datasheet or vendor-provided SPICE model before trusting a safety- or timing-critical result.',
  },
  'generic-led-red': {
    name: 'generic-led-red',
    displayName: 'Generic red LED (approximate)',
    params: {
      IS: 1e-20,
      N: 2,
      RS: 10,
      BV: 5,
      IBV: 1e-4,
    },
    source:
      'Rough approximation of typical red-LED forward characteristics (~1.8-2.2V Vf) for order-of-' +
      'magnitude current-limiting checks — not derived from any specific manufacturer part.',
    caveat:
      'LED forward voltage varies significantly by color/chemistry/manufacturer (red ~1.8-2.2V, ' +
      "blue/white ~2.8-3.4V). Replace with the actual part's SPICE model for anything beyond a " +
      'rough sanity check.',
  },
};

export function getDiodeModel(name: string): DiodeModelEntry {
  const entry = DIODE_MODELS[name];
  if (!entry) {
    throw new Error(
      `Unknown diode/LED model "${name}". Available: ${Object.keys(DIODE_MODELS).join(', ')}`,
    );
  }
  return entry;
}

export function listDiodeModels(): DiodeModelEntry[] {
  return Object.values(DIODE_MODELS);
}
