# JLCPCB Quote Workflow Gating

The JLCPCB quote workflow is quote-only. It prepares a non-binding quote snapshot, risk summary, and audit event for human review.

The workflow does not perform vendor commerce actions. It only prepares review evidence.

## Tool

```text
easyeda_jlcpcb_quote_workflow
```

The tool is read-only and does not call the EasyEDA bridge. It is intended to be used after manufacturing files, export manifest, PCB production review, and QA artifacts are ready.

## Supported workflow actions

```text
estimate
verify_quote
place_order
```

`estimate` and `verify_quote` prepare review evidence. `place_order` is accepted only as an intent signal and is always blocked by this package.

## Always-blocked commerce operations

The tool output includes an `unsupported_operations` array. These entries represent vendor-side commerce actions that are intentionally outside this MCP package.

Complete any procurement step manually in an approved external workflow after human review.

## Confirmation text

For commerce-like intent, the audit event only counts confirmation when the user provides this exact text:

```text
I understand this quote workflow is non-binding and no paid order will be placed by this tool
```

Even with valid confirmation, commerce-like execution remains blocked. Confirmation is recorded only as audit evidence.

## Gate inputs

```text
vendorTermsReviewed
productionFilesReady
exportManifestVerified
productionReviewPassed
confirmation
quote
```

Missing terms review, missing production files, or missing production review create warnings. Invalid board specs create errors. Assembly-related quote review requires a verified export manifest.

## Output

```text
allowed
status
quote.non_binding
risk.level
issues
audit
unsupported_operations
```

`allowed=true` means the quote snapshot is ready for human review. It does not mean any external vendor action will run.

## Vendor limitations

Quote values can change because fabrication options, assembly options, shipping, taxes, coupons, account status, vendor review and lead time are external to this package. Treat every quote as estimated or non-binding unless it is verified directly in an approved vendor workflow.
