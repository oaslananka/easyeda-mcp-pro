import type { ApiRuntime } from './api-runtime.js';
import type {
  PublicTextAlignMode,
  SchematicPrimitiveSnapshot,
  SchematicPrimitiveSnapshotKind,
} from './schematic-transaction-operations.js';

export interface SchematicSnapshotRecreationDependencies {
  callFirst: ApiRuntime['callFirst'];
  createBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error;
  requirePublicTextAlignMode(value: unknown, field?: string): PublicTextAlignMode;
}

export interface SchematicSnapshotRecreator {
  supportedKinds: readonly SchematicPrimitiveSnapshotKind[];
  create(snapshot: SchematicPrimitiveSnapshot): Promise<unknown>;
}

const SUPPORTED_KINDS = Object.freeze([
  'circle',
  'polygon',
  'rectangle',
  'text',
  'wire',
] satisfies SchematicPrimitiveSnapshotKind[]);

function requiredSnapshotNumber(
  property: Record<string, unknown>,
  key: string,
  createBridgeError: SchematicSnapshotRecreationDependencies['createBridgeError'],
): number {
  const value = property[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createBridgeError(
      'INVALID_PARAMS',
      `Snapshot property ${key} must be a finite number`,
      'Pass an unmodified snapshot returned by schematic.getPrimitiveSnapshot.',
    );
  }
  return value;
}

export function createSchematicSnapshotRecreator(
  dependencies: SchematicSnapshotRecreationDependencies,
): SchematicSnapshotRecreator {
  const { callFirst, createBridgeError, requirePublicTextAlignMode } = dependencies;
  const requiredNumber = (property: Record<string, unknown>, key: string) =>
    requiredSnapshotNumber(property, key, createBridgeError);

  async function create(snapshot: SchematicPrimitiveSnapshot): Promise<unknown> {
    const property = snapshot.property;
    switch (snapshot.primitiveKind) {
      case 'wire':
        return callFirst(
          ['SCH_PrimitiveWire.create', 'sch_PrimitiveWire.create'],
          property.line,
          property.net,
          property.color,
          property.lineWidth,
          property.lineType,
        );
      case 'text': {
        const rawY = requiredNumber(property, 'y');
        return callFirst(
          ['SCH_PrimitiveText.create', 'sch_PrimitiveText.create'],
          requiredNumber(property, 'x'),
          -rawY,
          property.content,
          property.rotation ?? 0,
          property.color ?? '#000000',
          property.fontName ?? 'Arial',
          property.fontSize ?? 20,
          property.bold ?? false,
          property.italic ?? false,
          property.underline ?? false,
          requirePublicTextAlignMode(property.alignMode, 'snapshot.property.alignMode'),
        );
      }
      case 'rectangle': {
        const rawY = requiredNumber(property, 'y');
        return callFirst(
          ['SCH_PrimitiveRectangle.create', 'sch_PrimitiveRectangle.create'],
          requiredNumber(property, 'x'),
          -rawY,
          requiredNumber(property, 'width'),
          requiredNumber(property, 'height'),
          property.cornerRadius ?? 0,
          property.rotation ?? 0,
          property.color ?? '#000000',
          property.fillColor ?? 'none',
          property.lineWidth ?? 1,
          property.lineType ?? 0,
          property.fillStyle ?? 'none',
        );
      }
      case 'circle':
        return callFirst(
          ['SCH_PrimitiveCircle.create', 'sch_PrimitiveCircle.create'],
          requiredNumber(property, 'centerX'),
          requiredNumber(property, 'centerY'),
          requiredNumber(property, 'radius'),
          property.color ?? '#000000',
          property.fillColor ?? 'none',
          property.lineWidth ?? 1,
          property.lineType ?? 0,
          property.fillStyle ?? 'none',
        );
      case 'polygon':
        return callFirst(
          ['SCH_PrimitivePolygon.create', 'sch_PrimitivePolygon.create'],
          property.line,
          property.color ?? '#000000',
          property.fillColor ?? 'none',
          property.lineWidth ?? 1,
          property.lineType ?? 0,
        );
      case 'component':
      case 'netflag':
      case 'netport':
        throw createBridgeError(
          'UNSUPPORTED_RUNTIME',
          `Delete rollback is not supported for ${snapshot.primitiveKind} primitives`,
          'Use transaction-backed modify, or avoid deleting components/net flags/net ports until a complete creation descriptor is available.',
        );
    }
  }

  return { supportedKinds: SUPPORTED_KINDS, create };
}
