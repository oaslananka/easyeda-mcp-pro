# ADR 0002: Dependency Management using Renovate

## Status

Accepted

## Context

Third-party dependencies must be kept up to date to receive security patches and performance improvements. However, updating packages can introduce regressions or break runtime execution. We need a dependency automation tool that:

1. Allows automated merging for safe updates (e.g. devDependencies) if tests pass.
2. Holds runtime updates for manual inspection.
3. Groups related packages (e.g., eslint toolchain, compiler utilities) to minimize PR noise.
4. Protects the codebase against malicious package takeovers (zero-day poisonings).

## Decision

We choose **Renovate** as our dependency automation provider.

- Renovate will be configured via `.github/renovate.json`.
- We enforce a **3-day minimum release age** for NPM packages to filter out poisoned versions before they are proposed.
- We enable **Dependency Dashboard** to review major updates and approve them.
- We enable weekly lockfile maintenance to refresh transient dependencies.
- We define grouping rules:
  - ESLint toolchain group: `eslint`, `@eslint/js`, `typescript-eslint`.
  - Development toolchain group: `typescript`, `tsx`, `vitest`, `vitepress`.
  - All other runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `jose`, `ws`, `undici`) are processed individually.
- We configure **automerge** for patch/minor updates of `devDependencies` if CI passes. We do not automerge `dependencies` (runtime packages).

## Consequences

- **Pros**:
  - Eliminates manual effort in tracking and upgrading development tools.
  - Mitigates security risks by filtering out newly published packages (< 3 days old).
  - Groups updates to reduce pull request and CI pipeline noise.
- **Cons**:
  - Auto-merged PRs require robust unit and integration testing in CI to catch any regressions.

## Addendum: Renovate vs. Dependabot (2026-07)

Renovate is the **only** tool that opens automated dependency-update pull requests in this repository, for both npm packages (`renovate.json` default manager) and GitHub Actions (`matchManagers: ["github-actions"]` group). A `.github/dependabot.yml` version-update config is intentionally **not** present, so that two bots cannot open competing or duplicate update PRs for the same dependency.

GitHub's platform-level Dependabot features — dependency graph, Dependabot alerts, and Dependabot security updates — remain **enabled** as vulnerability _detection_ (Settings > Security & analysis; see `docs/REPOSITORY_GOVERNANCE.md#5-maintainer-setup-checklist`). Those features do not require a `dependabot.yml` file; only Dependabot's _version-update_ PR feature does, and that is the piece this repository delegates to Renovate.

## Addendum: time-bounded audit exceptions (2026-07-22)

`pnpm security:audit` is the blocking dependency-audit command for pull requests and releases. It
runs `pnpm audit --json` and rejects every finding unless an exact, repository-owned exception is
present in `.github/dependency-audit-allowlist.json`.

Exceptions are deliberately narrow and fail closed:

- high and critical advisories can never be allowlisted;
- the advisory ID, package, resolved version, and severity must all match;
- each entry must record an owner, reachability rationale, tracking issue, review date, and expiry;
- new, changed, escalated, expired, or stale exceptions fail CI;
- broad audit suppression flags are not permitted.

The first exception tracked `GHSA-frvp-7c67-39w9` in #334 because the affected Windows
path-traversal logic was isolated to the separate `@hono/node-server/serve-static` export and the
repository used only the package-root `getRequestListener` path through
`@modelcontextprotocol/sdk@1.29.0`. Issue #382 removed that exception after pinning the transitive
adapter to patched `@hono/node-server@2.0.10` and proving MCP HTTP and Remote Relay compatibility.
There are currently no active dependency-audit exceptions.
