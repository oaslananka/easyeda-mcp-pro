# Temporary picomatch ReDoS mitigation

The lockfile keeps the original MIT-licensed picomatch@4.0.7 package and applies a transparent
pnpm patchedDependencies source patch for CVE-2026-112366 / GHSA-fc5q-39xc-vjpf.

The patch is a conservative adaptation of the still-unmerged upstream proposal
https://github.com/micromatch/picomatch/pull/262 (reviewed 2026-11-18). It uses the parser's
actual wildcard tokens, collapses narrowly defined single-star repeated branches where the
outer repetition is redundant, and safely rewrites a restricted trailing-star alternative.
Question-mark, capture-sensitive, and unsupported wildcard forms retain the existing literal
fallback. The explicit maxExtglobRecursion: false opt-out remains unchanged.

This is a temporary source-level mitigation, not an official picomatch release or a claim
that arbitrary user-controlled glob patterns are safe. pnpm audit and OSV still identify the
published package version 4.0.7 and the HIGH advisory. Do not allowlist, suppress, or bypass
the required audit gate to merge this change. Issue #1073 tracks the official remediation.

Once an independently verified upstream security release is published, remove
patchedDependencies, update the lockfile, and rerun the full test suite, SCA, and CI.
