# Contributing Guide

Welcome! We appreciate your contributions to `easyeda-mcp-pro`. Please review these guidelines to ensure a smooth contribution process.

---

## 1. Local Development Setup

Use Node.js **24.x** (pinned development version **24.18.0**) and exactly **pnpm 11.5.1**. The repository fails before install/build/test when these runtimes drift.

```bash
nvm install 24.18.0
nvm use 24.18.0
corepack enable
corepack prepare pnpm@11.5.1 --activate
node scripts/check-runtime.mjs --require-pnpm
```

```bash
# Clone the repository
git clone https://github.com/oaslananka/easyeda-mcp-pro.git
cd easyeda-mcp-pro

# Install dependencies
pnpm install --frozen-lockfile

# Sync versions, compile TS, and build the extension
pnpm build
pnpm build:extension
```

### The dev hot-loop (no extension re-import)

The extension is split into a **loader** (`easyeda-bridge-extension/src/index.ts` — socket
lifecycle, rarely changes) and a **dispatcher** (`src/dispatcher.ts` — every EasyEDA API
interaction). In dev mode the server pushes a rebuilt dispatcher bundle over the bridge and the
loader swaps it in live, so you almost never re-import the `.eext`:

```bash
# One-time: build a dev extension (hot-swap compiled in) and import the .eext in EasyEDA Pro
pnpm --filter @easyeda-mcp-pro/bridge-extension build:dev

# Terminal 1 — server with hot-swap auto-push (tsx watch restarts on server changes)
pnpm dev:hotloop

# Terminal 2 — rebuild dispatcher + repackage on every extension source change
pnpm dev:extension
```

Edit `dispatcher.ts` → esbuild rebuilds in <1 s → the server pushes the new build → the next tool
call runs the new code. `easyeda_dev_hot_swap` (dev profile) gives manual push/revert/status, and
`easyeda_run_self_test` fails loudly with `method_registry_match` when the extension serves stale
dispatch logic. Re-importing the `.eext` is only needed when the **loader** itself changes.
Hot swap is refused in production (`BRIDGE_HOT_SWAP_ENABLED` guard) and marketplace builds compile
the swap path out entirely.

---

## 2. Quality Gates Checklist

Before proposing a pull request, you must ensure that all local quality checks pass:

```bash
# Verify formatting (Prettier)
pnpm format:check

# TypeScript typechecks
pnpm typecheck
pnpm typecheck:extension

# Linting check
pnpm lint

# Unit tests
pnpm test

# Build checks
pnpm build
pnpm build:extension
pnpm verify:extension

# Renovate config validation (if you modified .github/renovate.json)
npx --yes -p renovate renovate-config-validator .github/renovate.json
```

Install and run the fast local hook described in [Local Security Tooling](docs/development/security-tooling.md). Pre-commit checks file hygiene plus GitHub Actions syntax and security; whole-repository Semgrep, Trivy, Snyk, and SonarQube analysis stays in CI or explicit maintainer commands.

---

## 3. Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) to track changes and automate version bumps. All commit messages and pull request titles must use one of the following formats:

- `fix(scope): desc` -> Triggers a **PATCH** release (e.g. `fix(bridge): resolve timeout error`)
- `feat(scope): desc` -> Triggers a **MINOR** release (e.g. `feat(schematic): add wire tool`)
- `feat!(scope): desc` or `BREAKING CHANGE:` -> Triggers a **MAJOR** release (e.g. `feat!(bridge): change JSON protocol`)
- `chore(deps): desc` -> Updates a runtime dependency (no release)
- `chore(deps-dev): desc` -> Updates a dev dependency (no release)
- `ci(deps): desc` -> Updates a GitHub Action (no release)
- `docs: desc`, `test: desc`, `ci: desc` -> Non-release updates

---

## 4. Renovate PR Review Policy

- **DevDependency Auto-merging**: Patch/minor updates to `devDependencies` are automatically merged by Renovate once CI checks pass.
- **Runtime Dependencies**: Upgrades to runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `jose`, `ws`, `undici`) must be reviewed and merged manually by maintainers.
- **Major Updates**: All major version upgrades require explicit approval on the **Dependency Dashboard** or manual pull request review.

---

## 5. Release Please Lifecycle

The authoritative channel, soak, live-validation, emergency, and rollback requirements are in the [Release Policy](docs/RELEASE_POLICY.md).

1. Conventional commits merged into `main` create or update a stable **Release PR** through Release Please.
2. Do not manually edit or tag the normal stable release. Merge only after the documented evidence and soak requirements are complete.
3. Numbered `X.Y.Z-rc.N` candidates use the reviewed manual prerelease procedure; they publish to npm/GHCR `next` and never move stable tags.
4. Every release workflow re-verifies quality/security gates, builds and verifies the EasyEDA extension, creates SBOM/provenance evidence, and publishes only to the selected channel.

---

## 6. Developer Certificate of Origin (DCO)

By contributing to this project, you certify that you have the right to submit the contribution under the project license and that you agree to the [Developer Certificate of Origin](https://developercertificate.org/).

Every non-trivial commit should include a `Signed-off-by` trailer:

```text
Signed-off-by: Your Name <you@example.com>
```

You can add this automatically with:

```bash
git commit -s
```

Pull requests with substantial code, documentation, CI, or release-process changes may be asked to add missing sign-off trailers before merge.

---

## 7. Coding Standards

Contributions must follow the standards enforced by the repository tooling:

- **TypeScript / JavaScript:** strict TypeScript configuration, ESLint, and Prettier.
- **Markdown / YAML / JSON:** Prettier formatting where covered by repository configuration.
- **Runtime validation:** untrusted inputs should use explicit schema validation, preferably Zod schemas already used by the project.
- **Security-sensitive code:** default-deny behavior, log redaction for secrets, and explicit confirmation for write operations.
- **Error handling:** return structured errors that explain the failed operation without leaking credentials or private design data.

The required local checks are listed in [Quality Gates Checklist](#2-quality-gates-checklist). CI enforces the same general rules for pull requests and protected branches.

---

## 8. Testing Policy

Major new functionality must include tests unless the change is documentation-only or cannot be meaningfully tested in CI. The expected test level depends on the change:

- Tool schema or validation changes: unit tests for valid and invalid inputs.
- Bridge protocol changes: protocol/manager tests or golden fixtures.
- Supplier integrations: mocked API tests and negative-path tests for errors, credentials, and rate limits.
- CLI/setup changes: tests for generated configuration and failure messages where practical.
- Security fixes: regression tests for the fixed behavior when a public test is safe to include.

Bug fixes should add regression tests for at least 50% of fixed bugs over a six-month window. If a regression test cannot be added, the pull request should explain why.

Coverage is measured with:

```bash
pnpm test:coverage
```

The project target is at least 80% statement coverage where coverage tooling applies.

---

## 9. Branching Strategy

- Create every feature/fix branch from the latest `main`, and open every pull request directly against `main`. Do not stack a branch's pull request on top of another feature branch — a chain of sequential branch-to-branch merges can silently never reach `main` if one link in the chain is merged out of order or left unmerged.
- Keep pull requests scoped to a single unit of work (one feature, one fix, one focused refactor). Prefer several small pull requests merged in sequence over one branch that accumulates many unrelated commits before opening a pull request — small PRs are easier to review, bisect, and revert independently.

---

## 10. Pull Request Review Expectations

Pull requests must also satisfy the provider-owned checks and failure-triage policy in [Changed-code quality gates](docs/QUALITY_GATES.md).

A pull request should include:

- a concise description of the change,
- the risk level and affected area,
- local validation commands that were run,
- tests for new functionality or security-sensitive changes,
- documentation updates when behavior, configuration, or public workflows change.

The authoritative ownership and review requirements are in [Repository Governance](docs/REPOSITORY_GOVERNANCE.md). Critical security, release, remote-transport, bridge, and mutation paths require independent human review whenever an eligible reviewer exists. The current solo-maintainer enforcement limitation must be stated publicly rather than represented as independent approval. Every bot and agent finding must be resolved or explicitly dispositioned before merge, and emergency exceptions require a public rationale, rollback target, and follow-up review within two business days.
