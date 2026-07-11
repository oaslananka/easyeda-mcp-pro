import { type NetKind } from './model.js';

export interface NetNameNormalization {
  rawNetName: string;
  canonicalNetName: string;
  kind: NetKind;
  changed: boolean;
  imported: boolean;
  rules: string[];
}

const POWER_NAME =
  /^(?:\+?-?\d+(?:V\d+|V)?|V(?:CC|DD|SS|EE|IN|OUT|BUS|SYS|BAT|REF|DRV|DRIVE|MOT|USB|CORE|IO|ANA|DIG)[A-Z0-9_+-]*)$/i;
const GROUND_NAME = /^(?:GND|AGND|DGND|PGND|GNDA|GNDD|VSS|GROUND)$/i;
const IMPORTED_POWER_SUFFIX =
  /^(?:PWR_FLAG|GND|AGND|DGND|PGND|GNDA|GNDD|VSS|GROUND|\+?-?\d+(?:V\d+|V)?|V[A-Z0-9_+-]+)$/i;

function canonicalizePowerRail(name: string): string {
  const upper = name.toUpperCase();
  if (GROUND_NAME.test(upper)) return upper === 'GROUND' || upper === 'VSS' ? 'GND' : upper;
  if (/^\d+(?:V\d+|V)$/.test(upper)) return `+${upper}`;
  if (/^\+\d+V$/.test(upper)) return upper;
  if (/^\+\d+V\d+$/.test(upper)) return upper;
  if (upper === 'PWR_FLAG') return 'PWR_FLAG';
  return upper;
}

export function classifyCanonicalNetName(name: string): NetKind {
  if (!name || name === 'UNNAMED') return 'unnamed';
  if (name === 'PWR_FLAG') return 'power-flag';
  if (GROUND_NAME.test(name)) return 'ground';
  if (POWER_NAME.test(name)) return 'power';
  return 'signal';
}

/**
 * Normalize only well-known imported/power aliases. Arbitrary user signal names
 * are preserved byte-for-byte (apart from surrounding whitespace and the
 * explicit {SLASH} import token), so this function is safe for readback use.
 */
export function normalizeNetName(input: unknown): NetNameNormalization {
  const rawNetName = typeof input === 'string' ? input : input == null ? '' : String(input);
  let canonical = rawNetName.trim();
  const rules: string[] = [];
  let imported = false;

  if (!canonical) {
    canonical = 'UNNAMED';
    rules.push('empty-to-unnamed');
  }

  if (/\{SLASH\}/i.test(canonical)) {
    canonical = canonical.replace(/\{SLASH\}/gi, '/');
    rules.push('decode-import-slash-token');
    imported = true;
  }

  const symbolsMatch = /^SYMBOLS_(.+)$/i.exec(canonical);
  if (symbolsMatch?.[1] && IMPORTED_POWER_SUFFIX.test(symbolsMatch[1])) {
    canonical = canonicalizePowerRail(symbolsMatch[1]);
    rules.push('strip-imported-symbols-power-prefix');
    imported = true;
  }

  const groundMatch = /^GROUND-(.+)$/i.exec(canonical);
  if (groundMatch?.[1] && GROUND_NAME.test(groundMatch[1])) {
    canonical = canonicalizePowerRail(groundMatch[1]);
    rules.push('normalize-ground-symbol-name');
  }

  const powerMatch = /^POWER-(.+)$/i.exec(canonical);
  if (powerMatch?.[1] && IMPORTED_POWER_SUFFIX.test(powerMatch[1])) {
    canonical = canonicalizePowerRail(powerMatch[1]);
    rules.push('normalize-power-symbol-name');
  }

  if (GROUND_NAME.test(canonical)) {
    const normalizedGround = canonicalizePowerRail(canonical);
    if (normalizedGround !== canonical) rules.push('canonicalize-ground-name');
    canonical = normalizedGround;
  } else if (POWER_NAME.test(canonical) || canonical === 'PWR_FLAG') {
    const normalizedPower = canonicalizePowerRail(canonical);
    if (normalizedPower !== canonical) rules.push('canonicalize-power-name');
    canonical = normalizedPower;
  }

  return {
    rawNetName,
    canonicalNetName: canonical,
    kind: classifyCanonicalNetName(canonical),
    changed: canonical !== rawNetName,
    imported,
    rules,
  };
}
