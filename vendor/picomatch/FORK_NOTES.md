# First-party picomatch fork

This directory contains a temporary, first-party maintained fork of the MIT-licensed
picomatch 4.0.7 package. Its package identity is @oaslananka/picomatch 4.0.7-oaslananka.1.
It is used only by the repository development/test/documentation toolchain; it is not
included in the production dependency tree or the published EasyEDA MCP Pro package.

## Provenance

- Upstream: https://github.com/micromatch/picomatch
- Upstream version: 4.0.7
- Official npm tarball: https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz
- Verified npm integrity: sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==
- License: MIT; the upstream LICENSE and copyright notices are retained.
- Security-patched lib/parse.js SHA-256 (LF-normalized): fe3f64c8d898df5d1f73fec276b2d76a78a9db1562dfde6b21e76f2e575ad445.
- Security issue: GHSA-fc5q-39xc-vjpf / CVE-2026-112366.

## Security changes

The parser mitigation is a conservative adaptation of the still-unmerged upstream
proposal https://github.com/micromatch/picomatch/pull/262. It inspects parsed wildcard
tokens, collapses narrowly defined single-star repeated branches where repetition is
semantically redundant, and safely rewrites a restricted trailing-star alternative.
Capture-sensitive and unsupported wildcard forms retain the literal fallback. The
maxExtglobRecursion: false opt-out remains unchanged.

The source is covered by tests/unit/repository/picomatch-hardening.test.ts, including
ordinary glob parity, unsupported/capture fallback, actual Vite/Vitest/tinyglobby
resolution, and bounded child-process ReDoS regressions.

## Maintenance and removal

This fork is a temporary compatibility/security measure, not an upstream release and
not a claim that arbitrary attacker-controlled glob patterns are safe. Keep the upstream
advisory tracked in repository issue #1073 even while this fork is used. Do not suppress
or allowlist the upstream HIGH advisory.

When upstream publishes an independently verified fixed release, compare its source and
tests, replace this local fork with the official package, regenerate the frozen lockfile,
remove the Docker vendor copy, and rerun the full cross-platform tests and SCA.
