import { type NetKind } from './model.js';

export interface NetNameNormalization {
  rawNetName: string;
  canonicalNetName: string;
  kind: NetKind;
  changed: boolean;
  imported: boolean;
  rules: string[];
}

interface NetNameTransform {
  value: string;
  changed: boolean;
}

const GROUND_NAMES = new Set(['GND', 'AGND', 'DGND', 'PGND', 'GNDA', 'GNDD', 'VSS', 'GROUND']);
const NAMED_POWER_PREFIXES = [
  'VCC',
  'VDD',
  'VSS',
  'VEE',
  'VIN',
  'VOUT',
  'VBUS',
  'VSYS',
  'VBAT',
  'VREF',
  'VDRV',
  'VDRIVE',
  'VMOT',
  'VUSB',
  'VCORE',
  'VIO',
  'VANA',
  'VDIG',
] as const;

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isPowerSuffixChar(char: string): boolean {
  return (
    (char >= 'A' && char <= 'Z') ||
    isAsciiDigit(char) ||
    char === '_' ||
    char === '+' ||
    char === '-'
  );
}

function isNumericPowerName(name: string): boolean {
  const upper = name.toUpperCase();
  const unsigned = upper.startsWith('+') || upper.startsWith('-') ? upper.slice(1) : upper;
  let index = 0;
  while (index < unsigned.length && isAsciiDigit(unsigned.charAt(index))) index += 1;
  if (index === 0) return false;
  if (index === unsigned.length) return true;
  if (unsigned[index] !== 'V') return false;
  index += 1;
  while (index < unsigned.length && isAsciiDigit(unsigned.charAt(index))) index += 1;
  return index === unsigned.length;
}

function isNamedPowerName(name: string): boolean {
  const upper = name.toUpperCase();
  const prefix = NAMED_POWER_PREFIXES.find((candidate) => upper.startsWith(candidate));
  if (!prefix) return false;
  return [...upper.slice(prefix.length)].every(isPowerSuffixChar);
}

function isGroundName(name: string): boolean {
  return GROUND_NAMES.has(name.toUpperCase());
}

function isPowerName(name: string): boolean {
  return isNumericPowerName(name) || isNamedPowerName(name);
}

function isImportedPowerSuffix(name: string): boolean {
  return name.toUpperCase() === 'PWR_FLAG' || isGroundName(name) || isPowerName(name);
}

function canonicalizePowerRail(name: string): string {
  const upper = name.toUpperCase();
  if (isGroundName(upper)) return upper === 'GROUND' || upper === 'VSS' ? 'GND' : upper;
  if (
    !upper.startsWith('+') &&
    !upper.startsWith('-') &&
    upper.includes('V') &&
    isNumericPowerName(upper)
  ) {
    return `+${upper}`;
  }
  return upper;
}

function safeNetNameInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }
  return '';
}

function decodeSlashToken(value: string): NetNameTransform {
  if (!/\{SLASH\}/i.test(value)) return { value, changed: false };
  return { value: value.replace(/\{SLASH\}/gi, '/'), changed: true };
}

function stripImportedSymbolsPrefix(value: string): NetNameTransform {
  const prefix = 'SYMBOLS_';
  if (!value.toUpperCase().startsWith(prefix)) return { value, changed: false };
  const suffix = value.slice(prefix.length);
  if (!suffix || !isImportedPowerSuffix(suffix)) return { value, changed: false };
  return { value: canonicalizePowerRail(suffix), changed: true };
}

function normalizeSymbolPrefix(value: string, prefix: 'GROUND-' | 'POWER-'): NetNameTransform {
  if (!value.toUpperCase().startsWith(prefix)) return { value, changed: false };
  const suffix = value.slice(prefix.length);
  const recognized = prefix === 'GROUND-' ? isGroundName(suffix) : isImportedPowerSuffix(suffix);
  if (!suffix || !recognized) return { value, changed: false };
  return { value: canonicalizePowerRail(suffix), changed: true };
}

function canonicalizeKnownRail(value: string, rules: string[]): string {
  if (!isGroundName(value) && !isPowerName(value) && value !== 'PWR_FLAG') return value;
  const canonical = canonicalizePowerRail(value);
  if (canonical !== value) {
    rules.push(isGroundName(value) ? 'canonicalize-ground-name' : 'canonicalize-power-name');
  }
  return canonical;
}

export function classifyCanonicalNetName(name: string): NetKind {
  if (!name || name === 'UNNAMED') return 'unnamed';
  if (name === 'PWR_FLAG') return 'power-flag';
  if (isGroundName(name)) return 'ground';
  if (isPowerName(name)) return 'power';
  return 'signal';
}

/**
 * Normalize only well-known imported/power aliases. Arbitrary user signal names
 * are preserved byte-for-byte (apart from surrounding whitespace and the
 * explicit {SLASH} import token), so this function is safe for readback use.
 */
export function normalizeNetName(input: unknown): NetNameNormalization {
  const rawNetName = safeNetNameInput(input);
  let canonical = rawNetName.trim();
  const rules: string[] = [];
  let imported = false;

  if (!canonical) {
    canonical = 'UNNAMED';
    rules.push('empty-to-unnamed');
  }

  const slash = decodeSlashToken(canonical);
  canonical = slash.value;
  if (slash.changed) {
    rules.push('decode-import-slash-token');
    imported = true;
  }

  const symbols = stripImportedSymbolsPrefix(canonical);
  canonical = symbols.value;
  if (symbols.changed) {
    rules.push('strip-imported-symbols-power-prefix');
    imported = true;
  }

  const ground = normalizeSymbolPrefix(canonical, 'GROUND-');
  canonical = ground.value;
  if (ground.changed) rules.push('normalize-ground-symbol-name');

  const power = normalizeSymbolPrefix(canonical, 'POWER-');
  canonical = power.value;
  if (power.changed) rules.push('normalize-power-symbol-name');

  canonical = canonicalizeKnownRail(canonical, rules);

  return {
    rawNetName,
    canonicalNetName: canonical,
    kind: classifyCanonicalNetName(canonical),
    changed: canonical !== rawNetName,
    imported,
    rules,
  };
}
