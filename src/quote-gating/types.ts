/** Quote workflow gating and confirmation types. */

export type QuoteProvider = 'jlcpcb' | 'custom';
export type QuoteAction = 'estimate' | 'verify_quote' | 'place_order';
export type QuoteWorkflowStatus = 'ready' | 'blocked' | 'requires_confirmation';
export type QuoteRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface QuoteBoardSpec {
  boardCount: number;
  layers: number;
  widthMm: number;
  heightMm: number;
  thicknessMm?: number;
  surfaceFinish?: string;
  solderMask?: string;
  copperWeight?: string;
  assembly?: boolean;
  stencil?: boolean;
}

export interface QuoteCostBreakdownItem {
  item: string;
  cost: number;
}

export interface QuoteCostSnapshot {
  total?: number;
  currency?: string;
  breakdown?: QuoteCostBreakdownItem[];
  estimated: boolean;
  nonBinding: boolean;
  verifiedAt?: string;
  source: 'local-estimate' | 'vendor-api' | 'user-provided';
}

export interface QuoteConfirmationInput {
  confirmed?: boolean;
  confirmationText?: string;
  userId?: string;
  reason?: string;
}

export interface QuoteWorkflowInput {
  provider: QuoteProvider;
  action: QuoteAction;
  projectId?: string;
  board: QuoteBoardSpec;
  quote?: QuoteCostSnapshot;
  confirmation?: QuoteConfirmationInput;
  vendorTermsReviewed?: boolean;
  productionFilesReady?: boolean;
  exportManifestVerified?: boolean;
  productionReviewPassed?: boolean;
  allowedPaidOperations?: boolean;
}

export interface QuoteGateIssue {
  code:
    | 'QUOTE_VENDOR_TERMS_NOT_REVIEWED'
    | 'QUOTE_PRODUCTION_FILES_NOT_READY'
    | 'QUOTE_EXPORT_MANIFEST_NOT_VERIFIED'
    | 'QUOTE_PRODUCTION_REVIEW_NOT_PASSED'
    | 'QUOTE_PAID_OPERATION_UNSUPPORTED'
    | 'QUOTE_CONFIRMATION_REQUIRED'
    | 'QUOTE_NON_BINDING_ESTIMATE'
    | 'QUOTE_BOARD_SPEC_RISK';
  severity: 'error' | 'warning' | 'info';
  message: string;
  remediationHint: string;
  details?: Record<string, unknown>;
}

export interface QuoteAuditEvent {
  id: string;
  createdAt: string;
  provider: QuoteProvider;
  action: QuoteAction;
  projectId?: string;
  confirmed: boolean;
  userId?: string;
  confirmationText?: string;
  reason?: string;
  paidOperationAttempted: boolean;
  paidOperationAllowed: boolean;
}

export interface QuoteWorkflowReport {
  provider: QuoteProvider;
  action: QuoteAction;
  projectId: string;
  status: QuoteWorkflowStatus;
  allowed: boolean;
  quote: QuoteCostSnapshot;
  risk: {
    level: QuoteRiskLevel;
    paidOperation: boolean;
    humanConfirmationRequired: boolean;
    nonBindingEstimate: boolean;
    vendorTermsReviewed: boolean;
  };
  issues: QuoteGateIssue[];
  audit: QuoteAuditEvent;
  summary: string;
}
