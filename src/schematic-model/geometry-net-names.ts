import type { NetNameCategory } from './geometry-model.js';

export interface NetNameNormalizationRules {
  /** Exact, case-insensitive mappings. A null target excludes the name from signal nets. */
  exact?: Readonly<Record<string, string | null>>;
  stripImportedSymbolsPrefix?: boolean;
  normalizePowerPrefixes?: boolean;
  normalizeGroundAliases?: boolean;
  recognizedPowerNames?: readonly string[];
}

export interface NetNameNormalizationResult {
  rawNetName: string;
  canonicalNetName: string | null;
  changed: boolean;
  excluded: boolean;
  category: NetNameCategory;
  ruleId?: string;
}

const DEFAULT_POWER_NAMES = [
  'VBUS',
  'VSYS',
  'VBAT',
  'VIN',
  'VOUT',
  'VCC',
  'VDD',
  'VEE',
  'VSS',
  '+1V0',
  '+1V1',
  '+1V2',
  '+1V8',
  '+2V5',
  '+3V3',
  '+5V',
  '+9V',
  '+12V',
  '+24V',
] as const;

export const DEFAULT_NET_NAME_RULES: Readonly<NetNameNormalizationRules> = {
  exact: {
    SYMBOLS_GND: 'GND',
    'Ground-GND': 'GND',
    SYMBOLS_PWR_FLAG: null,
  },
  stripImportedSymbolsPrefix: true,
  normalizePowerPrefixes: true,
  normalizeGroundAliases: true,
  recognizedPowerNames: DEFAULT_POWER_NAMES,
};

function voltageName(name: string): string | undefined {
  const compact = name.trim().toUpperCase().replace(/\s+/g, '');
  const direct = compact.match(/^\+?(\d+(?:V\d+)?)$/);
  if (direct?.[1]) return `+${direct[1]}`;
  const volts = compact.match(/^\+?(\d+)V$/);
  if (volts?.[1]) return `+${volts[1]}V`;
  return undefined;
}

function mergedRules(rules?: NetNameNormalizationRules): Required<NetNameNormalizationRules> {
  return {
    exact: { ...DEFAULT_NET_NAME_RULES.exact, ...rules?.exact },
    stripImportedSymbolsPrefix:
      rules?.stripImportedSymbolsPrefix ?? DEFAULT_NET_NAME_RULES.stripImportedSymbolsPrefix ?? true,
    normalizePowerPrefixes:
      rules?.normalizePowerPrefixes ?? DEFAULT_NET_NAME_RULES.normalizePowerPrefixes ?? true,
    normalizeGroundAliases:
      rules?.normalizeGroundAliases ?? DEFAULT_NET_NAME_RULES.normalizeGroundAliases ?? true,
    recognizedPowerNames:
      rules?.recognizedPowerNames ??
      DEFAULT_NET_NAME_RULES.recognizedPowerNames ??
      DEFAULT_POWER_NAMES,
  };
}

function categoryFor(name: string | null, excluded: boolean): NetNameCategory {
  if (excluded) return 'power-flag';
  if (!name) return 'unnamed';
  const upper = name.toUpperCase();
  if (/^(?:A|D|P)?GND$/.test(upper) || upper === 'VSS') return 'ground';
  if (
    /^\+\d/.test(upper) ||
    /^(?:VCC|VDD|VEE|VBUS|VBAT|VSYS|VIN|VOUT|AVCC|DVCC)$/.test(upper)
  ) {
    return 'power';
  }
  return 'signal';
}

/**
 * Conservatively normalizes only known power/ground spellings.
 * Arbitrary user signals (including unknown `SYMBOLS_*` names) are preserved.
 */
export function normalizeNetName(
  rawName: string | null | undefined,
  rules?: NetNameNormalizationRules,
): NetNameNormalizationResult {
  const rawNetName = String(rawName ?? '').trim();
  if (!rawNetName) {
    return {
      rawNetName,
      canonicalNetName: null,
      changed: false,
      excluded: false,
      category: 'unnamed',
    };
  }

  const config = mergedRules(rules);
  const exactEntry = Object.entries(config.exact).find(
    ([source]) => source.toUpperCase() === rawNetName.toUpperCase(),
  );
  if (exactEntry) {
    const canonicalNetName = exactEntry[1];
    const excluded = canonicalNetName === null;
    return {
      rawNetName,
      canonicalNetName,
      changed: canonicalNetName !== rawNetName,
      excluded,
      category: categoryFor(canonicalNetName, excluded),
      ruleId: excluded ? 'exclude-power-flag' : 'exact-alias',
    };
  }

  const upper = rawNetName.toUpperCase();
  if (/^(?:SYMBOLS[_-])?PWR[_-]?FLAG$/.test(upper)) {
    return {
      rawNetName,
      canonicalNetName: null,
      changed: true,
      excluded: true,
      category: 'power-flag',
      ruleId: 'exclude-power-flag',
    };
  }

  if (config.normalizeGroundAliases) {
    const groundCandidate = upper.replace(/^SYMBOLS[_-]/, '').replace(/^GROUND[_-]/, '');
    if (['GND', 'GROUND', '0V'].includes(groundCandidate)) {
      return {
        rawNetName,
        canonicalNetName: 'GND',
        changed: rawNetName !== 'GND',
        excluded: false,
        category: 'ground',
        ruleId: 'ground-alias',
      };
    }
  }

  if (config.stripImportedSymbolsPrefix && /^SYMBOLS[_-]/i.test(rawNetName)) {
    const suffix = rawNetName.replace(/^SYMBOLS[_-]/i, '');
    const suffixUpper = suffix.toUpperCase();
    const recognized = config.recognizedPowerNames.some(
      (candidate) => candidate.toUpperCase() === suffixUpper,
    );
    const voltage = voltageName(suffix);
    if (recognized || voltage) {
      const canonicalNetName = voltage ?? suffixUpper;
      return {
        rawNetName,
        canonicalNetName,
        changed: canonicalNetName !== rawNetName,
        excluded: false,
        category: categoryFor(canonicalNetName, false),
        ruleId: 'imported-power-prefix',
      };
    }
  }

  if (config.normalizePowerPrefixes) {
    const prefixed = rawNetName.match(/^Power[-_:](.+)$/i);
    if (prefixed?.[1]) {
      const normalized = voltageName(prefixed[1]);
      const upperValue = prefixed[1].toUpperCase();
      const recognized = config.recognizedPowerNames.some(
        (candidate) => candidate.toUpperCase() === upperValue,
      );
      if (normalized || recognized) {
        const canonicalNetName = normalized ?? upperValue;
        return {
          rawNetName,
          canonicalNetName,
          changed: true,
          excluded: false,
          category: 'power',
          ruleId: 'power-prefix',
        };
      }
    }
  }

  return {
    rawNetName,
    canonicalNetName: rawNetName,
    changed: false,
    excluded: false,
    category: categoryFor(rawNetName, false),
  };
}
