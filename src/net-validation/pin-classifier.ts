/**
 * Heuristic net/pin electrical-type classification from naming conventions,
 * used to auto-extract a semantic netlist from a live EasyEDA schematic
 * where reliable per-pin metadata isn't available from the bridge.
 *
 * EasyEDA's own pin `pinType` field is unreliably authored across its
 * library — live-verified: a plain resistor's pins report "IN" (meaningless
 * for a passive part) while a real op-amp's (LM358) pins all report
 * "Undefined". Name-pattern matching is tried first; native pinType is only
 * consulted as a fallback for a pin whose name gives no signal.
 *
 * @module
 */

import { NetDomain, NET_DOMAIN_PATTERNS, type PinElectricalType } from './schema.js';

/** Classify a net name into the coarse type semantic ERC needs, reusing the
 *  same naming-convention patterns already used for net-name domain checks. */
export function classifyNetType(netName: string): 'power' | 'signal' | 'ground' {
  const name = (netName ?? '').trim();
  if (!name) return 'signal';
  if (NET_DOMAIN_PATTERNS[NetDomain.Ground].some((pattern) => pattern.test(name))) {
    return 'ground';
  }
  if (NET_DOMAIN_PATTERNS[NetDomain.Power].some((pattern) => pattern.test(name))) {
    return 'power';
  }
  return 'signal';
}

const NO_CONNECT_RE = /^(NC|N\.C\.|DNC|DO ?NOT ?CONNECT)$/i;
const POWER_OUTPUT_RE = /^V(OUT|DDOUT)\b/i;
const POWER_INPUT_RE =
  /^(GND|VSS|AGND|DGND|PGND|GNDA|GNDD|GNDP|VCC|VDD|VBAT|VIN|AVCC|AVDD|VPP|VDDIO|VDDA|VSSA)\b/i;
const BIDIRECTIONAL_HINT_RE = /^(SDA|DATA|DQ\d*|IO\d*)\b/i;
const OUTPUT_RE = /OUT/i;
// Two separate patterns rather than one combined alternation: a named
// control-signal prefix (anchored) OR "IN" appearing anywhere (unanchored,
// e.g. real op-amp pins "1IN-"/"1IN+") — kept apart so the anchoring
// difference between the two isn't buried in ambiguous regex precedence.
const CONTROL_SIGNAL_RE = /^n?(RST|RESET|EN|ENABLE|CE|CS|SHDN|WAKE|SLEEP)\b/i;
const INPUT_HINT_RE = /IN/i;

const NATIVE_PIN_TYPE_MAP: Record<string, PinElectricalType> = {
  IN: 'input',
  OUT: 'output',
  BI: 'bidirectional',
  BIDIRECTIONAL: 'bidirectional',
  PWR: 'power_input',
  POWER: 'power_input',
  PASSIVE: 'passive',
  OPENCOLLECTOR: 'open_drain',
  OPEN_COLLECTOR: 'open_drain',
  OPENDRAIN: 'open_drain',
  OPEN_DRAIN: 'open_drain',
  NOTCONNECTED: 'no_connect',
  NC: 'no_connect',
  NO_CONNECT: 'no_connect',
};

/**
 * Best-effort electrical-type classification for a single pin. Returns
 * undefined (unclassified) rather than guessing wrong — callers should treat
 * that as "skip pin-type checks for this pin", not an error, and default the
 * pin to 'passive' in a DeviceValidationEntry so unclassified pins never
 * trigger a floating-input/output-contention/missing-power false positive.
 */
export function classifyPinElectricalType(
  pinName: string | undefined,
  nativePinType: string | undefined,
): PinElectricalType | undefined {
  const name = (pinName ?? '').trim();
  if (name) {
    if (NO_CONNECT_RE.test(name)) return 'no_connect';
    if (POWER_OUTPUT_RE.test(name)) return 'power_output';
    if (POWER_INPUT_RE.test(name)) return 'power_input';
    if (BIDIRECTIONAL_HINT_RE.test(name)) return 'bidirectional';
    if (OUTPUT_RE.test(name)) return 'output';
    if (CONTROL_SIGNAL_RE.test(name) || INPUT_HINT_RE.test(name)) return 'input';
  }
  const native = (nativePinType ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return NATIVE_PIN_TYPE_MAP[native];
}
