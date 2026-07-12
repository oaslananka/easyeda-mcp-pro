import type {
  ClassificationConfidence,
  ComponentKind,
  RawComponentInput,
  SymbolSource,
} from './geometry-model.js';

export interface ComponentClassification {
  symbolSource: SymbolSource;
  componentKind: ComponentKind;
  confidence: ClassificationConfidence;
  reasons: string[];
  bomEligible: boolean;
  electricalEligible: boolean;
}

function normalized(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function inferSymbolSource(input: RawComponentInput): SymbolSource {
  const explicit = normalized(input.symbolSource);
  if (explicit.includes('kicad')) return 'kicad-import';
  if (explicit.includes('altium')) return 'altium-import';
  if (explicit.includes('easyeda') || explicit === 'native') return 'native-easyeda';
  if (explicit.includes('custom') || explicit.includes('import')) return 'custom-import';
  if (explicit.includes('virtual')) return 'virtual';

  const prefix = String(input.symbolPrefix ?? '');
  const symbol = `${input.symbolName ?? ''} ${input.deviceName ?? ''}`;
  const rawText = JSON.stringify(input.raw ?? {});
  if (/^(?:kicad|symbols?[_-])/i.test(prefix) || /kicad/i.test(symbol) || /kicad/i.test(rawText)) {
    return 'kicad-import';
  }
  if (/altium/i.test(prefix) || /altium/i.test(symbol) || /altium/i.test(rawText)) {
    return 'altium-import';
  }
  if (/import/i.test(prefix) || /imported/i.test(rawText)) return 'unknown-import';
  return 'unknown';
}

function isUnannotated(reference: string | null | undefined): boolean {
  const value = String(reference ?? '').trim();
  return !value || /\?$/.test(value);
}

function partClassification(
  input: RawComponentInput,
  source: SymbolSource,
  reasons: string[],
): ComponentClassification {
  const unannotated = isUnannotated(input.reference);
  if (unannotated) reasons.push('Real part has a missing or placeholder reference.');
  return {
    symbolSource: source,
    componentKind: unannotated ? 'unannotated-part' : 'part',
    confidence: source === 'unknown' ? 'medium' : 'high',
    reasons,
    bomEligible: true,
    electricalEligible: true,
  };
}

/** Classifies primitives by semantics rather than relying on ComponentType=part alone. */
export function classifyComponent(input: RawComponentInput): ComponentClassification {
  const source = inferSymbolSource(input);
  const type = normalized(input.componentType);
  const symbolText = normalized(
    `${input.symbolName ?? ''} ${input.deviceName ?? ''} ${input.symbolPrefix ?? ''}`,
  );
  const reference = String(input.reference ?? '').trim();
  const reasons: string[] = [];

  if (type.includes('powerflag') || /pwrflag/.test(symbolText)) {
    reasons.push('Primitive identifies itself as a power flag.');
    return {
      symbolSource: source,
      componentKind: 'power-flag',
      confidence: 'high',
      reasons,
      bomEligible: false,
      electricalEligible: true,
    };
  }

  if (type === 'netflag' || type === 'powersymbol' || /(?:ground|gnd|power)[+\dv]/.test(symbolText)) {
    reasons.push('Net flag/power symbol participates in connectivity but not the BOM.');
    return {
      symbolSource: source,
      componentKind: 'power-symbol',
      confidence: type === 'netflag' ? 'high' : 'medium',
      reasons,
      bomEligible: false,
      electricalEligible: true,
    };
  }

  if (type === 'netport' || type === 'port' || type === 'sheetport') {
    reasons.push('Primitive is a net or sheet port.');
    return {
      symbolSource: source,
      componentKind: 'net-port',
      confidence: 'high',
      reasons,
      bomEligible: false,
      electricalEligible: true,
    };
  }

  if (type === 'noconnect' || type === 'nc' || symbolText.includes('noconnect')) {
    reasons.push('Primitive is a deliberate no-connect marker.');
    return {
      symbolSource: source,
      componentKind: 'no-connect',
      confidence: 'high',
      reasons,
      bomEligible: false,
      electricalEligible: true,
    };
  }

  if (type.includes('sheet') || type.includes('frame') || type === 'titleblock') {
    reasons.push('Primitive is a sheet/frame graphical object.');
    return {
      symbolSource: source,
      componentKind: 'sheet-frame',
      confidence: 'high',
      reasons,
      bomEligible: false,
      electricalEligible: false,
    };
  }

  if (type === 'text' || type === 'annotation' || type === 'graphic') {
    reasons.push('Primitive is graphical annotation.');
    return {
      symbolSource: source,
      componentKind: 'annotation',
      confidence: 'high',
      reasons,
      bomEligible: false,
      electricalEligible: false,
    };
  }

  if (type.includes('virtual') || type.includes('helper') || source === 'virtual') {
    reasons.push('Primitive is a virtual/import helper.');
    return {
      symbolSource: source,
      componentKind: 'virtual-helper',
      confidence: 'medium',
      reasons,
      bomEligible: false,
      electricalEligible: false,
    };
  }

  if (
    type === 'part' ||
    type === 'component' ||
    /^(?:[A-Z]+\d+|[A-Z]+\?)$/i.test(reference) ||
    (input.pins?.length ?? 0) > 0
  ) {
    reasons.push('Primitive has part semantics, a designator, or electrical pins.');
    return partClassification(input, source, reasons);
  }

  reasons.push('Primitive shape does not provide enough evidence for safe classification.');
  return {
    symbolSource: source,
    componentKind: 'unknown',
    confidence: 'low',
    reasons,
    bomEligible: false,
    electricalEligible: (input.pins?.length ?? 0) > 0,
  };
}

export function isImportedSymbolSource(source: SymbolSource): boolean {
  return ['kicad-import', 'altium-import', 'custom-import', 'unknown-import'].includes(source);
}
