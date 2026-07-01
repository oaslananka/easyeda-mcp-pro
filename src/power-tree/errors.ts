/** Power-tree analyzer issue factories. */

import type { PowerTreeIssue, PowerTreeIssueCode, PowerTreeSeverity } from './types.js';

export function powerIssue(
  code: PowerTreeIssueCode,
  severity: PowerTreeSeverity,
  message: string,
  opts: {
    railId?: string;
    railName?: string;
    componentRef?: string;
    remediationHint: string;
    details?: Record<string, unknown>;
  },
): PowerTreeIssue {
  return {
    code,
    severity,
    message,
    railId: opts.railId,
    railName: opts.railName,
    componentRef: opts.componentRef,
    remediationHint: opts.remediationHint,
    details: opts.details,
  };
}

export function powerError(
  code: PowerTreeIssueCode,
  message: string,
  opts: Omit<Parameters<typeof powerIssue>[3], never>,
): PowerTreeIssue {
  return powerIssue(code, 'error', message, opts);
}

export function powerWarning(
  code: PowerTreeIssueCode,
  message: string,
  opts: Omit<Parameters<typeof powerIssue>[3], never>,
): PowerTreeIssue {
  return powerIssue(code, 'warning', message, opts);
}
