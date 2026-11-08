import {
  getFunctionNames,
  isAllowedApiClassName,
  isAllowedApiPath,
  normalizeApiClassName,
  isAllowedReadOnlyApiPath,
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

/** Bound the bridge result depth even for calls bypassing the MCP input schema. */
export function clampApiResultDepth(depth: unknown): number {
  return Number.isInteger(depth) ? Math.max(1, Math.min(16, depth as number)) : 5;
}

export interface ApiRuntime {
  callFirst(paths: readonly string[], ...args: unknown[]): Promise<unknown>;
  readFirstPath<T>(paths: readonly string[]): T | undefined;
  inspectApiInventory(filter?: string): JsonValue;
  callAllowedApi(
    path: string,
    args: readonly unknown[],
    maxDepth?: number,
    includeMethods?: boolean,
  ): Promise<unknown>;
  callReadOnlyApi(
    path: string,
    args: readonly unknown[],
    maxDepth?: number,
    includeMethods?: boolean,
  ): Promise<unknown>;
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

  type TaggedPolygonArgumentResult = { matched: false } | { matched: true; value: unknown };

  async function materializeTaggedPolygonArgument(
    value: Record<string, unknown>,
    argumentPath: string,
  ): Promise<TaggedPolygonArgumentResult> {
    const hasPolygon = '$polygon' in value;
    const hasComplexPolygon = '$complexPolygon' in value;
    if (!hasPolygon && !hasComplexPolygon) return { matched: false };

    if (hasPolygon && hasComplexPolygon) {
      throw createBridgeError(
        'INVALID_PARAMS',
        `Polygon argument has conflicting tags (${argumentPath})`,
        'Use exactly one of {$polygon: [...]} or {$complexPolygon: [...]}.',
        { argumentPath },
      );
    }

    if (Object.keys(value).length !== 1) {
      throw createBridgeError(
        'INVALID_PARAMS',
        `Tagged polygon arguments cannot contain extra fields (${argumentPath})`,
        'Use exactly one tagged polygon field with no additional properties.',
        { argumentPath },
      );
    }

    const tag = hasPolygon ? '$polygon' : '$complexPolygon';
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
    return { matched: true, value: await callFirst(builder, source) };
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

    const taggedPolygon = await materializeTaggedPolygonArgument(value, argumentPath);
    if (taggedPolygon.matched) return taggedPolygon.value;

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

  async function callAllowedApi(
    path: string,
    args: readonly unknown[],
    maxDepth = 5,
    includeMethods = false,
  ): Promise<unknown> {
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
          result: normalizeValue(
            result,
            clampApiResultDepth(maxDepth),
            new WeakSet<object>(),
            includeMethods,
          ),
        };
      }
    }

    throw createBridgeError(
      'METHOD_NOT_FOUND',
      `No EasyEDA API implementation found for ${path}`,
      'Check easyeda_api_inventory for runtime-supported classes and methods.',
    );
  }

  async function focusedIdentityForRead(): Promise<Record<string, unknown>> {
    try {
      const value = await callFirst(['DMT_SelectControl.getCurrentDocumentInfo']);
      return isRecord(value) ? value : {};
    } catch {
      throw createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'Focused EasyEDA document cannot be read.',
        'Focus the target PCB or schematic first.',
      );
    }
  }

  async function focusedNameForRead(info: Record<string, unknown>): Promise<string> {
    const type = info.documentType;
    let native: unknown;
    try {
      if (type === 1 || type === 3) {
        native = await callFirst([
          type === 1 ? 'DMT_Schematic.getCurrentSchematicPageInfo' : 'DMT_Pcb.getCurrentPcbInfo',
        ]);
      }
    } catch {
      /* No identity match can be inferred from unavailable metadata. */
    }
    const candidate = isRecord(native) && native.uuid === info.uuid ? native.name : undefined;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    return typeof info.name === 'string' && info.name.trim() ? info.name : 'unknown';
  }

  async function requireReadDocumentFocus(path: string): Promise<void> {
    const domain = normalizeApiClassName(path.split('.')[0] ?? '');
    const expectedType = domain.startsWith('PCB_') ? 3 : domain.startsWith('SCH_') ? 1 : undefined;
    if (expectedType === undefined) return;
    const info = await focusedIdentityForRead();
    const type = info.documentType;
    if (type === expectedType && typeof info.uuid === 'string' && info.uuid) return;
    const focusedName = await focusedNameForRead(info);
    throw createBridgeError(
      'CONTEXT_UNAVAILABLE',
      `Cannot read ${domain}: focused document is ${focusedName} (type ${String(type ?? 'unknown')}).`,
      `Focus a ${expectedType === 3 ? 'PCB' : 'schematic'} document first.`,
      {
        focusedName,
        focusedDocumentType: type ?? null,
        focusedDocumentUuid: typeof info.uuid === 'string' ? info.uuid : null,
      },
    );
  }

  async function callReadOnlyApi(
    path: string,
    args: readonly unknown[],
    maxDepth = 5,
    includeMethods = false,
  ): Promise<unknown> {
    if (!isAllowedReadOnlyApiPath(path)) {
      throw createBridgeError(
        'UNAUTHORIZED',
        `Read-only API path is not allowlisted: ${path}`,
        'Use easyeda_api_inventory to inspect methods, but only reviewed getters are exposed for safe reads.',
      );
    }
    if (
      !Array.isArray(args) ||
      args.length > 8 ||
      !args.every(
        (arg) =>
          arg === null ||
          typeof arg === 'string' ||
          typeof arg === 'boolean' ||
          (typeof arg === 'number' && Number.isFinite(arg)),
      )
    ) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'Read-only API arguments must be at most 8 finite JSON scalars.',
        'Use string/boolean/finite-number/null arguments; no nested objects or polygon descriptors.',
      );
    }
    await requireReadDocumentFocus(path);
    return callAllowedApi(path, args, maxDepth, includeMethods);
  }

  return {
    callFirst,
    readFirstPath,
    inspectApiInventory,
    callAllowedApi,
    callReadOnlyApi,
  };
}
