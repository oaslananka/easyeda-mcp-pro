import type { ApiRuntime } from './api-runtime.js';

export type DrcSeverity = 'error' | 'warning' | 'info';

export interface DrcResult {
  violations: Array<Record<string, unknown>>;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  passed: boolean;
}

class InvalidDrcError extends Error {
  constructor(reason: string) {
    super(`unsupported native rule-check response: ${reason}`);
  }
}

export interface FloatingPin {
  primitiveId: string;
  designator: string;
  pinNumber: string;
}

export interface DesignRuleCheckDependencies {
  callFirst: ApiRuntime['callFirst'];
  createBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error;
  logRecoverableError(message: string, error: unknown): void;
  errorMessage(error: unknown): string;
  findFloatingPins(): Promise<{ floatingPins: FloatingPin[]; partRefs: string[] }>;
}

export interface DesignRuleCheckOperations {
  runDrc(): Promise<DrcResult>;
  runErc(): Promise<
    DrcResult & {
      inferredFloatingPins: FloatingPin[];
      detailSource: 'inferred_partial' | 'native_aggregate_only';
    }
  >;
  runRuleCheck(): Promise<DrcResult>;
  runSchematicCheck(): Promise<DrcResult>;
}

function toSeverity(raw: string): DrcSeverity {
  const value = raw.toLowerCase();
  if (value.includes('fatal') || value.includes('error')) return 'error';
  if (value.includes('warn')) return 'warning';
  return 'info';
}

function asScalar(value: unknown): string | undefined {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : undefined;
}

function scalarParts(values: unknown[]): string {
  return values
    .map(asScalar)
    .filter((value): value is string => value !== undefined)
    .join(' ');
}

function firstScalar(values: unknown[]): string {
  for (const value of values) {
    const scalar = asScalar(value);
    if (scalar !== undefined) return scalar;
  }
  return 'unknown';
}

function toViolation(item: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = item && typeof item === 'object' ? { ...item } : {};
  const explanation =
    obj.explanation && typeof obj.explanation === 'object'
      ? (obj.explanation as Record<string, unknown>).str
      : obj.explanation;
  const message = [obj.message, obj.msg, obj.description, obj.text, obj.detail, explanation].find(
    (value) => value != null && (typeof value !== 'string' || value.trim().length > 0),
  );
  const rule = firstScalar([
    obj.rule,
    obj.ruleName,
    obj.ruleTypeName,
    obj.errorType,
    obj.name,
    obj.type,
  ]);
  // Preserve the rule, not opaque native objects, when the vendor omits a message.
  const detail =
    message ??
    (item !== null && typeof item === 'object' ? `${rule} (native detail unavailable)` : item);
  const description = typeof detail === 'string' ? detail : JSON.stringify(detail);
  const severitySource = scalarParts([
    obj.level,
    obj.severity,
    obj.type,
    obj.errorLevel,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    obj.ruleName,
  ]);
  let position = obj;
  if (obj.position && typeof obj.position === 'object') {
    position = obj.position as Record<string, unknown>;
  } else if (obj.location && typeof obj.location === 'object') {
    position = obj.location as Record<string, unknown>;
  }
  return {
    rule,
    description,
    severity: toSeverity(severitySource),
    net: obj.net ?? obj.netName,
    component: obj.component ?? obj.ref ?? obj.designator ?? obj.primitiveId,
    location:
      typeof position.x === 'number' && typeof position.y === 'number'
        ? { x: position.x, y: position.y, layer: obj.layer as string | undefined }
        : undefined,
  };
}

function toAggregate(
  obj: Record<string, unknown>,
): { severity: DrcSeverity; count: number } | null {
  if (typeof obj.count !== 'number') return null;
  const title = Array.isArray(obj.title) ? scalarParts(obj.title) : obj.title;
  const source = scalarParts([
    obj.type,
    obj.severity,
    obj.level,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    title,
  ]);
  return { severity: toSeverity(source), count: obj.count };
}

function hasDetail(obj: Record<string, unknown>): boolean {
  return [
    'message',
    'msg',
    'description',
    'text',
    'detail',
    'explanation',
    'errorType',
    'errorObjType',
    'rule',
    'ruleName',
    'ruleTypeName',
  ].some((key) => obj[key] !== undefined);
}

function asNativeNode(item: unknown): Record<string, unknown> | null {
  if (Array.isArray(item)) {
    throw new InvalidDrcError('nested array');
  }
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj) return null;
  if (
    'count' in obj &&
    (typeof obj.count !== 'number' || !Number.isSafeInteger(obj.count) || obj.count < 0)
  ) {
    throw new InvalidDrcError('invalid count');
  }
  if ('list' in obj && !Array.isArray(obj.list)) {
    throw new InvalidDrcError('invalid list');
  }
  return obj;
}

function toNode(item: unknown): {
  violations: Array<Record<string, unknown>>;
  aggregates: Array<{ severity: DrcSeverity; count: number }>;
} {
  const obj = asNativeNode(item);
  if (!obj) return { violations: [toViolation(item)], aggregates: [] };

  const children = Array.isArray(obj.list) ? obj.list : [];
  if (children.length > 0) {
    const nodes = children.map(toNode);
    const violations = nodes.flatMap((entry) => entry.violations);
    const aggregates = nodes.flatMap((entry) => entry.aggregates);
    return { violations, aggregates };
  }

  if (hasDetail(obj)) return { violations: [toViolation(obj)], aggregates: [] };
  const aggregate = toAggregate(obj);
  if (!aggregate) {
    throw new InvalidDrcError('unknown node');
  }
  return { violations: [], aggregates: [aggregate] };
}

export function createDesignRuleCheckOperations(
  deps: DesignRuleCheckDependencies,
): DesignRuleCheckOperations {
  async function runNative(paths: string[]): Promise<DrcResult> {
    const raw = await deps.callFirst(paths, true, true, true);
    if (!Array.isArray(raw)) {
      throw new InvalidDrcError('expected findings array');
    }
    const nodes = raw.map(toNode);
    const detailed = nodes.flatMap((entry) => entry.violations);
    const aggregates = nodes.flatMap((entry) => entry.aggregates);
    const violations = [
      ...detailed,
      ...aggregates
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          rule: 'aggregate',
          description: `${entry.count} native ${entry.severity}(s); individual details unavailable.`,
          severity: entry.severity,
        })),
    ];
    const errorCount =
      detailed.filter((entry) => entry.severity === 'error').length +
      aggregates
        .filter((entry) => entry.severity === 'error')
        .reduce((sum, entry) => sum + entry.count, 0);
    const warningCount =
      detailed.filter((entry) => entry.severity === 'warning').length +
      aggregates
        .filter((entry) => entry.severity === 'warning')
        .reduce((sum, entry) => sum + entry.count, 0);
    return {
      violations,
      totalViolations: detailed.length + aggregates.reduce((sum, entry) => sum + entry.count, 0),
      errorCount,
      warningCount,
      passed: errorCount === 0,
    };
  }

  async function runSchematicCheck(): Promise<DrcResult> {
    return runNative(['SCH_Drc.check']);
  }

  async function runFocusedNative(
    paths: string[],
    document: string,
    method: string,
  ): Promise<DrcResult> {
    try {
      return await runNative(paths);
    } catch (error) {
      const message = `Focus a ${document} document, then retry ${method}.`;
      throw deps.createBridgeError('CONTEXT_UNAVAILABLE', message, message, {
        cause: deps.errorMessage(error),
      });
    }
  }

  async function runDrc(): Promise<DrcResult> {
    return runFocusedNative(['PCB_Drc.check'], 'PCB', 'design.drc');
  }

  async function runRuleCheck(): Promise<DrcResult> {
    let pcbError: unknown;
    try {
      return await runNative(['PCB_Drc.check']);
    } catch (error) {
      if (error instanceof InvalidDrcError) {
        throw deps.createBridgeError(
          'CONTEXT_UNAVAILABLE',
          'Native PCB DRC returned an unsupported result; schematic ERC cannot verify this PCB.',
          'Focus a PCB document and inspect the native DRC API response before retrying.',
          { cause: deps.errorMessage(error) },
        );
      }
      pcbError = error;
      deps.logRecoverableError(
        'design.ruleCheck: PCB DRC unavailable; trying schematic ERC/DRC',
        error,
      );
    }
    try {
      return await runNative(['SCH_Drc.check']);
    } catch (schematicError) {
      throw deps.createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'No active PCB or schematic canvas is available for design.ruleCheck.',
        'Open and focus a PCB or schematic document, then retry.',
        {
          pcbCause: deps.errorMessage(pcbError),
          schematicCause: deps.errorMessage(schematicError),
        },
      );
    }
  }

  async function runErc(): ReturnType<DesignRuleCheckOperations['runErc']> {
    const result = await runFocusedNative(['SCH_Drc.check'], 'schematic', 'design.erc');
    try {
      const { floatingPins } = await deps.findFloatingPins();
      return {
        ...result,
        inferredFloatingPins: floatingPins,
        detailSource:
          floatingPins.length > 0
            ? ('inferred_partial' as const)
            : ('native_aggregate_only' as const),
      };
    } catch (error) {
      deps.logRecoverableError('design.erc: floating-pin inference failed', error);
      return {
        ...result,
        inferredFloatingPins: [],
        detailSource: 'native_aggregate_only' as const,
      };
    }
  }

  return { runDrc, runErc, runRuleCheck, runSchematicCheck };
}
