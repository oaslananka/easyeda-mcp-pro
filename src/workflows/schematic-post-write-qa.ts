export type QaSource = 'drc' | 'erc' | 'layout' | 'manual-log';

export type QaSeverity = 'error' | 'warning' | 'info';

export type QaCategory =
  | 'duplicate_net_names'
  | 'free_network_no_pins'
  | 'unconnected_pin'
  | 'native_drc_unavailable'
  | 'native_erc_unavailable'
  | 'native_rule_violation'
  | 'uncategorized';

export type QaPolicy = 'circuit' | 'diagnostic-fixture';

export type QaStatus = 'pass' | 'fail' | 'inconclusive';

export interface NativeRuleViolationInput {
  rule?: string;
  description?: string;
  message?: string;
  severity?: QaSeverity;
  net?: string;
  component?: string;
}

export interface NativeRuleRunInput {
  not_available?: boolean;
  error?: string;
  violations?: NativeRuleViolationInput[];
  total_violations?: number;
  error_count?: number;
  warning_count?: number;
  passed?: boolean;
  inferred_floating_pins?: Array<{ primitiveId?: string; designator?: string; pinNumber?: string }>;
}

export interface ClassifiedQaIssue {
  source: QaSource;
  category: QaCategory;
  severity: QaSeverity;
  fatal: boolean;
  message: string;
  rule?: string;
  net?: string;
  component?: string;
  remediation_hint: string;
}

export interface PostWriteQaInput {
  projectId: string;
  policy?: QaPolicy;
  drc?: NativeRuleRunInput;
  erc?: NativeRuleRunInput;
}

export interface PostWriteQaSummary {
  project_id: string;
  status: QaStatus;
  passed: boolean;
  policy: QaPolicy;
  issue_count: number;
  fatal_count: number;
  warning_count: number;
  inconclusive_count: number;
  categories: Record<QaCategory, number>;
  issues: ClassifiedQaIssue[];
  summary: string;
}

const CATEGORY_ZERO: Record<QaCategory, number> = {
  duplicate_net_names: 0,
  free_network_no_pins: 0,
  unconnected_pin: 0,
  native_drc_unavailable: 0,
  native_erc_unavailable: 0,
  native_rule_violation: 0,
  uncategorized: 0,
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function classifyDescription(description: string): QaCategory {
  const lower = description.toLowerCase();
  if (lower.includes('multiple net names') || lower.includes('duplicate net'))
    return 'duplicate_net_names';
  if (lower.includes('free network') && lower.includes('no pins')) return 'free_network_no_pins';
  if (lower.includes('no pins attached')) return 'free_network_no_pins';
  if (lower.includes('unconnected') && lower.includes('pin')) return 'unconnected_pin';
  if (lower.includes('floating') && lower.includes('pin')) return 'unconnected_pin';
  return 'uncategorized';
}

function normalizeSeverity(value: string | undefined, fallback: QaSeverity): QaSeverity {
  return value === 'error' || value === 'warning' || value === 'info' ? value : fallback;
}

function policyFatal(category: QaCategory, severity: QaSeverity, policy: QaPolicy): boolean {
  if (category === 'duplicate_net_names') return true;
  if (category === 'unconnected_pin') return true;
  if (category === 'native_drc_unavailable' || category === 'native_erc_unavailable') return false;
  if (category === 'free_network_no_pins') return policy === 'circuit';
  return severity === 'error';
}

function remediationHint(category: QaCategory, policy: QaPolicy): string {
  switch (category) {
    case 'duplicate_net_names':
      return 'Do not stamp the same native netName repeatedly on merged wire segments; seed the net once and continue same-net segments unlabeled.';
    case 'free_network_no_pins':
      return policy === 'diagnostic-fixture'
        ? 'Allowed for diagnostic fixtures that intentionally draw wire-only nets. Real circuits must connect each named net to at least one component pin.'
        : 'Connect the named net to component pins, or remove the orphan wire/net flag before accepting the generated circuit.';
    case 'unconnected_pin':
      return 'Connect the expected pin, mark it as intentional no-connect where valid, or update the circuit template connectivity expectations.';
    case 'native_drc_unavailable':
      return 'Native DRC details were not available from the EasyEDA runtime. Capture/manual DRC-log ingestion is required before accepting a production schematic.';
    case 'native_erc_unavailable':
      return 'Native ERC details were not available from the EasyEDA runtime. Capture/manual ERC-log ingestion is required before accepting a production schematic.';
    case 'native_rule_violation':
      return 'Inspect the native rule violation and update routing/layout or component placement before release.';
    case 'uncategorized':
      return 'Review the warning manually and add a classifier rule if this warning recurs in live testing.';
  }
}

function pushNativeUnavailable(
  issues: ClassifiedQaIssue[],
  source: 'drc' | 'erc',
  error: string | undefined,
): void {
  const category: QaCategory =
    source === 'drc' ? 'native_drc_unavailable' : 'native_erc_unavailable';
  issues.push({
    source,
    category,
    severity: 'warning',
    fatal: false,
    message: error
      ? `${source.toUpperCase()} unavailable: ${error}`
      : `${source.toUpperCase()} unavailable`,
    remediation_hint: remediationHint(category, 'circuit'),
  });
}

function classifyViolation(
  source: 'drc' | 'erc',
  violation: NativeRuleViolationInput,
  policy: QaPolicy,
): ClassifiedQaIssue {
  const description = normalizeText(
    violation.description || violation.message || violation.rule || 'Rule violation',
  );
  const category = classifyDescription(description);
  const severity = normalizeSeverity(
    violation.severity,
    category === 'uncategorized' ? 'warning' : 'error',
  );
  const normalizedCategory =
    category === 'uncategorized' && severity === 'error' ? 'native_rule_violation' : category;
  return {
    source,
    category: normalizedCategory,
    severity,
    fatal: policyFatal(normalizedCategory, severity, policy),
    message: description,
    rule: normalizeText(violation.rule) || undefined,
    net: normalizeText(violation.net) || undefined,
    component: normalizeText(violation.component) || undefined,
    remediation_hint: remediationHint(normalizedCategory, policy),
  };
}

function classifyNativeRun(
  source: 'drc' | 'erc',
  run: NativeRuleRunInput | undefined,
  policy: QaPolicy,
): ClassifiedQaIssue[] {
  const issues: ClassifiedQaIssue[] = [];
  if (!run) return issues;
  if (run.not_available) {
    pushNativeUnavailable(issues, source, run.error);
    return issues;
  }

  for (const violation of run.violations ?? []) {
    issues.push(classifyViolation(source, violation, policy));
  }

  if (source === 'erc') {
    for (const pin of run.inferred_floating_pins ?? []) {
      const designator = normalizeText(pin.designator) || 'unknown component';
      const pinNumber = normalizeText(pin.pinNumber) || 'unknown pin';
      const message = `Unconnected inferred pin ${designator}.${pinNumber}`;
      const category: QaCategory = 'unconnected_pin';
      issues.push({
        source: 'erc',
        category,
        severity: 'error',
        fatal: policyFatal(category, 'error', policy),
        message,
        component: designator,
        remediation_hint: remediationHint(category, policy),
      });
    }
  }

  const total = run.total_violations ?? 0;
  if (total > 0 && issues.length === 0) {
    const category: QaCategory = 'native_rule_violation';
    const severity: QaSeverity = (run.error_count ?? 0) > 0 ? 'error' : 'warning';
    issues.push({
      source,
      category,
      severity,
      fatal: policyFatal(category, severity, policy),
      message: `${source.toUpperCase()} reported ${total} violation(s), but detailed violations were not available.`,
      remediation_hint: remediationHint(category, policy),
    });
  }

  return issues;
}

export interface NativeQaBridge {
  call<TParams = Record<string, unknown>, TResult = unknown>(
    method: string,
    params?: TParams,
  ): Promise<TResult>;
}

function normalizeRuleSeverity(severity: string | undefined): QaSeverity | undefined {
  return severity === 'error' || severity === 'warning' || severity === 'info'
    ? severity
    : undefined;
}

export async function collectNativeRuleRunsForPostWriteQa(
  bridge: NativeQaBridge,
  projectId: string,
  options: { drc?: boolean; erc?: boolean } = { drc: true, erc: true },
): Promise<{ drc?: NativeRuleRunInput; erc?: NativeRuleRunInput }> {
  let drc: NativeRuleRunInput | undefined;
  let erc: NativeRuleRunInput | undefined;

  if (options.drc ?? true) {
    try {
      const result = (await bridge.call('design.drc', { projectId })) as {
        violations?: Array<{
          rule?: string;
          description?: string;
          severity?: string;
          net?: string;
          component?: string;
        }>;
        totalViolations?: number;
        errorCount?: number;
        warningCount?: number;
      };
      drc = {
        violations: result.violations?.map((v) => ({
          ...v,
          severity: normalizeRuleSeverity(v.severity),
        })),
        total_violations: result.totalViolations,
        error_count: result.errorCount,
        warning_count: result.warningCount,
      };
    } catch (err) {
      drc = { not_available: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (options.erc ?? true) {
    try {
      const result = (await bridge.call('design.erc', { projectId })) as {
        violations?: Array<{
          description?: string;
          severity?: string;
          net?: string;
          component?: string;
        }>;
        totalViolations?: number;
        errorCount?: number;
        warningCount?: number;
        inferredFloatingPins?: Array<{
          primitiveId?: string;
          designator?: string;
          pinNumber?: string;
        }>;
      };
      erc = {
        violations: result.violations?.map((v) => ({
          ...v,
          severity: normalizeRuleSeverity(v.severity),
        })),
        total_violations: result.totalViolations,
        error_count: result.errorCount,
        warning_count: result.warningCount,
        inferred_floating_pins: result.inferredFloatingPins,
      };
    } catch (err) {
      erc = { not_available: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { drc, erc };
}

export function classifyPostWriteQa(input: PostWriteQaInput): PostWriteQaSummary {
  const policy = input.policy ?? 'circuit';
  const issues = [
    ...classifyNativeRun('drc', input.drc, policy),
    ...classifyNativeRun('erc', input.erc, policy),
  ];
  const categories: Record<QaCategory, number> = { ...CATEGORY_ZERO };
  for (const issue of issues) categories[issue.category] += 1;

  const fatalCount = issues.filter((issue) => issue.fatal).length;
  const inconclusiveCount = issues.filter(
    (issue) =>
      issue.category === 'native_drc_unavailable' || issue.category === 'native_erc_unavailable',
  ).length;
  const warningCount = issues.filter(
    (issue) => issue.severity === 'warning' && !issue.fatal,
  ).length;
  const status: QaStatus =
    fatalCount > 0 ? 'fail' : inconclusiveCount > 0 ? 'inconclusive' : 'pass';

  return {
    project_id: input.projectId,
    status,
    passed: status === 'pass',
    policy,
    issue_count: issues.length,
    fatal_count: fatalCount,
    warning_count: warningCount,
    inconclusive_count: inconclusiveCount,
    categories,
    issues,
    summary:
      status === 'pass'
        ? 'Post-write QA passed.'
        : status === 'inconclusive'
          ? 'Post-write QA is inconclusive because native rule details were unavailable.'
          : `Post-write QA failed with ${fatalCount} fatal issue(s).`,
  };
}
