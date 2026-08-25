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
  if (groupBy === 'lcsc') return component.lcsc || component.value;
  if (groupBy === 'footprint') return component.footprint || 'no-footprint';
  return component.value || 'no-value';
}

function createBomGroup(component: any) {
  return {
    references: [] as string[],
    value: component.value,
    footprint: component.footprint,
    lcsc: component.lcsc,
    manufacturer: component.manufacturer,
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

  for (const component of result.items) {
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

    async generateBom(params) {
      return generateBom(dependencies, params);
    },

    async validateBom() {
      const result = (await dependencies.schematicComponentInspection.listComponents()) as {
        items: any[];
      };
      return { totalParts: result.items.length, missing: [], obsolete: [], alternates: [] };
    },

    async inventorySearch() {
      return [];
    },

    async inventoryGetPrice() {
      return null;
    },
  };
}
