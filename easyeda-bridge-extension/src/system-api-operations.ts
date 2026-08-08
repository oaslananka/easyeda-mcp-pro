import type { ApiRuntime } from './api-runtime.js';
import { normalizeValue } from './api-introspection.js';
import type { DispatcherToolkit } from './toolkit.js';
import { isRecord } from './utils.js';

export interface SystemApiOperationsDependencies {
  toolkit: DispatcherToolkit;
  methodList: readonly string[];
  buildId: string;
  inspectApiInventory: ApiRuntime['inspectApiInventory'];
  callAllowedApi: ApiRuntime['callAllowedApi'];
  readFirstPath: ApiRuntime['readFirstPath'];
  summarizeWirePrimitive: (wire: unknown) => unknown;
  createBridgeError: (code: string, message: string, suggestion: string, data?: unknown) => Error;
  logRecoverableError: (message: string, error: unknown) => void;
}

export interface SystemApiOperations {
  apiCall(params: Record<string, unknown>): Promise<unknown>;
  apiExecute(params: Record<string, unknown>): Promise<unknown>;
  apiInventory(params: Record<string, unknown>): Promise<unknown>;
  getStatus(): Promise<unknown>;
  inspectComponents(params: Record<string, unknown>): Promise<unknown>;
  inspectWires(params: Record<string, unknown>): Promise<unknown>;
}

function enumerableKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key in value) keys.push(key);
  return keys;
}

function collectAllPropertyNames(
  value: unknown,
  logRecoverableError: SystemApiOperationsDependencies['logRecoverableError'],
): string[] {
  let props: string[] = [];
  let current = value;
  while (current && current !== Object.prototype) {
    try {
      props = props.concat(Object.getOwnPropertyNames(current));
    } catch (error) {
      logRecoverableError('failed to read debug probe property names', error);
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch (error) {
      logRecoverableError('failed to read debug probe prototype', error);
      break;
    }
  }
  return Array.from(new Set(props)).filter(
    (property) => !['length', 'name', 'prototype', 'constructor'].includes(property),
  );
}

function recordOwnKeys(
  globals: Record<string, unknown>,
  value: object,
  key: string,
  errorKey: string,
): void {
  try {
    globals[key] = Object.getOwnPropertyNames(value);
  } catch (error) {
    globals[errorKey] = String(error);
  }
}

function recordEnumerableKeys(
  globals: Record<string, unknown>,
  value: object,
  key: string,
  errorKey: string,
): void {
  try {
    globals[key] = enumerableKeys(value);
  } catch (error) {
    globals[errorKey] = String(error);
  }
}

function recordRuntimeClassKeys(
  globals: Record<string, unknown>,
  edaObject: object,
  property: string,
  outputKey: string,
  errorKey: string,
  logRecoverableError: SystemApiOperationsDependencies['logRecoverableError'],
): void {
  try {
    const runtimeClass = (edaObject as Record<string, unknown>)[property];
    if (runtimeClass) {
      globals[outputKey] = collectAllPropertyNames(runtimeClass, logRecoverableError);
    }
  } catch (error) {
    globals[errorKey] = String(error);
  }
}

function recordEdaDiagnostics(
  globals: Record<string, unknown>,
  edaObject: object,
  logRecoverableError: SystemApiOperationsDependencies['logRecoverableError'],
): void {
  recordOwnKeys(globals, edaObject, 'eda_keys', 'eda_keys_err');
  recordEnumerableKeys(globals, edaObject, 'eda_for_in_keys', 'eda_for_in_keys_err');
  recordRuntimeClassKeys(
    globals,
    edaObject,
    'sch_PrimitiveComponent',
    'sch_PrimitiveComponent_all_keys',
    'sch_PrimitiveComponent_err',
    logRecoverableError,
  );
  recordRuntimeClassKeys(
    globals,
    edaObject,
    'sch_Document',
    'sch_Document_all_keys',
    'sch_Document_err',
    logRecoverableError,
  );
  recordRuntimeClassKeys(
    globals,
    edaObject,
    'pcb_Document',
    'pcb_Document_all_keys',
    'pcb_Document_err',
    logRecoverableError,
  );
  recordRuntimeClassKeys(
    globals,
    edaObject,
    'dmt_Schematic',
    'dmt_Schematic_all_keys',
    'dmt_Schematic_err',
    logRecoverableError,
  );
  recordRuntimeClassKeys(
    globals,
    edaObject,
    'dmt_Project',
    'dmt_Project_all_keys',
    'dmt_Project_err',
    logRecoverableError,
  );
  recordRuntimeClassKeys(
    globals,
    edaObject,
    'dmt_Pcb',
    'dmt_Pcb_all_keys',
    'dmt_Pcb_err',
    logRecoverableError,
  );
}

function matchesEasyEdaDiagnosticKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('dmt') ||
    lower.includes('eda') ||
    lower.includes('schematic') ||
    lower.includes('pcb') ||
    lower.includes('api')
  );
}

function recordGlobalDiagnostics(globals: Record<string, unknown>): void {
  try {
    globals.globalThis_matched_keys = Object.getOwnPropertyNames(globalThis).filter(
      matchesEasyEdaDiagnosticKey,
    );
  } catch (error) {
    globals.globalThis_keys_err = String(error);
  }

  try {
    globals.globalThis_for_in_matched_keys = enumerableKeys(globalThis).filter(
      matchesEasyEdaDiagnosticKey,
    );
  } catch (error) {
    globals.globalThis_for_in_err = String(error);
  }
}

function collectStatusGlobals(
  toolkit: DispatcherToolkit,
  logRecoverableError: SystemApiOperationsDependencies['logRecoverableError'],
): { globals: Record<string, unknown>; edaObject: unknown; EDAObject: unknown } {
  const globals: Record<string, unknown> = {};
  const edaObject = toolkit.getEda();
  const EDAObject = toolkit.getEDA();
  const apiObject = toolkit.getApi();

  try {
    globals.typeof_api = typeof (globalThis as { api?: unknown }).api;
    globals.typeof_eda = typeof (globalThis as { eda?: unknown }).eda;
    globals.typeof_EDA = typeof (globalThis as { EDA?: unknown }).EDA;
    globals.typeof_local_api = typeof apiObject;
    globals.typeof_local_eda = typeof edaObject;
    globals.typeof_local_EDA = typeof EDAObject;

    if (edaObject) {
      recordEdaDiagnostics(globals, Object(edaObject), logRecoverableError);
    }
    if (EDAObject) {
      const boxedEDAObject = Object(EDAObject);
      recordOwnKeys(globals, boxedEDAObject, 'EDA_keys', 'EDA_keys_err');
      recordEnumerableKeys(globals, boxedEDAObject, 'EDA_for_in_keys', 'EDA_for_in_keys_err');
    }
    recordGlobalDiagnostics(globals);
  } catch (error) {
    globals.error = String(error);
  }

  return { globals, edaObject, EDAObject };
}

export function createSystemApiOperations(
  dependencies: SystemApiOperationsDependencies,
): SystemApiOperations {
  return {
    async apiCall(params) {
      return dependencies.callAllowedApi(
        typeof params.path === 'string' ? params.path : '',
        Array.isArray(params.args) ? params.args : [],
      );
    },

    async apiExecute(params) {
      const code = typeof params.code === 'string' ? params.code : '';
      if (!code.trim()) {
        throw dependencies.createBridgeError(
          'INVALID_PARAMS',
          'code is required',
          'Provide JavaScript code to execute',
        );
      }
      const AsyncFunction = Object.getPrototypeOf(async function () {})
        .constructor as FunctionConstructor;
      const edaGlobal = dependencies.toolkit.getEda() ?? (globalThis as { eda?: unknown }).eda;
      // eslint-disable-next-line no-restricted-syntax -- api.execute is double-gated and covered by raw-execution safety tests.
      const fn = new AsyncFunction('eda', code) as (eda: unknown) => Promise<unknown>;
      const result = await fn(edaGlobal);
      return { result: normalizeValue(result, 5) };
    },

    async apiInventory(params) {
      return dependencies.inspectApiInventory(
        typeof params.filter === 'string' ? params.filter : undefined,
      );
    },

    async getStatus() {
      const { globals, edaObject, EDAObject } = collectStatusGlobals(
        dependencies.toolkit,
        dependencies.logRecoverableError,
      );
      const hasDMTLocal = isRecord(edaObject) && 'DMT_Schematic' in edaObject;
      const hasDMTEDA = isRecord(EDAObject) && 'DMT_Schematic' in EDAObject;
      return {
        bridgeVersion: dependencies.toolkit.getBridgeVersion(),
        capabilities: [...dependencies.methodList],
        devMode: false,
        globals,
        hasEda: !!edaObject || !!EDAObject,
        hasDMT: 'DMT_Schematic' in globalThis || hasDMTLocal || hasDMTEDA,
        dispatcherBuildId: dependencies.buildId,
      };
    },

    async inspectComponents(params) {
      const limit = typeof params.limit === 'number' ? params.limit : 5;
      const schCompClass = dependencies.readFirstPath<any>([
        'SCH_PrimitiveComponent',
        'SCH_PrimitiveComponent3',
        'sch_PrimitiveComponent',
      ]);
      if (!schCompClass || typeof schCompClass.getAll !== 'function') {
        throw new Error('SCH_PrimitiveComponent.getAll is not available in this EasyEDA runtime');
      }
      const comps = await schCompClass.getAll(undefined, true);
      const items = Array.isArray(comps) ? comps : [];
      return {
        total: items.length,
        samples: items
          .slice(0, Math.max(1, Math.min(limit, 25)))
          .map((item) => normalizeValue(item, 5)),
      };
    },

    async inspectWires(params) {
      const limit = typeof params.limit === 'number' ? params.limit : 10;
      const offset = typeof params.offset === 'number' ? params.offset : 0;
      const schWireClass = dependencies.readFirstPath<any>([
        'SCH_PrimitiveWire',
        'SCH_PrimitiveWire3',
        'sch_PrimitiveWire',
      ]);
      if (!schWireClass || typeof schWireClass.getAll !== 'function') {
        throw new Error('SCH_PrimitiveWire.getAll is not available in this EasyEDA runtime');
      }
      const wires = await schWireClass.getAll();
      const items = Array.isArray(wires) ? wires : [];
      const start = Math.max(0, offset);
      const end = start + Math.max(1, Math.min(limit, 50));
      return {
        total: items.length,
        samples: items.slice(start, end).map(dependencies.summarizeWirePrimitive),
      };
    },
  };
}
