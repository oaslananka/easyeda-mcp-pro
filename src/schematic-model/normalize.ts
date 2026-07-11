import {
  CanonicalComponentSchema,
  CanonicalNetSchema,
  SchematicModelSchema,
  type CanonicalComponent,
  type CanonicalNet,
  type ComponentKind,
  type ModelDiagnostic,
  type SchematicDocument,
  type SchematicModel,
  type SymbolSource,
} from './model.js';
import { normalizeNetName } from './net-names.js';

export interface RawSchematicComponent extends Record<string, unknown> {
  primitiveId?: unknown;
  reference?: unknown;
  value?: unknown;
  footprint?: unknown;
  componentType?: unknown;
  state?: unknown;
}

export interface RawSchematicNet extends Record<string, unknown> {
  netName?: unknown;
  nodes?: unknown;
}

export interface BuildSchematicModelInput {
  document?: SchematicDocument;
  components?: RawSchematicComponent[];
  nets?: RawSchematicNet[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function primitive(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function read(raw: RawSchematicComponent, ...keys: string[]): unknown {
  const state = record(raw.state);
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
    if (state?.[key] !== undefined) return state[key];
    const stateKey = key.length > 0 ? `${key.charAt(0).toUpperCase()}${key.slice(1)}` : key;
    if (state?.[stateKey] !== undefined) return state[stateKey];
  }
  return undefined;
}

function metadataMap(raw: RawSchematicComponent): Map<string, string> {
  const output = new Map<string, string>();
  const sources = [raw, record(raw.state), record(raw.attributes), record(raw.properties)].filter(
    (entry): entry is Record<string, unknown> => Boolean(entry),
  );
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const text = primitive(value);
      if (text !== undefined) output.set(key.toLowerCase(), text);
    }
  }
  return output;
}

export function resolveMetadataExpression(
  rawValue: unknown,
  metadata: ReadonlyMap<string, string> | Record<string, unknown>,
): { raw: string; resolved: string; expressionKey?: string } {
  const raw = primitive(rawValue) ?? '';
  const map =
    metadata instanceof Map
      ? metadata
      : new Map(
          Object.entries(metadata).flatMap(([key, value]) => {
            const text = primitive(value);
            return text === undefined ? [] : [[key.toLowerCase(), text] as const];
          }),
        );
  let resolved = raw;
  let expressionKey: string | undefined;

  for (let depth = 0; depth < 3; depth += 1) {
    const match = /^=\{([^{}]+)\}$/.exec(resolved.trim());
    if (!match?.[1]) break;
    const key = match[1].trim();
    const replacement = map.get(key.toLowerCase());
    if (!replacement || replacement === resolved) break;
    expressionKey ??= key;
    resolved = replacement;
  }

  return { raw, resolved, expressionKey };
}

function inferSymbolSource(raw: RawSchematicComponent): SymbolSource {
  const sourceText = [
    read(raw, 'symbolSource', 'librarySource', 'source'),
    read(raw, 'deviceName'),
    read(raw, 'symbolName'),
    read(raw, 'value'),
  ]
    .map((value) => primitive(value)?.toLowerCase() ?? '')
    .join(' ');
  if (/\b(?:kicad|imported|symbols_)/.test(sourceText)) return 'imported';
  if (primitive(read(raw, 'deviceUuid')) || primitive(read(raw, 'deviceLibraryUuid')))
    return 'native';
  return 'unknown';
}

function classifyComponent(raw: RawSchematicComponent, reference: string): ComponentKind {
  const componentType = (primitive(read(raw, 'componentType', 'type')) ?? '').toLowerCase();
  const name = [
    primitive(read(raw, 'name')),
    primitive(read(raw, 'deviceName')),
    primitive(read(raw, 'symbolName')),
    primitive(read(raw, 'value')),
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  if (componentType === 'sheet') return 'sheet-frame';
  if (componentType === 'netport') return 'net-port';
  if (componentType === 'netflag') {
    if (/PWR_FLAG|#FLG/.test(`${reference} ${name}`)) return 'power-flag';
    if (/GND|GROUND|POWER|VCC|VDD|VBUS|VSYS|\+\d/.test(name)) return 'power-symbol';
    return 'net-label';
  }
  if (/^(?:#PWR)/i.test(reference)) return 'power-symbol';
  if (/^(?:#FLG)/i.test(reference) || /PWR_FLAG/.test(name)) return 'power-flag';
  if (/^(?:text|annotation|graphic|rectangle|circle|polygon)$/.test(componentType)) {
    return 'annotation';
  }
  if (componentType === 'part') return 'part';
  // An explicit but unsupported runtime type is more trustworthy than a
  // reference-looking label such as X1. Keep it as a helper so the imported
  // design audit can surface BOM-classification ambiguity instead of silently
  // promoting it into the BOM.
  if (componentType) return 'helper';
  if (/^[A-Za-z][A-Za-z0-9]*\??\d*$/.test(reference) && !reference.startsWith('#')) return 'part';
  if (
    primitive(read(raw, 'footprint')) ||
    primitive(read(raw, 'deviceUuid')) ||
    primitive(read(raw, 'deviceName'))
  ) {
    return 'part';
  }
  return 'unknown';
}

export function normalizeSchematicComponent(
  raw: RawSchematicComponent,
  index = 0,
): CanonicalComponent {
  const metadata = metadataMap(raw);
  const rawReference = primitive(read(raw, 'reference', 'designator')) ?? '';
  const referenceExpression = resolveMetadataExpression(rawReference, metadata);
  const reference = referenceExpression.resolved;
  const rawValue = read(raw, 'value', 'Value');
  const value = resolveMetadataExpression(rawValue, metadata);
  const rawFootprint = read(raw, 'footprint', 'Footprint');
  const footprint = resolveMetadataExpression(rawFootprint, metadata);
  const runtimePrimitiveId = primitive(read(raw, 'primitiveId', 'PrimitiveId'));
  const componentKind = classifyComponent(raw, reference);
  const annotated = reference.length > 0 && !/[?*]/.test(reference);

  return CanonicalComponentSchema.parse({
    canonicalComponentId:
      runtimePrimitiveId ?? (reference ? `ref:${reference}` : `component:${index}`),
    runtimePrimitiveId,
    reference,
    rawReference,
    annotated,
    unit: primitive(read(raw, 'unit', 'subPartName')),
    symbolSource: inferSymbolSource(raw),
    componentKind,
    bomEligible: componentKind === 'part',
    electricalEligible: ['part', 'power-symbol', 'power-flag', 'net-label', 'net-port'].includes(
      componentKind,
    ),
    rawValue: value.raw,
    value: value.resolved,
    rawFootprint: footprint.raw,
    footprint: footprint.resolved,
    manufacturerPart: primitive(read(raw, 'manufacturerId', 'manufacturerPart', 'mpn')),
    manufacturer: primitive(read(raw, 'manufacturer')),
    lcsc: primitive(read(raw, 'lcsc', 'LCSC')),
    datasheet: primitive(read(raw, 'datasheet')),
    deviceName: primitive(read(raw, 'deviceName')),
    symbolName: primitive(read(raw, 'symbolName')),
    x: finiteNumber(read(raw, 'x', 'X')),
    y: finiteNumber(read(raw, 'y', 'Y')),
    rotation: finiteNumber(read(raw, 'rotation', 'Rotation')),
  });
}

function normalizeNode(value: unknown) {
  const node = record(value) ?? {};
  return {
    componentRef: primitive(node.componentRef ?? node.component ?? node.deviceRef) ?? '',
    pin: primitive(node.pin ?? node.pinNumber) ?? '',
    x: finiteNumber(node.x),
    y: finiteNumber(node.y),
    source: primitive(node.source),
  };
}

export function normalizeSchematicNets(rawNets: RawSchematicNet[]): CanonicalNet[] {
  const grouped = new Map<
    string,
    {
      rawNetNames: Set<string>;
      rules: Set<string>;
      imported: boolean;
      kind: CanonicalNet['kind'];
      nodes: Map<string, ReturnType<typeof normalizeNode>>;
    }
  >();

  for (const raw of rawNets) {
    const normalized = normalizeNetName(raw.netName);
    const current = grouped.get(normalized.canonicalNetName) ?? {
      rawNetNames: new Set<string>(),
      rules: new Set<string>(),
      imported: false,
      kind: normalized.kind,
      nodes: new Map<string, ReturnType<typeof normalizeNode>>(),
    };
    current.rawNetNames.add(normalized.rawNetName || '');
    normalized.rules.forEach((rule) => current.rules.add(rule));
    current.imported ||= normalized.imported;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    for (const rawNode of nodes) {
      const node = normalizeNode(rawNode);
      const key = `${node.componentRef}\u0000${node.pin}\u0000${node.x ?? ''}\u0000${node.y ?? ''}`;
      current.nodes.set(key, node);
    }
    grouped.set(normalized.canonicalNetName, current);
  }

  return [...grouped.entries()]
    .map(([canonicalNetName, group]) =>
      CanonicalNetSchema.parse({
        id: `net:${canonicalNetName}`,
        canonicalNetName,
        rawNetNames: [...group.rawNetNames].sort(),
        kind: group.kind,
        nodes: [...group.nodes.values()],
        normalizationRules: [...group.rules].sort(),
        imported: group.imported,
      }),
    )
    .sort((a, b) => a.canonicalNetName.localeCompare(b.canonicalNetName));
}

export function buildCanonicalSchematicModel(input: BuildSchematicModelInput): SchematicModel {
  const components = (input.components ?? []).map((component, index) =>
    normalizeSchematicComponent(component, index),
  );
  const nets = normalizeSchematicNets(input.nets ?? []);
  const diagnostics: ModelDiagnostic[] = [];

  for (const component of components) {
    if (component.componentKind !== 'part') continue;
    if (!component.annotated) {
      diagnostics.push({
        code: 'COMPONENT_UNANNOTATED',
        severity: 'warning',
        message: 'Real component is missing a stable reference designator.',
        componentId: component.canonicalComponentId,
        componentRef: component.reference,
      });
    }
    if (!component.footprint) {
      diagnostics.push({
        code: 'COMPONENT_MISSING_FOOTPRINT',
        severity: 'warning',
        message: 'BOM component has no resolved footprint metadata.',
        componentId: component.canonicalComponentId,
        componentRef: component.reference,
      });
    }
  }

  for (const net of nets) {
    if (net.rawNetNames.length > 1) {
      diagnostics.push({
        code: 'NET_ALIASES_MERGED',
        severity: 'info',
        message: `Multiple raw net aliases resolve to ${net.canonicalNetName}.`,
        netName: net.canonicalNetName,
        details: { rawNetNames: net.rawNetNames },
      });
    }
  }

  return SchematicModelSchema.parse({
    schemaVersion: 'schematic-model/v1',
    document: input.document ?? {},
    components,
    nets,
    diagnostics,
    summary: {
      componentCount: components.length,
      bomComponentCount: components.filter((component) => component.bomEligible).length,
      electricalComponentCount: components.filter((component) => component.electricalEligible)
        .length,
      netCount: nets.length,
      importedComponentCount: components.filter(
        (component) => component.symbolSource === 'imported',
      ).length,
    },
  });
}
