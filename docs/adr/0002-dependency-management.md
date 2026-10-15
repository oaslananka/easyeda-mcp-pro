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
- We enable **Dependency Dashboard** to review major updates and approve them.
- We enable weekly lockfile maintenance to refresh transient dependencies.
- We define grouping rules:
  - ESLint toolchain group: `eslint`, `@eslint/js`, `typescript-eslint`.
  - Development toolchain group: `typescript`, `tsx`, `vitest`, `vitepress`.
  - All other runtime dependencies (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `express`, `zod`, `jose`, `ws`, `undici`) are processed individually.
- We configure **automerge** for patch/minor updates of `devDependencies` and weekly lockfile maintenance only after required CI passes. Runtime dependencies, GitHub Actions, pre-commit hooks, and major updates require maintainer review.

## Consequences

- **Pros**:
  - Eliminates manual effort in tracking and upgrading development tools.
  - Groups updates to reduce pull request and CI pipeline noise.
- **Cons**:
  - Auto-merged PRs require robust unit and integration testing in CI to catch any regressions.

## Addendum: Renovate vs. Dependabot (2026-07)

Renovate is the **only** tool that opens automated dependency-update pull requests in this repository, for both npm packages (`renovate.json` default manager) and GitHub Actions (`matchManagers: ["github-actions"]` group). A `.github/dependabot.yml` version-update config is intentionally **not** present, so that two bots cannot open competing or duplicate update PRs for the same dependency.

GitHub's platform-level Dependabot features — dependency graph, Dependabot alerts, and Dependabot security updates — remain **enabled** as vulnerability _detection_ (Settings > Security & analysis; see `docs/REPOSITORY_GOVERNANCE.md#5-maintainer-setup-checklist`). Those features do not require a `dependabot.yml` file; only Dependabot's _version-update_ PR feature does, and that is the piece this repository delegates to Renovate.

The repository configuration and the hosted provider are separate controls. For Mend-hosted Renovate, the Mend Renovate App must be installed with access to this repository and the repository job must run in Interactive mode. The config file alone cannot establish that account-level state. Operational verification is the presence of the Renovate-created **Dependency Dashboard** or Renovate-authored update activity; if both are absent, investigate the provider installation and job log instead of enabling another version-update bot.

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

## Addendum: CI throughput and atomic runtime updates (2026-10)

Renovate PR creation is bounded to three concurrent update PRs and one new PR per hour.
These limits regulate **new** PR creation; they do not automatically close older PRs.
Related, low-risk npm development utilities are grouped, while release/production,
Actions, and major changes continue to require review. Pre-1.0 development packages
do not auto-merge solely on a minor/patch version label.

Node.js and pnpm patch updates require Dependency Dashboard approval because the
repository pins these versions across runtime policy, Docker digests, documentation,
workflows, and package metadata. Do not approve an isolated runtime update PR without
preparing all required atomic changes described in CONTRIBUTING.md.

The scheduled advisory monitor no longer re-runs on dependency-only manifest changes:
the PR's required quality pipeline already runs the blocking audit, and dependency
review remains a required check. The full Linux/Windows/macOS matrix remains required,
but its OS jobs run sequentially to reduce peak shared GitHub Actions runner pressure.
Superseded PR CI is cancelled; main and tag validation are deliberately not cancelled.

GitHub's strict up-to-date requirement remains enabled. Mergify's conservative manual
queue is unchanged until a single verified merge authority, merge protections, and
ruleset compatibility have been demonstrated in a live PR. Do not remove required
checks merely to save CI minutes.

## Addendum: bounded rebase pressure (2026-10)

Review-gated runtime dependencies, overrides, major updates, GitHub Actions, pre-commit
hooks, and runtime toolchain pins use `rebaseWhen: conflicted`. This prevents
non-automerge PRs from all rebasing just because an unrelated dependency update merged.
For these review-gated PRs, select one PR at a time and request an explicit refresh
against current `main` **before** its final protected CI and squash merge.
Development patch/minor PRs approved for automerge and lockfile maintenance keep
Renovate's default behind-base validation to avoid automatically merging untested
combined versions. GitHub's strict required-checks ruleset remains unchanged;
never merge a behind-base PR by bypassing the ruleset.

## Addendum: postpone major/runtime PR creation instead of rerunning CI (2026-10)

Multiple long-lived major update PRs share the same pnpm lockfile. Even with
`rebaseWhen: conflicted`, a single patch merge can cause lockfile conflicts
and force many expensive PR reruns. Existing major PRs are therefore deferred
rather than kept continuously up-to-date.

Major dependency updates and Node/pnpm runtime version pins require Dashboard
approval, never auto-merge, and use `rebaseWhen: never` plus
`recreateWhen: never`. Their PRs can be closed with a recorded reason and
later explicitly recreated through the Dependency Dashboard when a deliberate
migration is scheduled. These are intentional exceptions to Renovate's usual
recommendation to automatically rebase; they are **never** eligible for
automatic merge or bypass of required checks.

When an approved update is recreated, regenerate it against current `main`,
synchronize all runtime pin files and lockfiles atomically if applicable,
run every required security and CI check, and only then use protected squash
merge. Low-risk development dependencies and urgent advisory remediation
remain on their existing automated paths.
