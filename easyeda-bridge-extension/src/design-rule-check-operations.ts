import type { ApiRuntime } from './api-runtime.js';

export type DrcSeverity = 'error' | 'warning' | 'info';

export interface DrcResult {
  violations: Array<Record<string, unknown>>;
  totalViolations: number;
  errorCount: number;
  warningCount: number;
  passed: boolean;
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

function normalizeSeverity(raw: string): DrcSeverity {
  const value = raw.toLowerCase();
  if (value.includes('fatal') || value.includes('error')) return 'error';
  if (value.includes('warn')) return 'warning';
  return 'info';
}

function scalarString(value: unknown): string | undefined {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : undefined;
}

function joinScalarValues(values: unknown[]): string {
  return values
    .map(scalarString)
    .filter((value): value is string => value !== undefined)
    .join(' ');
}

function firstScalarValue(values: unknown[]): string {
  for (const value of values) {
    const scalar = scalarString(value);
    if (scalar !== undefined) return scalar;
  }
  return 'unknown';
}

function normalizeViolation(item: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = item && typeof item === 'object' ? { ...item } : {};
  const explanation =
    obj.explanation && typeof obj.explanation === 'object'
      ? (obj.explanation as Record<string, unknown>).str
      : undefined;
  const message =
    obj.message ?? obj.msg ?? obj.description ?? obj.text ?? obj.detail ?? explanation ?? item;
  const severitySource = joinScalarValues([
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
    rule: firstScalarValue([
      obj.rule,
      obj.ruleName,
      obj.ruleTypeName,
      obj.errorType,
      obj.name,
      obj.type,
    ]),
    description: typeof message === 'string' ? message : JSON.stringify(message),
    severity: normalizeSeverity(severitySource),
    net: obj.net ?? obj.netName ?? undefined,
    component: obj.component ?? obj.ref ?? obj.designator ?? obj.primitiveId ?? undefined,
    location:
      typeof position.x === 'number' && typeof position.y === 'number'
        ? { x: position.x, y: position.y, layer: obj.layer as string | undefined }
        : undefined,
  };
}

function normalizeAggregate(
  obj: Record<string, unknown>,
): { severity: DrcSeverity; count: number } | null {
  if (typeof obj.count !== 'number') return null;
  const title = Array.isArray(obj.title) ? joinScalarValues(obj.title) : obj.title;
  const source = joinScalarValues([
    obj.type,
    obj.severity,
    obj.level,
    obj.errorType,
    obj.errorObjType,
    obj.name,
    title,
  ]);
  return { severity: normalizeSeverity(source), count: obj.count };
}

function hasLeafDetail(obj: Record<string, unknown>): boolean {
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

function normalizeNode(item: unknown): {
  violations: Array<Record<string, unknown>>;
  aggregates: Array<{ severity: DrcSeverity; count: number }>;
} {
  const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  if (!obj) return { violations: [normalizeViolation(item)], aggregates: [] };

  const children = Array.isArray(obj.list) ? obj.list : [];
  if (children.length > 0) {
    const normalized = children.map(normalizeNode);
    const violations = normalized.flatMap((entry) => entry.violations);
    const aggregates = normalized.flatMap((entry) => entry.aggregates);
    if (violations.length > 0 || aggregates.length > 0) return { violations, aggregates };
  }

  if (hasLeafDetail(obj)) return { violations: [normalizeViolation(obj)], aggregates: [] };
  const aggregate = normalizeAggregate(obj);
  return { violations: [], aggregates: aggregate ? [aggregate] : [] };
}

export function createDesignRuleCheckOperations(
  dependencies: DesignRuleCheckDependencies,
): DesignRuleCheckOperations {
  async function runNative(paths: string[]): Promise<DrcResult> {
    const raw = await dependencies.callFirst(paths, true, true, true);
    const normalized = (Array.isArray(raw) ? raw : []).map(normalizeNode);
    const detailed = normalized.flatMap((entry) => entry.violations);
    const aggregates = normalized.flatMap((entry) => entry.aggregates);
    const violations = [
      ...detailed,
      ...aggregates
        .filter((entry) => entry.count > 0)
        .map((entry) => ({
          rule: 'aggregate',
          description:
            `${entry.count} ${entry.severity}(s) reported by EasyEDA's native design/electrical rule ` +
            'check. Per-violation detail is only shown in EasyEDA Pro when the API returns aggregate counts.',
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

  async function runDrc(): Promise<DrcResult> {
    try {
      return await runNative(['PCB_Drc.check']);
    } catch (error) {
      throw dependencies.createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'PCB DRC is unavailable in the current editor context.',
        'Open and focus a PCB document, then retry design.drc.',
        { cause: dependencies.errorMessage(error) },
      );
    }
  }

  async function runRuleCheck(): Promise<DrcResult> {
    let pcbError: unknown;
    try {
      return await runNative(['PCB_Drc.check']);
    } catch (error) {
      pcbError = error;
      dependencies.logRecoverableError(
        'design.ruleCheck: PCB DRC unavailable; trying schematic ERC/DRC',
        error,
      );
    }
    try {
      return await runNative(['SCH_Drc.check']);
    } catch (schematicError) {
      throw dependencies.createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'No active PCB or schematic canvas is available for design.ruleCheck.',
        'Open and focus a PCB or schematic document, then retry.',
        {
          pcbCause: dependencies.errorMessage(pcbError),
          schematicCause: dependencies.errorMessage(schematicError),
        },
      );
    }
  }

  async function runErc(): ReturnType<DesignRuleCheckOperations['runErc']> {
    const result = await runNative(['SCH_Drc.check']);
    try {
      const { floatingPins } = await dependencies.findFloatingPins();
      return {
        ...result,
        inferredFloatingPins: floatingPins,
        detailSource:
          floatingPins.length > 0
            ? ('inferred_partial' as const)
            : ('native_aggregate_only' as const),
      };
    } catch (error) {
      dependencies.logRecoverableError('design.erc: floating-pin inference failed', error);
      return {
        ...result,
        inferredFloatingPins: [],
        detailSource: 'native_aggregate_only' as const,
      };
    }
  }

  return { runDrc, runErc, runRuleCheck, runSchematicCheck };
}
