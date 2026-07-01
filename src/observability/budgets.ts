/** Performance and observability budget definitions. */

export type ObservabilityCategory =
  | 'diagnostics'
  | 'bridge-read'
  | 'bridge-write'
  | 'vendor-api'
  | 'cache'
  | 'export'
  | 'analysis'
  | 'documentation';

export interface LatencyBudget {
  category: ObservabilityCategory;
  p50Ms: number;
  p95Ms: number;
  timeoutMs: number;
  description: string;
}

export interface BudgetEvaluation {
  category: ObservabilityCategory;
  durationMs: number;
  budget: LatencyBudget;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export const DEFAULT_LATENCY_BUDGETS: LatencyBudget[] = [
  {
    category: 'diagnostics',
    p50Ms: 50,
    p95Ms: 250,
    timeoutMs: 1000,
    description: 'Local diagnostics and metadata-only tools.',
  },
  {
    category: 'bridge-read',
    p50Ms: 250,
    p95Ms: 1500,
    timeoutMs: 15000,
    description: 'Read-only calls to the EasyEDA bridge.',
  },
  {
    category: 'bridge-write',
    p50Ms: 500,
    p95Ms: 3000,
    timeoutMs: 30000,
    description: 'Confirmed write/apply calls to the EasyEDA bridge.',
  },
  {
    category: 'vendor-api',
    p50Ms: 800,
    p95Ms: 5000,
    timeoutMs: 30000,
    description: 'External vendor API requests including retry overhead.',
  },
  {
    category: 'cache',
    p50Ms: 10,
    p95Ms: 50,
    timeoutMs: 250,
    description: 'SQLite cache and metadata lookups.',
  },
  {
    category: 'export',
    p50Ms: 1000,
    p95Ms: 10000,
    timeoutMs: 60000,
    description: 'Manufacturing/export generation workflows.',
  },
  {
    category: 'analysis',
    p50Ms: 100,
    p95Ms: 1000,
    timeoutMs: 5000,
    description: 'Local DRC/ERC, BOM, power-tree, PCB and QA analysis.',
  },
  {
    category: 'documentation',
    p50Ms: 50,
    p95Ms: 500,
    timeoutMs: 2000,
    description: 'Generated docs, summaries and manifests.',
  },
];

const BUDGETS_BY_CATEGORY = new Map(
  DEFAULT_LATENCY_BUDGETS.map((budget) => [budget.category, budget]),
);

export function getLatencyBudget(category: ObservabilityCategory): LatencyBudget {
  const budget = BUDGETS_BY_CATEGORY.get(category);
  if (!budget) throw new Error(`Unknown latency budget category: ${category}`);
  return budget;
}

export function evaluateLatencyBudget(
  category: ObservabilityCategory,
  durationMs: number,
): BudgetEvaluation {
  const budget = getLatencyBudget(category);
  if (durationMs > budget.timeoutMs) {
    return {
      category,
      durationMs,
      budget,
      status: 'fail',
      message: `${category} duration ${durationMs}ms exceeds timeout budget ${budget.timeoutMs}ms`,
    };
  }
  if (durationMs > budget.p95Ms) {
    return {
      category,
      durationMs,
      budget,
      status: 'warn',
      message: `${category} duration ${durationMs}ms exceeds p95 budget ${budget.p95Ms}ms`,
    };
  }
  return {
    category,
    durationMs,
    budget,
    status: 'ok',
    message: `${category} duration ${durationMs}ms is within budget`,
  };
}
