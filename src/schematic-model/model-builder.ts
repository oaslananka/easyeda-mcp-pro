import { classifyComponent } from './imported-symbols.js';
import type {
  BusModel,
  ComponentModel,
  ModelDiagnostic,
  NetLabelModel,
  NetModel,
  NetNodeModel,
  NoConnectModel,
  PinModel,
  PowerSymbolModel,
  RawNetNodeInput,
  RawSchematicSnapshot,
  SchematicModel,
  SheetModel,
  TextModel,
  WireModel,
} from './geometry-model.js';
import type { NetNameNormalizationRules } from './geometry-net-names.js';
import { normalizeNetName } from './geometry-net-names.js';
import {
  canonicalModelHash,
  parseRawSchematicSnapshot,
  resolveComponentMetadata,
  stableCanonicalId,
} from './geometry-normalize.js';
import { normalizePinElectricalType, pinSemanticFlags } from './pin-semantics.js';

export interface BuildSchematicModelOptions {
  netNameRules?: NetNameNormalizationRules;
}

function cleanOptional(value: string | number | null | undefined): string | undefined {
  const clean = String(value ?? '').trim();
  return clean || undefined;
}

function pointKey(point: { x: number; y: number } | null | undefined): string | undefined {
  return point ? `${point.x},${point.y}` : undefined;
}

function pinLookupKey(reference: string | undefined, pinNumber: string): string {
  return `${reference?.toUpperCase() ?? ''}\u001f${pinNumber.toUpperCase()}`;
}

function componentLookupKey(runtimeId: string | undefined, reference: string | undefined): string {
  return runtimeId ? `id:${runtimeId}` : `ref:${reference?.toUpperCase() ?? ''}`;
}

function createComponents(
  snapshot: RawSchematicSnapshot,
): { components: ComponentModel[]; pins: PinModel[]; diagnostics: ModelDiagnostic[] } {
  const components: ComponentModel[] = [];
  const pins: PinModel[] = [];
  const diagnostics: ModelDiagnostic[] = [];

  for (const [componentIndex, rawComponent] of (snapshot.components ?? []).entries()) {
    const classification = classifyComponent(rawComponent);
    const reference = cleanOptional(rawComponent.reference);
    const unit = cleanOptional(rawComponent.unit);
    const canonicalComponentId = stableCanonicalId(
      'cmp',
      rawComponent.runtimePrimitiveId,
      reference,
      unit,
      componentIndex,
    );
    const metadata = resolveComponentMetadata(rawComponent);
    const componentPins: PinModel[] = [];

    for (const [pinIndex, rawPin] of (rawComponent.pins ?? []).entries()) {
      const number = String(rawPin.number).trim();
      const position = rawPin.position ?? undefined;
      const normalizedType = normalizePinElectricalType(rawPin.electricalType);
      const flags = pinSemanticFlags(rawPin);
      const pinUnit = cleanOptional(rawPin.unit) ?? unit;
      const canonicalPinId = stableCanonicalId(
        'pin',
        rawPin.runtimePrimitiveId,
        canonicalComponentId,
        pinUnit,
        number,
        pinIndex,
      );
      componentPins.push({
        runtimePrimitiveId: cleanOptional(rawPin.runtimePrimitiveId),
        canonicalPinId,
        canonicalComponentId,
        reference,
        unit: pinUnit,
        number,
        name: cleanOptional(rawPin.name),
        electricalType: normalizedType.electricalType,
        baseElectricalType: normalizedType.baseElectricalType,
        position,
        hidden: flags.hidden,
        stacked: flags.stacked,
        stackGroup: cleanOptional(rawPin.stackGroup),
        internallyConnected: flags.internallyConnected,
        powerGroup: cleanOptional(rawPin.powerGroup),
        required: rawPin.required === true,
        deliberateNoConnect: flags.deliberateNoConnect,
        noConnectAllowed: flags.noConnectAllowed,
        mechanicallyUnused: flags.mechanicallyUnused,
        pullRequirement: rawPin.pullRequirement ?? undefined,
        differentialPair: cleanOptional(rawPin.differentialPair),
        differentialPolarity: rawPin.differentialPolarity ?? undefined,
        netIds: [],
        raw: { ...(rawPin.raw ?? {}) },
      });
    }

    // EasyEDA/imported symbols can stack multiple logical pins at one coordinate.
    const coordinateGroups = new Map<string, PinModel[]>();
    for (const pin of componentPins) {
      const key = pointKey(pin.position);
      if (!key) continue;
      const group = coordinateGroups.get(key) ?? [];
      group.push(pin);
      coordinateGroups.set(key, group);
    }
    for (const [coordinate, group] of coordinateGroups) {
      if (group.length < 2) continue;
      const groupId = stableCanonicalId('stack', canonicalComponentId, coordinate);
      for (const pin of group) {
        pin.stacked = true;
        pin.stackGroup ??= groupId;
      }
    }

    pins.push(...componentPins);
    components.push({
      runtimePrimitiveId: rawComponent.runtimePrimitiveId,
      canonicalComponentId,
      reference,
      unit,
      symbolSource: classification.symbolSource,
      symbolPrefix: cleanOptional(rawComponent.symbolPrefix),
      componentKind: classification.componentKind,
      classificationConfidence: classification.confidence,
      classificationReasons: classification.reasons,
      bomEligible: classification.bomEligible,
      electricalEligible: classification.electricalEligible,
      dnp: metadata.dnp,
      position: rawComponent.position ?? undefined,
      bounds: rawComponent.bounds ?? undefined,
      pinIds: componentPins.map((pin) => pin.canonicalPinId),
      metadata,
      rawComponentType: cleanOptional(rawComponent.componentType),
      raw: { ...(rawComponent.raw ?? {}) },
    });

    if (classification.componentKind === 'unknown') {
      diagnostics.push({
        code: 'COMPONENT_CLASSIFICATION_AMBIGUOUS',
        severity: 'warning',
        message: `Could not confidently classify primitive ${rawComponent.runtimePrimitiveId}.`,
        canonicalComponentId,
        evidence: { reasons: classification.reasons },
      });
    }
  }

  return { components, pins, diagnostics };
}

interface PinIndexes {
  byRuntimeId: Map<string, PinModel>;
  byComponentAndNumber: Map<string, PinModel[]>;
  byReferenceAndNumber: Map<string, PinModel[]>;
  byCoordinate: Map<string, PinModel[]>;
  componentByRuntime: Map<string, ComponentModel>;
  componentByReference: Map<string, ComponentModel[]>;
}

function createPinIndexes(components: ComponentModel[], pins: PinModel[]): PinIndexes {
  const indexes: PinIndexes = {
    byRuntimeId: new Map(),
    byComponentAndNumber: new Map(),
    byReferenceAndNumber: new Map(),
    byCoordinate: new Map(),
    componentByRuntime: new Map(),
    componentByReference: new Map(),
  };
  for (const component of components) {
    indexes.componentByRuntime.set(component.runtimePrimitiveId, component);
    if (component.reference) {
      const key = component.reference.toUpperCase();
      const values = indexes.componentByReference.get(key) ?? [];
      values.push(component);
      indexes.componentByReference.set(key, values);
    }
  }
  for (const pin of pins) {
    if (pin.runtimePrimitiveId) indexes.byRuntimeId.set(pin.runtimePrimitiveId, pin);
    const componentKey = `${pin.canonicalComponentId}\u001f${pin.number.toUpperCase()}`;
    const componentPins = indexes.byComponentAndNumber.get(componentKey) ?? [];
    componentPins.push(pin);
    indexes.byComponentAndNumber.set(componentKey, componentPins);
    const referenceKey = pinLookupKey(pin.reference, pin.number);
    const referencePins = indexes.byReferenceAndNumber.get(referenceKey) ?? [];
    referencePins.push(pin);
    indexes.byReferenceAndNumber.set(referenceKey, referencePins);
    const coordinate = pointKey(pin.position);
    if (coordinate) {
      const coordinatePins = indexes.byCoordinate.get(coordinate) ?? [];
      coordinatePins.push(pin);
      indexes.byCoordinate.set(coordinate, coordinatePins);
    }
  }
  return indexes;
}

function resolveNodePin(node: RawNetNodeInput, indexes: PinIndexes): PinModel | undefined {
  if (node.pinPrimitiveId) {
    const direct = indexes.byRuntimeId.get(node.pinPrimitiveId);
    if (direct) return direct;
  }
  const number = cleanOptional(node.pinNumber);
  if (number && node.componentPrimitiveId) {
    const component = indexes.componentByRuntime.get(node.componentPrimitiveId);
    const match = component
      ? indexes.byComponentAndNumber.get(`${component.canonicalComponentId}\u001f${number.toUpperCase()}`)
      : undefined;
    if (match?.length === 1) return match[0];
  }
  if (number && node.componentReference) {
    const match = indexes.byReferenceAndNumber.get(
      pinLookupKey(node.componentReference, number),
    );
    if (match?.length === 1) return match[0];
  }
  const coordinate = pointKey(node.position);
  if (coordinate) {
    const match = indexes.byCoordinate.get(coordinate);
    if (match?.length === 1) return match[0];
  }
  return undefined;
}

function createNets(
  snapshot: RawSchematicSnapshot,
  indexes: PinIndexes,
  rules: NetNameNormalizationRules | undefined,
): { nets: NetModel[]; diagnostics: ModelDiagnostic[] } {
  const diagnostics: ModelDiagnostic[] = [];
  const nets: NetModel[] = [];
  for (const [netIndex, rawNet] of (snapshot.nets ?? []).entries()) {
    const normalization = normalizeNetName(rawNet.name, rules);
    const canonicalNetId = stableCanonicalId(
      'net',
      rawNet.runtimePrimitiveId,
      normalization.canonicalNetName,
      normalization.rawNetName,
      netIndex,
    );
    const nodes: NetNodeModel[] = [];
    const pinIds = new Set<string>();
    for (const [nodeIndex, rawNode] of (rawNet.nodes ?? []).entries()) {
      const pin = resolveNodePin(rawNode, indexes);
      const component = rawNode.componentPrimitiveId
        ? indexes.componentByRuntime.get(rawNode.componentPrimitiveId)
        : rawNode.componentReference
          ? indexes.componentByReference.get(rawNode.componentReference.toUpperCase())?.[0]
          : pin
            ? indexes.componentByRuntime.get(
                [...indexes.componentByRuntime.entries()].find(
                  ([, candidate]) => candidate.canonicalComponentId === pin.canonicalComponentId,
                )?.[0] ?? '',
              )
            : undefined;
      nodes.push({
        canonicalPinId: pin?.canonicalPinId,
        canonicalComponentId: pin?.canonicalComponentId ?? component?.canonicalComponentId,
        componentReference: cleanOptional(rawNode.componentReference) ?? pin?.reference,
        pinNumber: cleanOptional(rawNode.pinNumber) ?? pin?.number,
        position: rawNode.position ?? pin?.position,
        raw: { ...(rawNode.raw ?? {}) },
      });
      if (pin) {
        pinIds.add(pin.canonicalPinId);
        if (!pin.netIds.includes(canonicalNetId)) pin.netIds.push(canonicalNetId);
      } else {
        diagnostics.push({
          code: 'NET_NODE_UNRESOLVED',
          severity: 'warning',
          message: `Net node ${nodeIndex} on ${normalization.rawNetName || '<unnamed>'} could not be mapped to a canonical pin.`,
          canonicalNetId,
          evidence: {
            componentPrimitiveId: rawNode.componentPrimitiveId,
            componentReference: rawNode.componentReference,
            pinNumber: rawNode.pinNumber,
          },
        });
      }
    }
    nets.push({
      runtimePrimitiveId: cleanOptional(rawNet.runtimePrimitiveId),
      canonicalNetId,
      rawNetName: normalization.rawNetName,
      canonicalNetName: normalization.canonicalNetName,
      nameCategory: normalization.category,
      nameNormalizationRule: normalization.ruleId,
      excludedFromUserSignals: normalization.excluded,
      nodes,
      pinIds: [...pinIds],
      raw: { ...(rawNet.raw ?? {}) },
    });
  }
  return { nets, diagnostics };
}

function resolveNoConnectPin(
  input: NonNullable<RawSchematicSnapshot['noConnects']>[number],
  indexes: PinIndexes,
): PinModel | undefined {
  if (input.pinPrimitiveId) {
    const pin = indexes.byRuntimeId.get(input.pinPrimitiveId);
    if (pin) return pin;
  }
  const number = cleanOptional(input.pinNumber);
  if (number && input.componentReference) {
    const pins = indexes.byReferenceAndNumber.get(pinLookupKey(input.componentReference, number));
    if (pins?.length === 1) return pins[0];
  }
  const coordinate = pointKey(input.position);
  if (coordinate) {
    const pins = indexes.byCoordinate.get(coordinate);
    if (pins?.length === 1) return pins[0];
  }
  return undefined;
}

function createNoConnects(
  snapshot: RawSchematicSnapshot,
  indexes: PinIndexes,
): { noConnects: NoConnectModel[]; diagnostics: ModelDiagnostic[] } {
  const diagnostics: ModelDiagnostic[] = [];
  const noConnects = (snapshot.noConnects ?? []).map((raw, index): NoConnectModel => {
    const pin = resolveNoConnectPin(raw, indexes);
    if (pin) pin.deliberateNoConnect = true;
    else {
      diagnostics.push({
        code: 'NO_CONNECT_TARGET_UNRESOLVED',
        severity: 'warning',
        message: `No-connect marker ${raw.runtimePrimitiveId} does not resolve to exactly one pin.`,
        evidence: {
          componentReference: raw.componentReference,
          pinNumber: raw.pinNumber,
          position: raw.position,
        },
      });
    }
    return {
      runtimePrimitiveId: raw.runtimePrimitiveId,
      canonicalNoConnectId: stableCanonicalId('nc', raw.runtimePrimitiveId, index),
      canonicalPinId: pin?.canonicalPinId,
      componentReference: cleanOptional(raw.componentReference) ?? pin?.reference,
      pinNumber: cleanOptional(raw.pinNumber) ?? pin?.number,
      position: raw.position ?? pin?.position,
      raw: { ...(raw.raw ?? {}) },
    };
  });
  return { noConnects, diagnostics };
}

function createWires(
  snapshot: RawSchematicSnapshot,
  nets: NetModel[],
  rules: NetNameNormalizationRules | undefined,
): WireModel[] {
  return (snapshot.wires ?? []).map((raw, index) => {
    const normalization = raw.netName == null ? undefined : normalizeNetName(raw.netName, rules);
    const net = normalization
      ? nets.find(
          (candidate) =>
            candidate.rawNetName === normalization.rawNetName ||
            (candidate.canonicalNetName !== null &&
              candidate.canonicalNetName === normalization.canonicalNetName),
        )
      : undefined;
    return {
      runtimePrimitiveId: raw.runtimePrimitiveId,
      canonicalWireId: stableCanonicalId('wire', raw.runtimePrimitiveId, index),
      rawNetName: normalization?.rawNetName,
      canonicalNetName: normalization?.canonicalNetName,
      canonicalNetId: net?.canonicalNetId,
      points: raw.points.map((point) => ({ ...point })),
      raw: { ...(raw.raw ?? {}) },
    };
  });
}

function createLabels(
  snapshot: RawSchematicSnapshot,
  rules: NetNameNormalizationRules | undefined,
): NetLabelModel[] {
  return (snapshot.labels ?? []).map((raw, index) => {
    const normalization = normalizeNetName(raw.netName, rules);
    return {
      runtimePrimitiveId: raw.runtimePrimitiveId,
      canonicalLabelId: stableCanonicalId('label', raw.runtimePrimitiveId, index),
      rawNetName: normalization.rawNetName,
      canonicalNetName: normalization.canonicalNetName,
      position: { ...raw.position },
      rotation: raw.rotation,
      raw: { ...(raw.raw ?? {}) },
    };
  });
}

function createPowerSymbols(
  snapshot: RawSchematicSnapshot,
  rules: NetNameNormalizationRules | undefined,
): PowerSymbolModel[] {
  return (snapshot.powerSymbols ?? []).map((raw, index) => {
    const normalization = normalizeNetName(raw.netName, rules);
    return {
      runtimePrimitiveId: raw.runtimePrimitiveId,
      canonicalPowerSymbolId: stableCanonicalId('pwr', raw.runtimePrimitiveId, index),
      rawNetName: normalization.rawNetName,
      canonicalNetName: normalization.canonicalNetName,
      position: raw.position ?? undefined,
      isPowerFlag: raw.isPowerFlag === true || normalization.excluded,
      raw: { ...(raw.raw ?? {}) },
    };
  });
}

function createBuses(snapshot: RawSchematicSnapshot): BusModel[] {
  return (snapshot.buses ?? []).map((raw, index) => ({
    runtimePrimitiveId: raw.runtimePrimitiveId,
    canonicalBusId: stableCanonicalId('bus', raw.runtimePrimitiveId, index),
    name: cleanOptional(raw.name),
    members: [...(raw.members ?? [])],
    points: (raw.points ?? []).map((point) => ({ ...point })),
    raw: { ...(raw.raw ?? {}) },
  }));
}

function createSheets(snapshot: RawSchematicSnapshot, documentId: string): SheetModel[] {
  const inputSheets = snapshot.sheets ?? [];
  if (inputSheets.length === 0) {
    return [
      {
        canonicalSheetId: stableCanonicalId('sheet', documentId, 'root'),
        name: snapshot.document?.name ?? 'Sheet 1',
        portNames: [],
        raw: {},
      },
    ];
  }
  return inputSheets.map((raw, index) => ({
    runtimePrimitiveId: cleanOptional(raw.runtimePrimitiveId),
    canonicalSheetId: stableCanonicalId('sheet', raw.runtimePrimitiveId, raw.name, index),
    name: raw.name,
    bounds: raw.bounds ?? undefined,
    parentSheetId: cleanOptional(raw.parentSheetId),
    portNames: [...(raw.portNames ?? [])],
    raw: { ...(raw.raw ?? {}) },
  }));
}

function createTexts(snapshot: RawSchematicSnapshot): TextModel[] {
  return (snapshot.texts ?? []).map((raw, index) => ({
    runtimePrimitiveId: raw.runtimePrimitiveId,
    canonicalTextId: stableCanonicalId('text', raw.runtimePrimitiveId, index),
    content: raw.content,
    position: { ...raw.position },
    bounds: raw.bounds ?? undefined,
    rotation: raw.rotation,
    raw: { ...(raw.raw ?? {}) },
  }));
}

export function buildSchematicModel(
  input: unknown,
  options: BuildSchematicModelOptions = {},
): SchematicModel {
  const snapshot = parseRawSchematicSnapshot(input);
  const documentId =
    cleanOptional(snapshot.document?.documentId) ??
    stableCanonicalId(
      'doc',
      snapshot.document?.runtimeDocumentId,
      snapshot.document?.projectId,
      snapshot.document?.name,
    );
  const componentResult = createComponents(snapshot);
  const indexes = createPinIndexes(componentResult.components, componentResult.pins);
  const noConnectResult = createNoConnects(snapshot, indexes);
  const netResult = createNets(snapshot, indexes, options.netNameRules);
  const diagnostics = [
    ...componentResult.diagnostics,
    ...noConnectResult.diagnostics,
    ...netResult.diagnostics,
    ...(snapshot.unsupportedPrimitives ?? []).map(
      (primitive): ModelDiagnostic => ({
        code: 'UNSUPPORTED_PRIMITIVE',
        severity: 'warning',
        message: `Unsupported primitive type: ${primitive.type}.`,
        evidence: { ...primitive },
      }),
    ),
  ];

  const model: SchematicModel = {
    schemaVersion: '1.0',
    modelHash: '',
    document: {
      runtimeDocumentId: cleanOptional(snapshot.document?.runtimeDocumentId),
      projectId: cleanOptional(snapshot.document?.projectId),
      documentId,
      name: cleanOptional(snapshot.document?.name),
      activeSheetId: cleanOptional(snapshot.document?.activeSheetId),
      sourceFormat: cleanOptional(snapshot.document?.sourceFormat),
      generatedAt: cleanOptional(snapshot.document?.generatedAt),
    },
    components: componentResult.components,
    pins: componentResult.pins,
    nets: netResult.nets,
    wires: createWires(snapshot, netResult.nets, options.netNameRules),
    labels: createLabels(snapshot, options.netNameRules),
    powerSymbols: createPowerSymbols(snapshot, options.netNameRules),
    noConnects: noConnectResult.noConnects,
    buses: createBuses(snapshot),
    sheets: createSheets(snapshot, documentId),
    texts: createTexts(snapshot),
    diagnostics,
  };
  model.modelHash = canonicalModelHash(model);
  return model;
}

export function componentIdentityKey(component: ComponentModel): string {
  return componentLookupKey(component.runtimePrimitiveId, component.reference);
}
