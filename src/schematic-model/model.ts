import { z } from 'zod';

export const ComponentKindSchema = z.enum([
  'part',
  'power-symbol',
  'power-flag',
  'net-label',
  'net-port',
  'sheet-frame',
  'annotation',
  'helper',
  'unknown',
]);
export type ComponentKind = z.infer<typeof ComponentKindSchema>;

export const SymbolSourceSchema = z.enum(['native', 'imported', 'unknown']);
export type SymbolSource = z.infer<typeof SymbolSourceSchema>;

export const NetKindSchema = z.enum(['signal', 'power', 'ground', 'power-flag', 'unnamed']);
export type NetKind = z.infer<typeof NetKindSchema>;

export const CanonicalNodeSchema = z.object({
  componentRef: z.string(),
  pin: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  source: z.string().optional(),
});
export type CanonicalNode = z.infer<typeof CanonicalNodeSchema>;

export const CanonicalNetSchema = z.object({
  id: z.string().min(1),
  canonicalNetName: z.string().min(1),
  rawNetNames: z.array(z.string()).min(1),
  kind: NetKindSchema,
  nodes: z.array(CanonicalNodeSchema),
  normalizationRules: z.array(z.string()),
  imported: z.boolean(),
});
export type CanonicalNet = z.infer<typeof CanonicalNetSchema>;

export const CanonicalComponentSchema = z.object({
  canonicalComponentId: z.string().min(1),
  runtimePrimitiveId: z.string().optional(),
  reference: z.string(),
  rawReference: z.string(),
  annotated: z.boolean(),
  unit: z.string().optional(),
  symbolSource: SymbolSourceSchema,
  componentKind: ComponentKindSchema,
  bomEligible: z.boolean(),
  electricalEligible: z.boolean(),
  rawValue: z.string(),
  value: z.string(),
  rawFootprint: z.string(),
  footprint: z.string(),
  manufacturerPart: z.string().optional(),
  manufacturer: z.string().optional(),
  lcsc: z.string().optional(),
  datasheet: z.string().optional(),
  deviceName: z.string().optional(),
  symbolName: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  rotation: z.number().optional(),
});
export type CanonicalComponent = z.infer<typeof CanonicalComponentSchema>;

export const ModelDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
  componentId: z.string().optional(),
  componentRef: z.string().optional(),
  netName: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ModelDiagnostic = z.infer<typeof ModelDiagnosticSchema>;

export const SchematicDocumentSchema = z.object({
  projectId: z.string().optional(),
  schematicName: z.string().optional(),
  pageName: z.string().optional(),
});
export type SchematicDocument = z.infer<typeof SchematicDocumentSchema>;

export const SchematicModelSchema = z.object({
  schemaVersion: z.literal('schematic-model/v1'),
  document: SchematicDocumentSchema,
  components: z.array(CanonicalComponentSchema),
  nets: z.array(CanonicalNetSchema),
  diagnostics: z.array(ModelDiagnosticSchema),
  summary: z.object({
    componentCount: z.number().int().nonnegative(),
    bomComponentCount: z.number().int().nonnegative(),
    electricalComponentCount: z.number().int().nonnegative(),
    netCount: z.number().int().nonnegative(),
    importedComponentCount: z.number().int().nonnegative(),
  }),
});
export type SchematicModel = z.infer<typeof SchematicModelSchema>;
