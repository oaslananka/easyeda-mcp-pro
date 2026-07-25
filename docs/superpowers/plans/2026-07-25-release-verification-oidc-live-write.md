# Verified OIDC Release and Live Write Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal npm publication OIDC-only, verify every published registry target after release, record machine-readable live EasyEDA write/rollback evidence, align OpenSSF documentation, and publish a fully verified `0.35.4` patch release.

**Architecture:** A focused release-verification module will compare normalized npm, GitHub Release, GHCR, MCP Registry, and Git observations. `publish-release.yml` will publish new npm versions only through Trusted Publishing, retain `NPM_TOKEN` solely for existing-version dist-tag recovery, and run the verifier after all registry mutations. The existing self-cleaning schematic transaction smoke will emit a stable JSON report that can be converted into commit-bound public evidence before the release PR is merged.

**Tech Stack:** Node.js 24.18.0, TypeScript 6, pnpm 11.5.1, Vitest 4, GitHub Actions, npm Trusted Publishing/OIDC, GitHub CLI/API, GHCR, MCP Registry, EasyEDA Pro bridge transaction tooling.

## Global Constraints

- Repository: `oaslananka/easyeda-mcp-pro`.
- Release target: stable patch version `0.35.4` through the normal Release Please flow.
- Stable tag: `easyeda-mcp-pro-v0.35.4`; stable npm dist-tag: `latest`.
- A first publication must not read or pass `NPM_TOKEN` to `npm publish`.
- `NPM_TOKEN` may be used only when the exact package version already exists and its dist-tag requires repair.
- Release verification must fail when npm, GitHub Release, GHCR, MCP Registry, release assets, or Git commit identity disagree.
- Verification must write JSON and append a human-readable summary to `GITHUB_STEP_SUMMARY` when available.
- Live mutation tests must run only against disposable `TestMcp / Schematic1 / P1` with explicit write opt-in.
- Live smoke must leave primitive inventory, components, nets, and comparable ERC state equal to baseline.
- No Windows live-runtime claim is added in this implementation.
- No plaintext credential, npm token, GitHub token, or bridge token may be committed.
- Third-party GitHub Actions remain pinned to full commit SHAs.

---

### Task 1: Pure published-release comparison

**Files:**

- Create: `src/release/published-release-verifier.ts`
- Create: `tests/unit/release/published-release-verifier.test.ts`

**Interfaces:**

- Consumes: normalized registry observations.
- Produces: `ReleaseVerificationExpectation`, `ReleaseVerificationObservation`, `ReleaseVerificationCheck`, `ReleaseVerificationReport`, and `verifyPublishedReleaseObservation(expectation, observation)`.

- [ ] **Step 1: Write failing tests for a complete stable release and every mismatch class**

Create tests for npm version, npm dist-tag, npm provenance state, GitHub tag/commit/classification/assets, GHCR tags, MCP Registry version/latest, prerelease MCP exclusion, and aggregated failures. Use this base fixture:

```ts
const expectation = {
  repository: 'oaslananka/easyeda-mcp-pro',
  packageName: 'easyeda-mcp-pro',
  mcpName: 'io.github.oaslananka/easyeda-mcp-pro',
  version: '0.35.4',
  tag: 'easyeda-mcp-pro-v0.35.4',
  channel: 'stable',
  npmDistTag: 'latest',
  commitSha: 'a'.repeat(40),
  requiredAssets: ['easyeda-bridge-extension.eext', 'sbom.json'],
  requiredGhcrTags: ['0.35.4', '0.35', 'latest'],
} as const;
```

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
pnpm vitest run tests/unit/release/published-release-verifier.test.ts
```

Expected: failure because the verifier module does not exist.

- [ ] **Step 3: Implement normalized types and pure checks**

The verifier must emit checks with IDs `npm-version`, `npm-dist-tag`, `npm-provenance`, `github-tag`, `github-tag-commit`, `github-classification`, `github-assets`, `ghcr-tags`, and `mcp-registry`. Each check contains `status`, `expected`, `actual`, and an optional `message`. `report.ok` is true only when all required checks pass. A provenance observation may be `passed`, `failed`, or `unverified`; stable workflow publication requires either registry proof or workflow-context proof.

- [ ] **Step 4: Re-run focused tests and confirm GREEN**

```bash
pnpm vitest run tests/unit/release/published-release-verifier.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/release/published-release-verifier.ts tests/unit/release/published-release-verifier.test.ts
git commit -m "feat: add published release consistency verifier"
```

### Task 2: Registry observation CLI and deterministic reports

**Files:**

- Create: `scripts/verify-published-release.mjs`
- Create: `tests/unit/repository/published-release-cli.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `--repository`, `--tag`, `--channel`, `--commit`, `--report-json`, `--summary-file`, public APIs, and optional fixture input.
- Produces: deterministic JSON, Markdown summary, and exit code `1` on failed required checks.

- [ ] **Step 1: Write failing fixture-driven CLI tests**

Tests must spawn the CLI with `RELEASE_VERIFY_FIXTURE_PATH` and cover passing stable data, multiple mismatches, tag/package version disagreement, and prerelease behavior. Fixture mode must enter the same normalization/comparison path as live mode.

- [ ] **Step 2: Run and confirm RED**

```bash
pnpm vitest run tests/unit/repository/published-release-cli.test.ts
```

- [ ] **Step 3: Implement live adapters**

Use these sources:

```text
npm view easyeda-mcp-pro@<version> version dist --json
npm view easyeda-mcp-pro dist-tags --json
gh release view <tag> --repo <repo> --json tagName,targetCommitish,isDraft,isPrerelease,assets
git rev-parse <tag>^{commit}
gh api /users/<owner>/packages/container/<package>/versions?per_page=100
GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<mcpName>&version=<version>
```

Select the GHCR record containing the exact version tag and require all moving tags on the same digest. Require non-empty digests for `easyeda-bridge-extension.eext` and `sbom.json`. Never print token values.

- [ ] **Step 4: Add package script**

```json
"release:verify-published": "node scripts/verify-published-release.mjs"
```

- [ ] **Step 5: Run tests and live read-only verification against `0.35.3`**

```bash
pnpm vitest run tests/unit/repository/published-release-cli.test.ts
node scripts/verify-published-release.mjs \
  --repository oaslananka/easyeda-mcp-pro \
  --tag easyeda-mcp-pro-v0.35.3 \
  --channel stable \
  --commit 790dab44c5215a5931361aa968a19e2c463961fd \
  --report-json /tmp/easyeda-v0.35.3-release-verification.json
```

Expected: registry identity checks pass. If npm does not expose provenance in public metadata, it is reported as `unverified`, not fabricated as passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-published-release.mjs tests/unit/repository/published-release-cli.test.ts package.json
git commit -m "feat: verify published release targets"
```

### Task 3: OIDC-only first publication and mandatory final gate

**Files:**

- Modify: `.github/workflows/publish-release.yml`
- Modify: `tests/unit/repository/release-policy.test.ts`
- Modify: `tests/unit/repository/security-tooling-policy.test.ts`

**Interfaces:**

- Consumes: Task 2 package script and release environment.
- Produces: OIDC-only new publication, token-scoped recovery, report artifact, and required final consistency gate.

- [ ] **Step 1: Add failing policy assertions**

Require these properties:

```ts
expect(publisher).toContain('npm publish --provenance --tag "$NPM_DIST_TAG"');
expect(publisher).not.toContain('NODE_AUTH_TOKEN="$NPM_TOKEN" npm publish');
expect(publisher).toContain('NODE_AUTH_TOKEN="$NPM_TOKEN" npm dist-tag add');
expect(publisher).toContain('name: Verify published release');
expect(publisher).toContain('pnpm release:verify-published');
expect(publisher).toContain('--report-json reports/published-release.json');
expect(publisher).toContain('--summary-file "$GITHUB_STEP_SUMMARY"');
```

Also assert the verification step occurs after `Build and push Docker image`, has no `continue-on-error`, and uploads `reports/published-release.json` with the pinned artifact action.

- [ ] **Step 2: Run and confirm RED**

```bash
pnpm vitest run tests/unit/repository/release-policy.test.ts tests/unit/repository/security-tooling-policy.test.ts
```

- [ ] **Step 3: Restrict npm token use**

Use exactly this branch structure:

```bash
if npm view "${PKG_NAME}@${PKG_VERSION}" version >/dev/null 2>&1; then
  if [[ -z "$NPM_TOKEN" ]]; then
    echo "NPM_TOKEN is required only to repair an existing version dist-tag." >&2
    exit 1
  fi
  NODE_AUTH_TOKEN="$NPM_TOKEN" npm dist-tag add "${PKG_NAME}@${PKG_VERSION}" "$NPM_DIST_TAG"
else
  npm publish --provenance --tag "$NPM_DIST_TAG"
fi
```

Do not set `NODE_AUTH_TOKEN` at job scope.

- [ ] **Step 4: Add post-publication verification and artifact upload**

After container publication:

```bash
mkdir -p reports
RELEASE_COMMIT_SHA="$(git rev-parse "${RELEASE_TAG}^{commit}")"
pnpm release:verify-published -- \
  --repository "$GITHUB_REPOSITORY" \
  --tag "$RELEASE_TAG" \
  --channel "$RELEASE_CHANNEL" \
  --commit "$RELEASE_COMMIT_SHA" \
  --report-json reports/published-release.json \
  --summary-file "$GITHUB_STEP_SUMMARY"
```

Upload the report under `published-release-${RELEASE_TAG}`. The verifier failure must fail the publish job.

- [ ] **Step 5: Run policy tests and workflow linters**

```bash
pnpm vitest run tests/unit/repository/release-policy.test.ts tests/unit/repository/security-tooling-policy.test.ts
pre-commit run actionlint --all-files
pre-commit run zizmor --all-files
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/publish-release.yml tests/unit/repository/release-policy.test.ts tests/unit/repository/security-tooling-policy.test.ts
git commit -m "ci: verify OIDC release publication"
```

### Task 4: Machine-readable live transaction smoke

**Files:**

- Create: `src/live/schematic-transaction-smoke-report.ts`
- Modify: `scripts/live-schematic-transaction-smoke.mts`
- Create: `tests/unit/live/schematic-transaction-smoke-report.test.ts`

**Interfaces:**

- Consumes: transaction outcomes, baseline/final hashes, fixture identity, bridge metadata, cleanup state, and report path.
- Produces: `SchematicTransactionSmokeReport` JSON with stable schema and atomic file writing.

- [ ] **Step 1: Write failing report tests**

Assert a passing report contains fixture `{ project: 'TestMcp', schematic: 'Schematic1', page: 'P1', disposable: true }`, check IDs `create-rollback`, `modify-rollback`, `delete-rollback`, `final-state-restored`, and zero remaining cleanup IDs. Test final-hash failure and cleanup-error serialization.

- [ ] **Step 2: Run and confirm RED**

```bash
pnpm vitest run tests/unit/live/schematic-transaction-smoke-report.test.ts
```

- [ ] **Step 3: Implement report builder and atomic writer**

The report contains `schemaVersion`, `status`, `generatedAt`, `environment`, `fixture`, `bridge`, `checks`, `cleanup`, `baseline`, `finalState`, and optional `error`. Write to a temporary sibling file and rename.

- [ ] **Step 4: Add strict mutation preconditions**

Require all of:

```text
EASYEDA_LIVE_WRITE_TESTS=true
EASYEDA_EXPECTED_PROJECT=TestMcp
EASYEDA_EXPECTED_SCHEMATIC=Schematic1
EASYEDA_EXPECTED_PAGE=P1
```

Read current EasyEDA document identity before mutation and reject missing/mismatched values. Default output path: `.easyeda-mcp-pro/schematic-transaction-smoke-report.json`.

- [ ] **Step 5: Write reports in both success and failure paths**

The failure report must include cleanup failures without suppressing the original failure. The public evidence conversion later must omit temporary primitive IDs and local paths.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run tests/unit/live/schematic-transaction-smoke-report.test.ts
pnpm typecheck
pnpm lint
git add src/live/schematic-transaction-smoke-report.ts scripts/live-schematic-transaction-smoke.mts tests/unit/live/schematic-transaction-smoke-report.test.ts
git commit -m "feat: record live schematic rollback evidence"
```

### Task 5: OpenSSF and operator documentation alignment

**Files:**

- Modify: `docs/OPENSSF_BEST_PRACTICES.md`
- Modify: `docs/RELEASE_VERIFICATION.md`
- Modify: `docs/RELEASE_PROCESS.md`
- Modify: `docs/release-ci-runbook.md`
- Modify: `docs/SOLO_MAINTAINER_RECOVERY.md`
- Modify: `tests/unit/repository/release-policy.test.ts`

**Interfaces:**

- Consumes: final command names and workflow behavior.
- Produces: documentation matching executable release and live-smoke behavior.

- [ ] **Step 1: Add failing documentation assertions**

Require documentation to state:

```text
new npm versions use Trusted Publishing without NPM_TOKEN
NPM_TOKEN is restricted to existing-version dist-tag recovery
Verify published release
published-release.json
create/modify/delete rollback
TestMcp / Schematic1 / P1
provenance and GitHub Artifact Attestations satisfy the project signed-release posture
bus factor remains one
```

- [ ] **Step 2: Run and confirm RED**

```bash
pnpm vitest run tests/unit/repository/release-policy.test.ts
```

- [ ] **Step 3: Align documentation**

Set OpenSSF `signed_releases` to `Met` using npm provenance and GitHub Artifact Attestations. Keep `version_tags_signed` as not the primary signing mechanism with explanation. Keep bus factor honestly at one; add no unavailable reviewer requirement. Document this exact smoke command:

```bash
EASYEDA_LIVE_WRITE_TESTS=true \
EASYEDA_EXPECTED_PROJECT=TestMcp \
EASYEDA_EXPECTED_SCHEMATIC=Schematic1 \
EASYEDA_EXPECTED_PAGE=P1 \
EASYEDA_TRANSACTION_SMOKE_REPORT_PATH=/tmp/easyeda-transaction-smoke.json \
pnpm smoke:schematic-transactions
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm vitest run tests/unit/repository/release-policy.test.ts
pnpm docs:build
git add docs/OPENSSF_BEST_PRACTICES.md docs/RELEASE_VERIFICATION.md docs/RELEASE_PROCESS.md docs/release-ci-runbook.md docs/SOLO_MAINTAINER_RECOVERY.md tests/unit/repository/release-policy.test.ts
git commit -m "docs: align verified release evidence"
```

### Task 6: Full implementation verification and PR

**Files:**

- Verify all files changed by Tasks 1–5.

**Interfaces:**

- Consumes: completed implementation branch.
- Produces: green implementation PR merged to `main`, without directly publishing a version.

- [ ] **Step 1: Run focused tests**

```bash
pnpm vitest run \
  tests/unit/release/published-release-verifier.test.ts \
  tests/unit/repository/published-release-cli.test.ts \
  tests/unit/repository/release-policy.test.ts \
  tests/unit/repository/security-tooling-policy.test.ts \
  tests/unit/live/schematic-transaction-smoke-report.test.ts
```

- [ ] **Step 2: Run full repository gates**

```bash
pnpm verify
pnpm test:coverage
pre-commit run --all-files
git diff --check origin/main...HEAD
```

- [ ] **Step 3: Push and open PR**

Use title:

```text
fix: verify OIDC publication and live rollback evidence
```

The PR body must record risk, rollback, live-test requirement, and verification commands.

- [ ] **Step 4: Wait for all required checks and merge only when green**

Required outcomes include CI quality, Linux/macOS/Windows, CodeQL, dependency review, Semgrep, Trivy/container security, SonarCloud, Codecov, Socket, and workflow-security.

- [ ] **Step 5: Verify post-merge behavior**

The implementation merge commit must not publish directly. `Release Please PR` should prepare `0.35.4`; `Publish Release` should classify the implementation merge as no-op.

### Task 7: Run live write/rollback smoke on the exact `0.35.4` candidate

**Files:**

- Create: `docs/evidence/easyeda-live/2026-07-25-ubuntu-24-04-easyeda-3.2.149-v0.35.4-write-rollback.json`
- Modify: `config/easyeda-compatibility.json`
- Regenerate: compatibility documentation generated by `pnpm generate:compatibility`

**Interfaces:**

- Consumes: exact Release Please candidate SHA, packaged candidate extension, running EasyEDA Pro, and focused disposable fixture.
- Produces: redacted public evidence bound to the exact candidate commit.

- [ ] **Step 1: Record release PR head SHA and install its candidate extension**

Verify package, extension loader, and manifest all report `0.35.4` before smoke execution.

- [ ] **Step 2: Confirm fixture safety**

Focus exactly `TestMcp / Schematic1 / P1`, confirm it is disposable, and ensure no user edit is in progress.

- [ ] **Step 3: Run transaction smoke**

```bash
EASYEDA_LIVE_WRITE_TESTS=true \
EASYEDA_EXPECTED_PROJECT=TestMcp \
EASYEDA_EXPECTED_SCHEMATIC=Schematic1 \
EASYEDA_EXPECTED_PAGE=P1 \
EASYEDA_TRANSACTION_SMOKE_REPORT_PATH=/tmp/easyeda-v0.35.4-transaction-smoke.json \
pnpm smoke:schematic-transactions
```

Expected: create, modify, delete rollback and final-state restoration pass; no disposable primitive remains.

- [ ] **Step 4: Create redacted public evidence**

Include candidate SHA, package version, EasyEDA/OS/bridge identities, fixture identity, four check outcomes, cleanup success, and final-state equality. Exclude temporary primitive IDs, local paths, and credentials.

- [ ] **Step 5: Update compatibility registry and validate freshness**

```bash
pnpm generate:compatibility
pnpm check:compatibility
pnpm release:readiness:compatibility -- --target-ref=<candidate-sha>
```

- [ ] **Step 6: Commit evidence to the release PR branch and rerun all checks**

```bash
git add config/easyeda-compatibility.json docs/evidence/easyeda-live/2026-07-25-ubuntu-24-04-easyeda-3.2.149-v0.35.4-write-rollback.json docs
git commit -m "test: record v0.35.4 live rollback evidence"
```

### Task 8: Publish and independently verify `0.35.4`

**Files:**

- No source edit expected unless the publication verifier exposes a defect.
- Collect workflow report and public registry evidence.

**Interfaces:**

- Consumes: green Release Please `0.35.4` PR with exact live evidence.
- Produces: npm/GitHub/GHCR/MCP Registry `0.35.4`, OIDC proof, verified attestations, and passing `published-release.json`.

- [ ] **Step 1: Merge release PR only after every gate passes**

Confirm package, manifest, changelog, extension metadata, server metadata, MCP metadata, and live evidence all reference `0.35.4` and the exact candidate.

- [ ] **Step 2: Observe publication ordering**

The run must gate, create tag/release, publish npm, upload assets, publish MCP Registry, publish GHCR, then execute `Verify published release`.

- [ ] **Step 3: Prove OIDC path was selected**

Confirm logs executed:

```bash
npm publish --provenance --tag latest
```

Confirm `npm dist-tag add` and token recovery were not executed. Never expose secret values.

- [ ] **Step 4: Independently verify public targets**

```bash
npm view easyeda-mcp-pro@0.35.4 version dist.integrity dist.shasum --json
npm view easyeda-mcp-pro dist-tags --json
gh release view easyeda-mcp-pro-v0.35.4 --repo oaslananka/easyeda-mcp-pro --json tagName,targetCommitish,isDraft,isPrerelease,assets
node scripts/verify-published-release.mjs \
  --repository oaslananka/easyeda-mcp-pro \
  --tag easyeda-mcp-pro-v0.35.4 \
  --channel stable \
  --commit <release-commit-sha> \
  --report-json /tmp/easyeda-v0.35.4-final-verification.json
```

- [ ] **Step 5: Verify attestations**

```bash
gh attestation verify easyeda-bridge-extension.eext --repo oaslananka/easyeda-mcp-pro
gh attestation verify sbom.json --repo oaslananka/easyeda-mcp-pro
```

- [ ] **Step 6: Confirm final state**

```text
npm latest = 0.35.4
GitHub latest release = easyeda-mcp-pro-v0.35.4
GHCR tags 0.35.4, 0.35, latest share one digest
MCP Registry version = 0.35.4 and latest
published-release.json status = passed
no open release PR remains
```

If any target disagrees, preserve immutable tags, use the documented recovery path, and rerun verification.
