import type { ApiRuntime } from './api-runtime.js';
import type { SchematicComponentInspectionOperations } from './schematic-component-inspection.js';
import type { SchematicInspectionOperations } from './schematic-inspection.js';
import { assertSchematicReadScopeSupported } from './schematic-read-scope.js';
import type {
  SchematicPrimitiveSnapshotKind,
  SchematicTransactionOperations,
} from './schematic-transaction-operations.js';

interface SchematicNetNode {
  component: string;
  pin: string;
}

interface SchematicNetEntry {
  netName: string;
  nodes: SchematicNetNode[];
}

interface FloatingPinResult {
  floatingPins: Array<{ primitiveId: string; designator: string; pinNumber: string }>;
  partRefs: string[];
}

interface SchematicCheckResult {
  errorCount: number;
  warningCount: number;
  passed: boolean;
}

export interface ReadOnlyOperationsDependencies {
  callFirst: ApiRuntime['callFirst'];
  schematicTransactionOperations: SchematicTransactionOperations;
  schematicComponentInspection: SchematicComponentInspectionOperations;
  schematicInspection: SchematicInspectionOperations;
  listNets: () => Promise<SchematicNetEntry[]>;
  getNetDetail: (netName: string, operationTimeoutMs: unknown) => Promise<unknown>;
  getPinNoConnect: (componentPrimitiveId: string, pinNumber: string) => Promise<unknown>;
  findFloatingPins: () => Promise<FloatingPinResult>;
  runSchematicCheck: () => Promise<SchematicCheckResult>;
  logRecoverableError: (message: string, error: unknown) => void;
}

export interface ReadOnlyOperations {
  listNets(params?: Record<string, unknown>): Promise<unknown>;
  getNetDetail(params: Record<string, unknown>): Promise<unknown>;
  getPrimitiveSnapshot(params: Record<string, unknown>): Promise<unknown>;
  listPrimitiveIds(params: Record<string, unknown>): Promise<unknown>;
  listComponents(params: Record<string, unknown>): Promise<unknown>;
  getSheetInfo(params?: Record<string, unknown>): Promise<unknown>;
  primitiveBounds(params: Record<string, unknown>): Promise<unknown>;
  searchDevice(params: Record<string, unknown>): Promise<unknown>;
  listRectangles(): Promise<unknown>;
  getPinNoConnect(params: Record<string, unknown>): Promise<unknown>;
  validateNetlist(params?: Record<string, unknown>): Promise<unknown>;
  getDeviceByLcscId(params: Record<string, unknown>): Promise<unknown>;
  getDeviceSubParts(params: Record<string, unknown>): Promise<unknown>;
  generateBom(params: Record<string, unknown>): Promise<unknown>;
  validateBom(): Promise<unknown>;
  inventorySearch(): Promise<unknown>;
  inventoryGetPrice(): Promise<unknown>;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function offsetNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function expectedSnapshotKind(value: unknown): SchematicPrimitiveSnapshotKind | undefined {
  return typeof value === 'string' ? (value as SchematicPrimitiveSnapshotKind) : undefined;
}

function validatedNetEntry(entry: SchematicNetEntry, connectedRefs: Set<string>) {
  const refs = [...new Set((entry.nodes || []).map((node) => node.component))];
  const pins = (entry.nodes || []).map((node) => node.pin);
  for (const ref of refs) connectedRefs.add(ref);
  return { netName: entry.netName, refs, pins, hasNetFlag: true };
}

function connectivityWarnings(
  floatingPins: FloatingPinResult['floatingPins'],
  partRefs: string[],
  connectedRefs: Set<string>,
): string[] {
  const warnings: string[] = [];
  if (floatingPins.length > 0) {
    warnings.push(`${floatingPins.length} pin(s) are not connected to any net.`);
  }
  if (connectedRefs.size < partRefs.length) {
    warnings.push(`${partRefs.length - connectedRefs.size} component(s) have no net connections.`);
  }
  return warnings;
}

async function nativeErcSummary(
  dependencies: ReadOnlyOperationsDependencies,
  warnings: string[],
): Promise<SchematicCheckResult | undefined> {
  try {
    const result = await dependencies.runSchematicCheck();
    if (result.errorCount > 0) {
      warnings.push(
        `Native ERC reports ${result.errorCount} error(s): the inferred connectivity above may ` +
          'include pins that overlap without a wire (not truly connected). Run erc_run or ' +
          "check EasyEDA's DRC panel for authoritative, per-violation detail.",
      );
    }
    return {
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      passed: result.passed,
    };
  } catch (error) {
    dependencies.logRecoverableError('validateNetlist: native ERC cross-check failed', error);
    return undefined;
  }
}

async function validateNetlist(dependencies: ReadOnlyOperationsDependencies): Promise<unknown> {
  const netlistData = await dependencies.listNets();
  const connectedRefs = new Set<string>();
  const nets = netlistData.map((entry) => validatedNetEntry(entry, connectedRefs));
  const { floatingPins, partRefs } = await dependencies.findFloatingPins();
  const warnings = connectivityWarnings(floatingPins, partRefs, connectedRefs);
  const nativeErc = await nativeErcSummary(dependencies, warnings);
  return {
    nets,
    floatingPins,
    wiresWithoutNetlist: [],
    nativeErc,
    warnings,
  };
}

function bomGroupKey(component: any, groupBy: unknown): string {
  const primary =
    groupBy === 'lcsc'
      ? component.lcsc || component.value
      : groupBy === 'footprint'
        ? component.footprint || 'no-footprint'
        : component.value || 'no-value';
  // A display grouping preference must never silently combine BOM parts
  // with distinct footprints, manufacturer part numbers or vendor IDs.
  return JSON.stringify([
    primary,
    component.value || '',
    component.footprint || '',
    component.lcsc || '',
    component.manufacturer || '',
    component.manufacturerId || '',
  ]);
}

function bomIdentityError(reason: string): Error {
  return new Error(`BOM_IDENTITY_AMBIGUOUS: ${reason}`);
}

function verifiedMultiUnitPair(first: any, next: any, existingSubParts: Set<string>): void {
  if (
    !first.deviceUuid ||
    !first.deviceLibraryUuid ||
    first.deviceUuid !== next.deviceUuid ||
    first.deviceLibraryUuid !== next.deviceLibraryUuid
  ) {
    throw bomIdentityError('same physical identity has missing or inconsistent device/library');
  }
  if (bomGroupKey(first, 'value') !== bomGroupKey(next, 'value')) {
    throw bomIdentityError('linked schematic units disagree on the physical BOM part');
  }
  if (
    typeof next.subPartName !== 'string' ||
    !next.subPartName.trim() ||
    existingSubParts.has(next.subPartName)
  ) {
    throw bomIdentityError('linked units have missing or repeated subpart identity');
  }
  existingSubParts.add(next.subPartName);
}

function bomReference(component: any): string {
  const reference = typeof component.reference === 'string' ? component.reference.trim() : '';
  if (!reference) throw bomIdentityError('part has no verified designator');
  return reference;
}

function bomUniqueId(component: any): string {
  return typeof component.uniqueId === 'string' ? component.uniqueId.trim() : '';
}

function linkedBOMUnit(
  firstByReference: any | undefined,
  firstByUniqueId: any | undefined,
  next: any,
  uniqueId: string,
  parts: Map<string, Set<string>>,
): boolean {
  if (!firstByReference && !firstByUniqueId) return false;
  if (!uniqueId || firstByReference !== firstByUniqueId || !firstByReference) {
    throw bomIdentityError('duplicate designator or mismatched physical unique ID');
  }
  const knownParts = parts.get(uniqueId);
  if (!knownParts?.size) throw bomIdentityError('missing first subpart identity');
  verifiedMultiUnitPair(firstByReference, next, knownParts);
  return true;
}

function physicalBomComponents(components: any[]): any[] {
  const uniqueIds = new Map<string, any>();
  const references = new Map<string, any>();
  const parts = new Map<string, Set<string>>();
  const physical: any[] = [];

  for (const component of components) {
    const reference = bomReference(component);
    const uniqueId = bomUniqueId(component);
    if (
      linkedBOMUnit(
        references.get(reference),
        uniqueId ? uniqueIds.get(uniqueId) : undefined,
        component,
        uniqueId,
        parts,
      )
    ) {
      continue;
    }
    references.set(reference, component);
    if (uniqueId) {
      uniqueIds.set(uniqueId, component);
      parts.set(
        uniqueId,
        new Set(
          typeof component.subPartName === 'string' && component.subPartName.trim()
            ? [component.subPartName]
            : [],
        ),
      );
    }
    physical.push(component);
  }
  return physical;
}

function createBomGroup(component: any) {
  return {
    references: [] as string[],
    value: component.value,
    footprint: component.footprint,
    lcsc: component.lcsc,
    manufacturer: component.manufacturer,
    mpn: component.manufacturerId || undefined,
    quantity: 0,
  };
}

async function generateBom(
  dependencies: ReadOnlyOperationsDependencies,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = (await dependencies.schematicComponentInspection.listComponents()) as {
    items: any[];
  };
  const groupBy = params.groupBy || 'value';
  const groups = new Map<string, ReturnType<typeof createBomGroup>>();

  for (const component of physicalBomComponents(
    result.items.filter((component) => component.addIntoBom !== false),
  )) {
    const key = bomGroupKey(component, groupBy);
    const group = groups.get(key) ?? createBomGroup(component);
    if (!groups.has(key)) groups.set(key, group);
    group.references.push(component.reference);
    group.quantity += 1;
  }

  return [...groups.values()].map((group) => ({
    reference: group.references.join(', '),
    value: group.value,
    footprint: group.footprint,
    lcsc: group.lcsc,
    quantity: group.quantity,
    manufacturer: group.manufacturer,
    mpn: group.mpn,
  }));
}

export function createReadOnlyOperations(
  dependencies: ReadOnlyOperationsDependencies,
): ReadOnlyOperations {
  return {
    async listNets(params = {}) {
      assertSchematicReadScopeSupported(
        params,
        ['focused'],
        'schematic.listNets',
        'page-aware-net-read',
      );
      return dependencies.listNets();
    },

    async getNetDetail(params) {
      assertSchematicReadScopeSupported(
        params,
        ['focused'],
        'schematic.getNetDetail',
        'page-aware-net-detail-read',
      );
      return dependencies.getNetDetail(params.netName as string, params.operationTimeoutMs);
    },

    async getPrimitiveSnapshot(params) {
      return dependencies.schematicTransactionOperations.getPrimitiveSnapshot(
        params.primitiveId as string,
        expectedSnapshotKind(params.expectedPrimitiveKind),
      );
    },

    async listPrimitiveIds(params) {
      return dependencies.schematicTransactionOperations.listPrimitiveIds(params.primitiveKind);
    },

    async listComponents(params) {
      const selector = assertSchematicReadScopeSupported(
        params,
        ['focused', 'all_pages'],
        'schematic.listComponents',
        'page-attributed-component-read',
      );
      let allPages = params.allPages;
      if (selector.scope === 'focused') allPages = false;
      if (selector.scope === 'all_pages') allPages = true;
      return dependencies.schematicComponentInspection.listComponents(
        optionalNumber(params.limit),
        offsetNumber(params.offset),
        allPages,
      );
    },

    async getSheetInfo(params = {}) {
      assertSchematicReadScopeSupported(
        params,
        ['focused', 'page', 'all_pages'],
        'schematic.getSheetInfo',
        'schematic-page-metadata',
      );
      return dependencies.schematicInspection.getSheetInfo(params);
    },

    async primitiveBounds(params) {
      return dependencies.schematicInspection.primitiveBounds(params.primitiveIds);
    },

    async searchDevice(params) {
      return dependencies.callFirst(
        ['LIB_Device.search', 'lib_Device.search'],
        params.key,
        params.libraryUuid,
        params.classification,
        params.symbolType,
        params.itemsOfPage,
        params.page,
      );
    },

    async listRectangles() {
      return dependencies.schematicInspection.listRectangles();
    },

    async getPinNoConnect(params) {
      return dependencies.getPinNoConnect(params.primitiveId as string, params.pinNumber as string);
    },

    async validateNetlist(params = {}) {
      assertSchematicReadScopeSupported(
        params,
        ['focused'],
        'schematic.validateNetlist',
        'project-wide-complete-netlist-validation',
      );
      return validateNetlist(dependencies);
    },

    async getDeviceByLcscId(params) {
      const lcscId = String(params.lcscId ?? '');
      const libraryUuid = typeof params.libraryUuid === 'string' ? params.libraryUuid : undefined;
      return dependencies.callFirst(['LIB_Device.getByLcscIds'], [lcscId], libraryUuid, false);
    },

    async getDeviceSubParts(params) {
      const deviceUuid = String(params.deviceUuid ?? '');
      const libraryUuid = String(params.libraryUuid ?? '');
      const raw = await dependencies.callFirst(
        ['LIB_Device.get', 'lib_Device.get'],
        deviceUuid,
        libraryUuid,
      );
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { not_available: true, reason: 'DEVICE_NOT_FOUND' };
      }
      const device = raw as Record<string, unknown>;
      if (device.uuid !== deviceUuid || device.libraryUuid !== libraryUuid) {
        return { not_available: true, reason: 'LIBRARY_SOURCE_MISMATCH' };
      }
      const subPartNames = device.subPartNames;
      if (
        !Array.isArray(subPartNames) ||
        !subPartNames.every((part) => typeof part === 'string' && part.length > 0)
      ) {
        return { not_available: true, reason: 'SUBPART_METADATA_UNAVAILABLE' };
      }
      const association = device.association;
      const declaredFootprintUuid =
        association && typeof association === 'object' && !Array.isArray(association)
          ? (association as Record<string, unknown>).footprintUuid
          : undefined;
      return {
        deviceUuid,
        libraryUuid,
        name: typeof device.name === 'string' ? device.name : undefined,
        subPartNames,
        multiUnit: subPartNames.length > 1,
        declaredFootprintUuid:
          typeof declaredFootprintUuid === 'string' ? declaredFootprintUuid : undefined,
        evidenceScope: 'library-metadata',
      };
    },

    async generateBom(params) {
      return generateBom(dependencies, params);
    },

    async validateBom() {
      const result = (await dependencies.schematicComponentInspection.listComponents()) as {
        items: any[];
      };
      return {
        totalParts: physicalBomComponents(
          result.items.filter((component) => component.addIntoBom !== false),
        ).length,
        missing: [],
        obsolete: [],
        alternates: [],
      };
    },

    async inventorySearch() {
      return [];
    },

    async inventoryGetPrice() {
      return null;
    },
  };
}
