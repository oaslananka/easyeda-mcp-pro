import { describe, it, expect } from 'vitest';
import { evaluateQuoteWorkflow } from '../../../src/quote-gating/index.js';
import { QUOTE_CONFIRMATION_TEXT } from '../../../src/quote-gating/workflow.js';

const board = {
  boardCount: 5,
  layers: 2,
  widthMm: 50,
  heightMm: 30,
  surfaceFinish: 'ENIG',
};

describe('evaluateQuoteWorkflow', () => {
  it('allows quote estimate workflow for human review without paid action', () => {
    const report = evaluateQuoteWorkflow({
      provider: 'jlcpcb',
      action: 'estimate',
      projectId: 'proj-quote',
      board,
      vendorTermsReviewed: true,
      productionFilesReady: true,
      exportManifestVerified: true,
      productionReviewPassed: true,
      quote: {
        total: 12.34,
        currency: 'USD',
        estimated: true,
        nonBinding: true,
        source: 'local-estimate',
      },
    });

    expect(report.allowed).toBe(true);
    expect(report.status).toBe('ready');
    expect(report.risk.nonBindingEstimate).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'QUOTE_NON_BINDING_ESTIMATE')).toBe(true);
    expect(report.audit.paidOperationAttempted).toBe(false);
  });

  it('warns when terms and production readiness are missing', () => {
    const report = evaluateQuoteWorkflow({
      provider: 'jlcpcb',
      action: 'verify_quote',
      projectId: 'proj-quote',
      board,
    });

    expect(report.allowed).toBe(true);
    expect(report.status).toBe('ready');
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'QUOTE_VENDOR_TERMS_NOT_REVIEWED',
        'QUOTE_PRODUCTION_FILES_NOT_READY',
        'QUOTE_PRODUCTION_REVIEW_NOT_PASSED',
        'QUOTE_NON_BINDING_ESTIMATE',
      ]),
    );
    expect(report.risk.level).toBe('medium');
  });

  it('blocks invalid board quote specs', () => {
    const report = evaluateQuoteWorkflow({
      provider: 'jlcpcb',
      action: 'estimate',
      board: { ...board, widthMm: 0 },
      vendorTermsReviewed: true,
      productionFilesReady: true,
      productionReviewPassed: true,
    });

    expect(report.allowed).toBe(false);
    expect(report.status).toBe('blocked');
    expect(report.issues.some((issue) => issue.code === 'QUOTE_BOARD_SPEC_RISK')).toBe(true);
  });

  it('blocks order-like action even with explicit confirmation', () => {
    const report = evaluateQuoteWorkflow({
      provider: 'jlcpcb',
      action: 'place_order',
      projectId: 'proj-quote',
      board,
      vendorTermsReviewed: true,
      productionFilesReady: true,
      exportManifestVerified: true,
      productionReviewPassed: true,
      allowedPaidOperations: true,
      confirmation: {
        confirmed: true,
        confirmationText: QUOTE_CONFIRMATION_TEXT,
        userId: 'user-1',
        reason: 'approval evidence test',
      },
    });

    expect(report.allowed).toBe(false);
    expect(report.status).toBe('blocked');
    expect(report.risk.level).toBe('critical');
    expect(report.audit.confirmed).toBe(true);
    expect(report.audit.paidOperationAttempted).toBe(true);
    expect(report.audit.paidOperationAllowed).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'QUOTE_PAID_OPERATION_UNSUPPORTED')).toBe(
      true,
    );
  });

  it('requires exact confirmation evidence for order-like intent', () => {
    const report = evaluateQuoteWorkflow({
      provider: 'jlcpcb',
      action: 'place_order',
      projectId: 'proj-quote',
      board,
      confirmation: { confirmed: true, confirmationText: 'yes', userId: 'user-1' },
    });

    expect(report.audit.confirmed).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'QUOTE_CONFIRMATION_REQUIRED')).toBe(true);
  });
});
