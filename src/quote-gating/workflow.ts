import { createHash } from 'node:crypto';
import type {
  QuoteAction,
  QuoteAuditEvent,
  QuoteCostSnapshot,
  QuoteGateIssue,
  QuoteRiskLevel,
  QuoteWorkflowInput,
  QuoteWorkflowReport,
  QuoteWorkflowStatus,
} from './types.js';

const REQUIRED_CONFIRMATION =
  'I understand this quote workflow is non-binding and no paid order will be placed by this tool';

function issue(
  code: QuoteGateIssue['code'],
  severity: QuoteGateIssue['severity'],
  message: string,
  remediationHint: string,
  details?: Record<string, unknown>,
): QuoteGateIssue {
  return { code, severity, message, remediationHint, details };
}

function auditId(input: QuoteWorkflowInput): string {
  return `quote_${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;
}

function paidOperation(action: QuoteAction): boolean {
  return action === 'place_order';
}

function confirmationSatisfied(input: QuoteWorkflowInput): boolean {
  return Boolean(
    input.confirmation?.confirmed === true &&
    input.confirmation.confirmationText === REQUIRED_CONFIRMATION &&
    input.confirmation.userId,
  );
}

function normalizeQuote(input: QuoteWorkflowInput): QuoteCostSnapshot {
  return {
    total: input.quote?.total,
    currency: input.quote?.currency ?? 'USD',
    breakdown: input.quote?.breakdown ?? [],
    estimated: input.quote?.estimated ?? true,
    nonBinding: true,
    verifiedAt: input.quote?.verifiedAt,
    source: input.quote?.source ?? 'local-estimate',
  };
}

function boardSpecRisk(input: QuoteWorkflowInput): QuoteGateIssue[] {
  const issues: QuoteGateIssue[] = [];
  if (
    input.board.boardCount <= 0 ||
    input.board.layers <= 0 ||
    input.board.widthMm <= 0 ||
    input.board.heightMm <= 0
  ) {
    issues.push(
      issue(
        'QUOTE_BOARD_SPEC_RISK',
        'error',
        'Board quote specification contains non-positive dimensions, layer count, or quantity',
        'Provide positive board dimensions, layer count, and quantity before requesting a quote snapshot.',
        { board: input.board },
      ),
    );
  }
  if (input.board.assembly && !input.exportManifestVerified) {
    issues.push(
      issue(
        'QUOTE_EXPORT_MANIFEST_NOT_VERIFIED',
        'error',
        'Assembly quote requires a verified export manifest',
        'Verify Gerber, drill, BOM, pick-place, and QA artifacts before assembly quote review.',
      ),
    );
  }
  return issues;
}

function riskLevel(issues: QuoteGateIssue[], isPaid: boolean): QuoteRiskLevel {
  if (isPaid) return 'critical';
  if (issues.some((entry) => entry.severity === 'error')) return 'high';
  if (issues.some((entry) => entry.severity === 'warning')) return 'medium';
  return 'low';
}

function statusFor(
  issues: QuoteGateIssue[],
  isPaid: boolean,
  confirmed: boolean,
): QuoteWorkflowStatus {
  if (issues.some((entry) => entry.severity === 'error')) return 'blocked';
  if (isPaid && !confirmed) return 'requires_confirmation';
  return 'ready';
}

export function evaluateQuoteWorkflow(input: QuoteWorkflowInput): QuoteWorkflowReport {
  const issues: QuoteGateIssue[] = [];
  const isPaid = paidOperation(input.action);
  const confirmed = confirmationSatisfied(input);
  const quote = normalizeQuote(input);

  issues.push(...boardSpecRisk(input));

  if (!input.vendorTermsReviewed) {
    issues.push(
      issue(
        'QUOTE_VENDOR_TERMS_NOT_REVIEWED',
        'warning',
        'Vendor terms have not been marked as reviewed',
        'Review current vendor terms, supported operations, and account restrictions before relying on quote output.',
      ),
    );
  }

  if (!input.productionFilesReady) {
    issues.push(
      issue(
        'QUOTE_PRODUCTION_FILES_NOT_READY',
        'warning',
        'Production files are not marked as ready',
        'Generate and verify Gerber, drill, BOM, pick-place, manifest, and QA artifacts before quote review.',
      ),
    );
  }

  if (!input.productionReviewPassed) {
    issues.push(
      issue(
        'QUOTE_PRODUCTION_REVIEW_NOT_PASSED',
        'warning',
        'Production review has not passed',
        'Run PCB production review and resolve blocking manufacturing findings before quote review.',
      ),
    );
  }

  if (quote.nonBinding || quote.estimated) {
    issues.push(
      issue(
        'QUOTE_NON_BINDING_ESTIMATE',
        'info',
        'Quote output is an estimate and must be treated as non-binding until verified by the vendor UI or approved API',
        'Show the estimate to a human reviewer and re-check final cost, shipping, taxes, coupons, and lead time before purchase.',
        { source: quote.source, estimated: quote.estimated },
      ),
    );
  }

  if (isPaid) {
    issues.push(
      issue(
        'QUOTE_PAID_OPERATION_UNSUPPORTED',
        'error',
        'Paid/order-like operations are intentionally unsupported by this workflow',
        'Use the vendor UI or an approved external procurement workflow after human review. This tool only prepares quote/audit evidence.',
      ),
    );
    if (!confirmed) {
      issues.push(
        issue(
          'QUOTE_CONFIRMATION_REQUIRED',
          'error',
          'Explicit human confirmation is required for order-like intent',
          `Set confirmation.confirmed=true, confirmation.userId, and confirmation.confirmationText exactly to: ${REQUIRED_CONFIRMATION}`,
        ),
      );
    }
  }

  const status = statusFor(issues, isPaid, confirmed);
  const allowed = status === 'ready' && !isPaid;
  const audit: QuoteAuditEvent = {
    id: auditId(input),
    createdAt: new Date().toISOString(),
    provider: input.provider,
    action: input.action,
    projectId: input.projectId,
    confirmed,
    userId: input.confirmation?.userId,
    confirmationText: input.confirmation?.confirmationText,
    reason: input.confirmation?.reason,
    paidOperationAttempted: isPaid,
    paidOperationAllowed: false,
  };

  const errorCount = issues.filter((entry) => entry.severity === 'error').length;
  const warningCount = issues.filter((entry) => entry.severity === 'warning').length;

  return {
    provider: input.provider,
    action: input.action,
    projectId: input.projectId ?? '',
    status,
    allowed,
    quote,
    risk: {
      level: riskLevel(issues, isPaid),
      paidOperation: isPaid,
      humanConfirmationRequired: isPaid,
      nonBindingEstimate: quote.nonBinding || quote.estimated,
      vendorTermsReviewed: Boolean(input.vendorTermsReviewed),
    },
    issues,
    audit,
    summary: allowed
      ? 'Quote workflow is ready for human review. No paid operation will be performed.'
      : `Quote workflow blocked or requires review: ${errorCount} error(s), ${warningCount} warning(s). No paid operation will be performed.`,
  };
}

export const QUOTE_CONFIRMATION_TEXT = REQUIRED_CONFIRMATION;
