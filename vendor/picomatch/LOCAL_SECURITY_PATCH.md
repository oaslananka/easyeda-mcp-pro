# Temporary local picomatch security maintenance

This directory contains the MIT-licensed runtime files from the npm-distributed
`picomatch@4.0.7` (original package name/version retained for transparency).
It is a **source-patched local dependency**, not an official 4.0.8 release.

Security purpose: CVE-2026-112366 / GHSA-fc5q-39xc-vjpf, catastrophic
backtracking in single-branch repeated extglobs. The mitigation starts from
the upstream proposed patch at https://github.com/micromatch/picomatch/pull/238
(retrieved 2026-11-17, diff SHA-256
`36f328df92de7d58965c72725bacb0434fea9f296d9cd03a1fe0f2141248f237`).

**Additional local guard:** unlike PR #238, the parser also literalizes bare
leading-quantifier-only branches, because `+(*)z` and `+(*?)z`
still cause exponential backtracking in the proposed upstream version.
These unusual extglob patterns deliberately become literals rather than match
wildcards. Regular glob matching behavior and build/test contracts are checked
by regression tests.

The `pnpm-workspace.yaml` override is explicit. Note that **`pnpm audit`
does not analyze local directory dependencies against npm advisories**;
a green audit report alone must NOT be interpreted as proof this source is
secure. CI must retain the normal dependency audit, run the bounded ReDoS
regression tests, and inspect source provenance/integrity.

This is a temporary first-party security patch limited to build tooling.
When the upstream package releases a verifiably fixed version, delete this
directory and its override, upgrade the pinned lockfile, and rerun the full
cross-platform/security checks. Do not publish this code as an official
picomatch version.
