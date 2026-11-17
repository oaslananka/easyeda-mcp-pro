# Temporary picomatch ReDoS patch

The lockfile installs original MIT-licensed `picomatch@4.0.7` with a transparent
`pnpm patchedDependencies` source patch. CVE-2026-112366 / GHSA-fc5q-39xc-vjpf.

The patch starts from the unmerged upstream proposal
https://github.com/micromatch/picomatch/pull/238 (reviewed 2026-11-17).
The proposal's bare-only cases `+(*)z` and `+(*?)z` **still timed out** in
bounded tests, so this local patch also literalizes bare leading-quantifier
branches. Unusual patterns such as `+(*)` are intentionally treated as
literals; normal source globs remain covered by integration tests.

**Important:** `pnpm audit` and OSV will still flag `picomatch@4.0.7` by
published package version; they do not recognize this source-level patch as an
upstream security release. Do not ignore or bypass HIGH checks to merge this
change. This patch reduces local development exposure but does not meet the
independent release gate on its own. Issue #1073 tracks official remediation.

Once an independently verified upstream security release exists, remove
`patchedDependencies`, update the lockfile and rerun tests, SCA and CI.
