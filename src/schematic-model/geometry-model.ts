/**
 * Canonical, runtime-independent schematic representation.
 *
 * The bridge is deliberately allowed to return several EasyEDA/runtime shapes.
 * Everything below is normalized before higher-level validation or planning sees it.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds extends Point {
  width: number;
  height: number;
}

export type SymbolSource =
  | 'native-easyeda'
  | 'kicad-import'
  | 'altium-import'
  | 'custom-import'
  | 'unknown-import'
  | 'virtual'
  | 'unknown';

export type ComponentKind =
  | 'part'
  | 'unannotated-part'
  | 'power-symbol'
  | 'power-flag'
  | 'net-port'
  | 'no-connect'
  | 'sheet-frame'
  | 'annotation'
  | 'virtual-helper'
  | 'unknown';

export type ClassificationConfidence = 'high' | 'medium' | 'low';

export type BasePinElectricalType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'passive'
  | 'powerInput'
  | 'powerOutput'
  | 'openCollector'
  | 'openEmitter'
  | 'triState'
  | 'noConnect'
  | 'unspecified';

export type PinElectricalType = BasePinElectricalType | 'hidden' | 'stacked' | 'internal';

export type AttributeResolution =
  'literal' | 'resolved-expression' | 'unresolved-expression' | 'missing';

export interface ResolvedAttribute {
  raw?: string;
  resolved?: string;
  expression?: string;
  resolution: AttributeResolution;
}

export interface ComponentMetadata {
  value: ResolvedAttribute;
  manufacturerPart: ResolvedAttribute;
  lcscNumber: ResolvedAttribute;
  footprint: ResolvedAttribute;
  deviceName: ResolvedAttribute;
  description: ResolvedAttribute;
  datasheet: ResolvedAttribute;
  dnp: boolean;
  rawAttributes: Record<string, unknown>;
}

export interface SchematicDocumentModel {
  runtimeDocumentId?: string;
  projectId?: string;
  documentId: string;
  name?: string;
  activeSheetId?: string;
  sourceFormat?: string;
  generatedAt?: string;
}

export interface PinModel {
  runtimePrimitiveId?: string;
  canonicalPinId: string;
  canonicalComponentId: string;
  reference?: string;
  unit?: string;
  number: string;
  name?: string;
  electricalType: PinElectricalType;
  baseElectricalType: BasePinElectricalType;
  position?: Point;
  hidden: boolean;
  stacked: boolean;
  stackGroup?: string;
  internallyConnected: boolean;
  powerGroup?: string;
  required: boolean;
  deliberateNoConnect: boolean;
  noConnectAllowed: boolean;
  mechanicallyUnused: boolean;
  pullRequirement?: 'up' | 'down' | 'either';
  differentialPair?: string;
  differentialPolarity?: 'positive' | 'negative';
  netIds: string[];
  raw: Record<string, unknown>;
}

export interface ComponentModel {
  runtimePrimitiveId: string;
  canonicalComponentId: string;
  reference?: string;
  unit?: string;
  symbolSource: SymbolSource;
  symbolPrefix?: string;
  componentKind: ComponentKind;
  classificationConfidence: ClassificationConfidence;
  classificationReasons: string[];
  bomEligible: boolean;
  electricalEligible: boolean;
  dnp: boolean;
  position?: Point;
  bounds?: Bounds;
  pinIds: string[];
  metadata: ComponentMetadata;
  rawComponentType?: string;
  raw: Record<string, unknown>;
}

export interface NetNodeModel {
  canonicalPinId?: string;
  canonicalComponentId?: string;
  componentReference?: string;
  pinNumber?: string;
  position?: Point;
  raw: Record<string, unknown>;
}

export type NetNameCategory = 'ground' | 'power' | 'signal' | 'power-flag' | 'unnamed';

export interface NetModel {
  runtimePrimitiveId?: string;
  canonicalNetId: string;
  rawNetName: string;
  canonicalNetName: string | null;
  nameCategory: NetNameCategory;
  nameNormalizationRule?: string;
  excludedFromUserSignals: boolean;
  nodes: NetNodeModel[];
  pinIds: string[];
  raw: Record<string, unknown>;
}

export interface WireModel {
  runtimePrimitiveId: string;
  canonicalWireId: string;
  rawNetName?: string;
  canonicalNetName?: string | null;
  canonicalNetId?: string;
  points: Point[];
  raw: Record<string, unknown>;
}

export interface NetLabelModel {
  runtimePrimitiveId: string;
  canonicalLabelId: string;
  rawNetName: string;
  canonicalNetName: string | null;
  position: Point;
  rotation?: number;
  raw: Record<string, unknown>;
}

export interface PowerSymbolModel {
  runtimePrimitiveId: string;
  canonicalPowerSymbolId: string;
  rawNetName: string;
  canonicalNetName: string | null;
  position?: Point;
  isPowerFlag: boolean;
  raw: Record<string, unknown>;
}

export interface NoConnectModel {
  runtimePrimitiveId: string;
  canonicalNoConnectId: string;
  canonicalPinId?: string;
  componentReference?: string;
  pinNumber?: string;
  position?: Point;
  raw: Record<string, unknown>;
}

export interface BusModel {
  runtimePrimitiveId: string;
  canonicalBusId: string;
  name?: string;
  members: string[];
  points: Point[];
  raw: Record<string, unknown>;
}

export interface SheetModel {
  runtimePrimitiveId?: string;
  canonicalSheetId: string;
  name: string;
  bounds?: Bounds;
  parentSheetId?: string;
  portNames: string[];
  raw: Record<string, unknown>;
}

export interface TextModel {
  runtimePrimitiveId: string;
  canonicalTextId: string;
  content: string;
  position: Point;
  bounds?: Bounds;
  rotation?: number;
  raw: Record<string, unknown>;
}

export type ModelDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ModelDiagnostic {
  code: string;
  severity: ModelDiagnosticSeverity;
  message: string;
  path?: string;
  canonicalComponentId?: string;
  canonicalPinId?: string;
  canonicalNetId?: string;
  evidence?: Record<string, unknown>;
}

export interface SchematicModel {
  schemaVersion: '1.0';
  modelHash: string;
  document: SchematicDocumentModel;
  components: ComponentModel[];
  pins: PinModel[];
  nets: NetModel[];
  wires: WireModel[];
  labels: NetLabelModel[];
  powerSymbols: PowerSymbolModel[];
  noConnects: NoConnectModel[];
  buses: BusModel[];
  sheets: SheetModel[];
  texts: TextModel[];
  diagnostics: ModelDiagnostic[];
}

export interface RawPinInput {
  runtimePrimitiveId?: string;
  number: string | number;
  name?: string | null;
  electricalType?: string | null;
  position?: Point | null;
  hidden?: boolean;
  stacked?: boolean;
  stackGroup?: string | null;
  internallyConnected?: boolean;
  powerGroup?: string | null;
  required?: boolean;
  deliberateNoConnect?: boolean;
  noConnectAllowed?: boolean;
  mechanicallyUnused?: boolean;
  pullRequirement?: 'up' | 'down' | 'either' | null;
  differentialPair?: string | null;
  differentialPolarity?: 'positive' | 'negative' | null;
  unit?: string | number | null;
  raw?: Record<string, unknown>;
}

export interface RawComponentInput {
  runtimePrimitiveId: string;
  reference?: string | null;
  unit?: string | number | null;
  componentType?: string | null;
  symbolSource?: string | null;
  symbolPrefix?: string | null;
  deviceName?: string | null;
  symbolName?: string | null;
  position?: Point | null;
  bounds?: Bounds | null;
  attributes?: Record<string, unknown>;
  resolvedAttributes?: Record<string, unknown>;
  pins?: RawPinInput[];
  dnp?: boolean;
  raw?: Record<string, unknown>;
}

export interface RawNetNodeInput {
  componentPrimitiveId?: string;
  componentReference?: string;
  pinNumber?: string | number;
  pinPrimitiveId?: string;
  position?: Point | null;
  raw?: Record<string, unknown>;
}

export interface RawNetInput {
  runtimePrimitiveId?: string;
  name?: string | null;
  nodes?: RawNetNodeInput[];
  raw?: Record<string, unknown>;
}

export interface RawWireInput {
  runtimePrimitiveId: string;
  netName?: string | null;
  points: Point[];
  raw?: Record<string, unknown>;
}

export interface RawLabelInput {
  runtimePrimitiveId: string;
  netName: string;
  position: Point;
  rotation?: number;
  raw?: Record<string, unknown>;
}

export interface RawPowerSymbolInput {
  runtimePrimitiveId: string;
  netName: string;
  position?: Point | null;
  isPowerFlag?: boolean;
  raw?: Record<string, unknown>;
}

export interface RawNoConnectInput {
  runtimePrimitiveId: string;
  componentReference?: string;
  pinNumber?: string | number;
  pinPrimitiveId?: string;
  position?: Point | null;
  raw?: Record<string, unknown>;
}

export interface RawBusInput {
  runtimePrimitiveId: string;
  name?: string;
  members?: string[];
  points?: Point[];
  raw?: Record<string, unknown>;
}

export interface RawSheetInput {
  runtimePrimitiveId?: string;
  name: string;
  bounds?: Bounds | null;
  parentSheetId?: string;
  portNames?: string[];
  raw?: Record<string, unknown>;
}

export interface RawTextInput {
  runtimePrimitiveId: string;
  content: string;
  position: Point;
  bounds?: Bounds | null;
  rotation?: number;
  raw?: Record<string, unknown>;
}

export interface RawSchematicSnapshot {
  document?: {
    runtimeDocumentId?: string;
    projectId?: string;
    documentId?: string;
    name?: string;
    activeSheetId?: string;
    sourceFormat?: string;
    generatedAt?: string;
  };
  components?: RawComponentInput[];
  nets?: RawNetInput[];
  wires?: RawWireInput[];
  labels?: RawLabelInput[];
  powerSymbols?: RawPowerSymbolInput[];
  noConnects?: RawNoConnectInput[];
  buses?: RawBusInput[];
  sheets?: RawSheetInput[];
  texts?: RawTextInput[];
  unsupportedPrimitives?: Array<{ type: string; runtimePrimitiveId?: string }>;
}
