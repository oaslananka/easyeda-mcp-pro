import { isRecord, logRecoverableError } from './utils.js';

export interface SchematicComponentInspectionOperationDependencies {
  readFirstPath<T>(paths: readonly string[]): T | undefined;
  readState(value: unknown, key: string): unknown;
}

export interface SchematicComponentInspectionOperations {
  listComponents(limit?: number, offset?: number): Promise<unknown>;
}

function nativeScalarString(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}

function readOtherPropertyValue(
  otherProperty: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!otherProperty) return undefined;
  const exact = nativeScalarString(otherProperty[key]).trim();
  if (exact) return exact;

  const normalizedKey = key.trim().toLowerCase();
  for (const [candidateKey, candidateValue] of Object.entries(otherProperty)) {
    const value = nativeScalarString(candidateValue).trim();
    if (candidateKey.trim().toLowerCase() === normalizedKey && value) return value;
  }
  return undefined;
}

function resolveComponentDisplayValue(
  rawName: unknown,
  otherProperty: Record<string, unknown> | undefined,
  manufacturerId: string,
  deviceName: string,
): string {
  const name = nativeScalarString(rawName).trim();
  const expression = /^=\{(.+)\}$/.exec(name);
  if (expression) {
    const propertyName = expression[1].trim();
    const propertyValue = readOtherPropertyValue(otherProperty, propertyName);
    if (propertyValue) return propertyValue;
    if (propertyName.toLowerCase() === 'manufacturer part' && manufacturerId) {
      return manufacturerId;
    }
    return manufacturerId || deviceName || name;
  }
  if (name) return name;
  return readOtherPropertyValue(otherProperty, 'Value') || manufacturerId || deviceName || '';
}

function readRecordState(
  component: unknown,
  key: string,
  readState: SchematicComponentInspectionOperationDependencies['readState'],
): Record<string, unknown> | undefined {
  const value = readState(component, key);
  return isRecord(value) ? value : undefined;
}

export function createSchematicComponentInspectionOperations({
  readFirstPath,
  readState,
}: SchematicComponentInspectionOperationDependencies): SchematicComponentInspectionOperations {
  function isBomComponent(component: unknown): boolean {
    const componentType = nativeScalarString(readState(component, 'ComponentType')).toLowerCase();
    if (componentType === 'sheet' || componentType === 'netflag' || componentType === 'netport') {
      return false;
    }
    const deviceName = nativeScalarString(readRecordState(component, 'Component', readState)?.name);
    return !deviceName.startsWith('Drawing-Symbol_');
  }

  async function resolveFootprint(
    component: unknown,
    otherProperty: Record<string, unknown> | undefined,
    footprintClass: { get(uuid: unknown, libraryUuid: unknown): Promise<unknown> } | undefined,
  ): Promise<string> {
    const footprintInfo = readRecordState(component, 'Footprint', readState);
    let footprint = nativeScalarString(footprintInfo?.name).trim();
    if (!footprint && footprintInfo?.uuid && footprintClass) {
      try {
        const resolved = await footprintClass.get(footprintInfo.uuid, footprintInfo.libraryUuid);
        footprint = nativeScalarString(isRecord(resolved) ? resolved.name : undefined).trim();
      } catch (error) {
        logRecoverableError('failed to resolve component footprint', error);
      }
    }
    return (
      footprint ||
      readOtherPropertyValue(otherProperty, 'Footprint') ||
      readOtherPropertyValue(otherProperty, 'Supplier Footprint') ||
      ''
    );
  }

  async function mapComponent(
    component: unknown,
    footprintClass: { get(uuid: unknown, libraryUuid: unknown): Promise<unknown> } | undefined,
  ): Promise<Record<string, unknown>> {
    const device = readRecordState(component, 'Component', readState);
    const symbol = readRecordState(component, 'Symbol', readState);
    const otherProperty = readRecordState(component, 'OtherProperty', readState);
    const manufacturerId = nativeScalarString(readState(component, 'ManufacturerId'));
    const deviceName = nativeScalarString(device?.name);

    return {
      primitiveId: nativeScalarString(readState(component, 'PrimitiveId')),
      reference: nativeScalarString(readState(component, 'Designator')),
      value: resolveComponentDisplayValue(
        readState(component, 'Name'),
        otherProperty,
        manufacturerId,
        deviceName,
      ),
      footprint: await resolveFootprint(component, otherProperty, footprintClass),
      lcsc: nativeScalarString(readState(component, 'SupplierId')),
      manufacturer: nativeScalarString(readState(component, 'Manufacturer')),
      manufacturerId,
      datasheet:
        readOtherPropertyValue(otherProperty, 'Datasheet') ||
        readOtherPropertyValue(otherProperty, 'datasheet') ||
        '',
      deviceUuid: nativeScalarString(device?.uuid),
      deviceLibraryUuid: nativeScalarString(device?.libraryUuid),
      deviceName,
      symbolName: nativeScalarString(symbol?.name),
      x: readState(component, 'X'),
      y: readState(component, 'Y'),
      rotation: readState(component, 'Rotation'),
    };
  }

  async function listComponents(limit?: number, offset = 0): Promise<unknown> {
    const componentClass = readFirstPath<{
      getAll(include?: unknown, recursive?: boolean): Promise<unknown[] | null | undefined>;
    }>(['SCH_PrimitiveComponent', 'SCH_PrimitiveComponent3', 'sch_PrimitiveComponent']);
    const footprintClass = readFirstPath<{
      get(uuid: unknown, libraryUuid: unknown): Promise<unknown>;
    }>(['LIB_Footprint', 'lib_Footprint']);

    if (!componentClass) {
      throw new Error('SCH_PrimitiveComponent class not found in EasyEDA Pro API');
    }

    const allComponents = (await componentClass.getAll(undefined, true)) || [];
    const bomComponents = allComponents.filter(isBomComponent);
    const total = bomComponents.length;
    const start = Math.max(0, offset);
    const end = typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
    const selected = bomComponents.slice(start, end);
    const items: Array<Record<string, unknown>> = [];
    for (const component of selected) {
      items.push(await mapComponent(component, footprintClass));
    }
    return { total, items };
  }

  return { listComponents };
}
