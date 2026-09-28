import {
  getFunctionNames,
  isAllowedApiClassName,
  isAllowedApiPath,
  normalizeApiClassName,
  normalizeValue,
  readMember,
  withClassNameVariants,
} from './api-introspection.js';
import type { DispatcherToolkit } from './toolkit.js';
import { isRecord, readPath, readPathParent, type JsonValue } from './utils.js';

export type BridgeErrorFactory = (
  code: string,
  message: string,
  suggestion: string,
  data?: unknown,
) => Error;

type ApiRootToolkit = Pick<DispatcherToolkit, 'getEda' | 'getEDA' | 'getApi'>;

type ApiCandidate = {
  name: string;
  root: unknown;
};

export interface ApiRuntime {
  callFirst(paths: readonly string[], ...args: unknown[]): Promise<unknown>;
  readFirstPath<T>(paths: readonly string[]): T | undefined;
  inspectApiInventory(filter?: string): JsonValue;
  callAllowedApi(path: string, args: readonly unknown[]): Promise<unknown>;
}

export function createApiRuntime(
  toolkit: ApiRootToolkit,
  createBridgeError: BridgeErrorFactory,
  globalRoot: unknown = globalThis,
): ApiRuntime {
  function getApiCandidates(): ApiCandidate[] {
    const candidates: ApiCandidate[] = [];
    const edaObj = toolkit.getEda();
    if (edaObj) candidates.push({ name: 'eda', root: edaObj });
    const EDAObj = toolkit.getEDA();
    if (EDAObj) candidates.push({ name: 'EDA', root: EDAObj });
    const apiObj = toolkit.getApi();
    if (apiObj) candidates.push({ name: 'api', root: apiObj });
    candidates.push({ name: 'globalThis', root: globalRoot });
    return candidates;
  }

  async function callFirst(paths: readonly string[], ...args: unknown[]): Promise<unknown> {
    const allPaths = withClassNameVariants(paths);

    for (const candidate of getApiCandidates()) {
      for (const path of allPaths) {
        const fn = readPath<unknown>(candidate.root, path);
        if (typeof fn === 'function') {
          return await fn.apply(readPathParent(candidate.root, path), args);
        }
      }
    }

    throw createBridgeError(
      'METHOD_NOT_FOUND',
      `No EasyEDA API implementation found for ${paths.join(' or ')}`,
      'Verify the bridge extension supports the installed EasyEDA Pro version.',
    );
  }

  function readFirstPath<T>(paths: readonly string[]): T | undefined {
    for (const candidate of getApiCandidates()) {
      for (const path of withClassNameVariants(paths)) {
        const value = readPath<T>(candidate.root, path);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  }

  async function materializeApiArgument(value: unknown, argumentPath: string): Promise<unknown> {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const [index, item] of value.entries()) {
        output.push(await materializeApiArgument(item, `${argumentPath}[${index}]`));
      }
      return output;
    }
    if (!isRecord(value)) return value;

    if ('__class' in value || '__methods' in value) {
      throw createBridgeError(
        'INVALID_PARAMS',
        `Serialized EasyEDA API descriptors cannot be used as call arguments (${argumentPath})`,
        'Pass plain JSON values or an explicit {$polygon: [...]} / {$complexPolygon: [...]} tagged argument.',
        { argumentPath },
      );
    }

    const hasPolygon = '$polygon' in value;
    const hasComplexPolygon = '$complexPolygon' in value;
    if (hasPolygon || hasComplexPolygon) {
      const tag = hasPolygon ? '$polygon' : '$complexPolygon';
      if (hasPolygon && hasComplexPolygon) {
        throw createBridgeError(
          'INVALID_PARAMS',
          `Polygon argument has conflicting tags (${argumentPath})`,
          'Use exactly one of {$polygon: [...]} or {$complexPolygon: [...]}.',
          { argumentPath },
        );
      }
      const keys = Object.keys(value);
      if (keys.length !== 1) {
        throw createBridgeError(
          'INVALID_PARAMS',
          `Tagged polygon arguments cannot contain extra fields (${argumentPath})`,
          'Use exactly one tagged polygon field with no additional properties.',
          { argumentPath },
        );
      }
      const source = value[tag];
      if (!Array.isArray(source)) {
        throw createBridgeError(
          'INVALID_PARAMS',
          `${tag} must contain an array (${argumentPath})`,
          `Provide ${tag} as an EasyEDA polygon source array.`,
          { argumentPath },
        );
      }
      const builder =
        tag === '$polygon'
          ? ['PCB_MathPolygon.createPolygon', 'pcb_MathPolygon.createPolygon']
          : ['PCB_MathPolygon.createComplexPolygon', 'pcb_MathPolygon.createComplexPolygon'];
      return await callFirst(builder, source);
    }

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = await materializeApiArgument(nested, `${argumentPath}.${key}`);
    }
    return output;
  }

  function inspectApiInventory(filter?: string): JsonValue {
    const normalizedFilter = filter?.toLowerCase().trim();
    const classMap = new Map<
      string,
      {
        className: string;
        runtimePaths: string[];
        methods: string[];
      }
    >();

    for (const candidate of getApiCandidates()) {
      const root = candidate.root;
      if (!isRecord(root)) continue;

      for (const key of Object.getOwnPropertyNames(root)) {
        const className = normalizeApiClassName(key);
        if (!isAllowedApiClassName(className)) continue;
        if (normalizedFilter && !className.toLowerCase().includes(normalizedFilter)) continue;

        const value = readMember(root, key);
        const methods = getFunctionNames(value).sort((a, b) => a.localeCompare(b));
        const existing = classMap.get(className) ?? {
          className,
          runtimePaths: [],
          methods: [],
        };
        existing.runtimePaths.push(`${candidate.name}.${key}`);
        existing.methods = Array.from(new Set([...existing.methods, ...methods])).sort((a, b) =>
          a.localeCompare(b),
        );
        classMap.set(className, existing);
      }
    }

    const classes = Array.from(classMap.values()).sort((a, b) =>
      a.className.localeCompare(b.className),
    );
    return {
      classes: classes as unknown as JsonValue,
      total: classes.length,
    };
  }

  async function callAllowedApi(path: string, args: readonly unknown[]): Promise<unknown> {
    if (!isAllowedApiPath(path)) {
      throw createBridgeError(
        'UNAUTHORIZED',
        `API path is not allowed: ${path}`,
        'Use a documented EasyEDA API class method such as SCH_PrimitiveWire.getAll.',
      );
    }

    for (const candidate of getApiCandidates()) {
      for (const candidatePath of withClassNameVariants([path])) {
        const fn = readPath<unknown>(candidate.root, candidatePath);
        if (typeof fn !== 'function') continue;
        const parent = readPathParent(candidate.root, candidatePath);
        const materializedArgs: unknown[] = [];
        for (const [index, argument] of args.entries()) {
          materializedArgs.push(await materializeApiArgument(argument, `args[${index}]`));
        }
        const result = await fn.apply(parent, materializedArgs);
        return {
          path,
          resolvedPath: `${candidate.name}.${candidatePath}`,
          result: normalizeValue(result, 5),
        };
      }
    }

    throw createBridgeError(
      'METHOD_NOT_FOUND',
      `No EasyEDA API implementation found for ${path}`,
      'Check easyeda_api_inventory for runtime-supported classes and methods.',
    );
  }

  return {
    callFirst,
    readFirstPath,
    inspectApiInventory,
    callAllowedApi,
  };
}
