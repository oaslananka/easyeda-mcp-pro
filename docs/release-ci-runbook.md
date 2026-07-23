# Release & CI Runbook

How to triage and resolve failed CI checks, release-please PRs, and dependency PRs.

## Quick Reference

| Signal                                      | What It Means             | First Action                        |
| ------------------------------------------- | ------------------------- | ----------------------------------- |
| CI ❌ on main                               | Release blocker           | Read log, identify failing gate     |
| Release PR ❌                               | Version release blocked   | Check CI status, fix the failure    |
| Release PR ✅                               | Can create a new release  | Merge the PR                        |
| Dependency PR ❌                            | Update blocked            | Check if CI is already red on main  |
| Dependency Dashboard shows pending approval | Major update needs review | Review changelog, approve or reject |

## Required CI Gates

The following gates must pass on main, release PRs, and dependency PRs:

| Gate                | Command                     | Priority                     |
| ------------------- | --------------------------- | ---------------------------- |
| Format check        | `pnpm format:check`         | Must pass                    |
| TypeScript check    | `pnpm typecheck`            | Must pass                    |
| Extension typecheck | `pnpm typecheck:extension`  | Must pass                    |
| Lint                | `pnpm lint`                 | Must pass with zero warnings |
| Unit tests          | `pnpm test`                 | Must pass                    |
| Build               | `pnpm build`                | Must pass                    |
| Extension build     | `pnpm build:extension`      | Must pass                    |
| Extension tests     | `pnpm test:extension:ci`    | Must pass                    |
| Extension verify    | `pnpm verify:extension`     | Must pass                    |
| Extension size      | `pnpm check:extension-size` | Must pass                    |
| CodeQL              | (CI only)                   | Must pass                    |
| Docker build        | (CI only)                   | Must pass if release created |

## Common Failure Modes

### 1. `pnpm format:check` fails

**Symptoms**: Prettier reports unformatted files.

**Root cause**: Usually one of:

- A `.json` file written by `scripts/sync-versions.mjs` during `pnpm build` does not match Prettier style.
- A contributor committed code without running `pnpm format`.

**Fix**:

```bash
# Re-format everything
pnpm format

# Then verify the fix
pnpm format:check
```

If `scripts/sync-versions.mjs` produced the unformatted output, check that it runs `prettier --write` on the files it modifies (it should, but if not, fix the script).

### 2. `pnpm install --frozen-lockfile` fails

**Symptoms**: Lockfile drift — `pnpm-lock.yaml` does not match `package.json`.

**Root cause**: Someone ran `pnpm install` (without `--frozen-lockfile`) and committed package.json changes but not lockfile changes, or vice versa.

**Fix**:

```bash
# Regenerate lockfile locally
pnpm install
# Commit the updated lockfile
git add pnpm-lock.yaml
git commit -m "chore(deps): update lockfile"
```

### 3. Test failures

**Symptoms**: `pnpm test` reports failures.

**Root cause**: Code change broke a test; or a test relies on an external dependency that is unavailable.

**Fix**: Run locally and examine the failure. If it's an EasyEDA Pro bridge-dependent test and no bridge is available, check whether the test is properly guarded with a conditional skip. Do not delete or `.skip` failing tests — fix the code or add proper guards.

### 4. Release-please PR has no CI run

**Symptoms**: Release PR shows no CI check results.

**Root cause**: The CI workflow is triggered by `pull_request` targeting `main`. If the release PR was created with a GITHUB_TOKEN that doesn't have permission to trigger workflows, checks may not run.

**Fix**: Close and re-open the release PR to re-trigger CI. If that fails, push a trivial commit to the release PR branch.

### 5. Release PR has merge conflicts

**Symptoms**: `Mergeable: CONFLICT` or `MergeStateStatus: DIRTY`.

**Root cause**: The release PR's version bumps conflict with changes merged to main after the PR was created.

**Fix**:

```bash
# Checkout the release branch
gh pr checkout 3
# Rebase on latest main
git rebase main
# Force push (release-please will re-read the branch)
git push --force-with-lease
```

## Dependency PRs: Dependabot vs Renovate

This repository uses **Renovate** for all dependency management. Dependabot is disabled for GitHub Actions to avoid duplicate PRs.

### Renovate Behavior

| Update Type          | Auto-merge? | Notes                                                |
| -------------------- | ----------- | ---------------------------------------------------- |
| Patch deps           | ✅ Yes      | Low risk                                             |
| Minor devDeps        | ✅ Yes      | Low risk                                             |
| Major updates        | ❌ No       | Requires manual approval on the Dependency Dashboard |
| Lockfile maintenance | ✅ Yes      | Runs weekly                                          |

### Dependency Dashboard

The [Dependency Dashboard](https://github.com/oaslananka/easyeda-mcp-pro/issues/1) shows all pending updates. Open it to:

- Approve major updates that need manual review
- See which updates are blocked by failing CI
- Check for vulnerability alerts

### Triaging a Failed Dependency PR

1. **Check if CI is already red on main**. If so, fix main first — the dependency PR will pass after rebase.
2. **Check if the failure is pre-existing**. E.g., a test that was already flaky. In that case, note it on the PR and do not block the dependency update.
3. **Check if the dependency introduced a breaking change**. Look at the release notes or changelog. If it's a major version, it may need code changes in this repo.
4. **If the failure is caused by the update itself**, you have two options:
   - Fix the code to accommodate the breaking change, then merge.
   - Close the PR and pin the old version with a comment explaining why.

## Manual Release Procedure

Normal stable releases are created by merging the Release Please PR. Manual dispatch is reserved for numbered prereleases and the documented emergency stable path in the [Release Policy](RELEASE_POLICY.md).

### Numbered prerelease

1. Merge a reviewed candidate PR whose version is `X.Y.Z-rc.N` and whose public issue/PR contains soak, verification, live-validation, and rollback evidence.
2. Create the annotated tag and a non-draft GitHub prerelease for the exact candidate commit.
3. Dispatch the release workflow:

   ```bash
   TAG=easyeda-mcp-pro-vX.Y.Z-rc.N
   EVIDENCE=https://github.com/oaslananka/easyeda-mcp-pro/issues/NUMBER

   git tag -a "$TAG" -m "$TAG"
   git push origin "$TAG"
   gh release create "$TAG" --verify-tag --prerelease --generate-notes
   gh workflow run release-please.yml --ref "$TAG" \
     -f tag_name="$TAG" \
     -f release_channel=prerelease \
     -f evidence_url="$EVIDENCE"
   ```

4. Verify npm `next`, GHCR `next`, exact-version assets, SBOM, provenance, and attestations. Confirm npm/GHCR `latest` did not move and the MCP Registry was skipped.

### Emergency stable dispatch

Use only when the Release Policy's Emergency patch criteria are met. The stable-format tag and non-prerelease GitHub Release must already exist, and the evidence URL must identify the incident and rollback target:

```bash
gh workflow run release-please.yml --ref easyeda-mcp-pro-vX.Y.Z \
  -f tag_name=easyeda-mcp-pro-vX.Y.Z \
  -f release_channel=stable \
  -f evidence_url=https://github.com/oaslananka/easyeda-mcp-pro/issues/NUMBER
```

The workflow rejects a channel/tag mismatch, package-version mismatch, draft release, incorrect GitHub prerelease classification, or evidence URL outside this repository.

## Verifying Release Safety

Before deciding a release is safe:

- [ ] `pnpm install --frozen-lockfile` succeeds
- [ ] `pnpm format:check` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm typecheck:extension` passes
- [ ] `pnpm lint` has 0 errors (warnings OK)
- [ ] `pnpm test` and `pnpm test:coverage` pass
- [ ] `pnpm test:extension:ci` passes
- [ ] `pnpm build` produces clean output
- [ ] `pnpm build:extension`, `pnpm verify:extension`, and `pnpm check:extension-size` pass
- [ ] No open security alerts for critical vulnerabilities
- [ ] All required status checks are passing on main

## Monitoring

- **CI status**: [![CI](https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml)
- **Dependency Dashboard**: [Issue #1](https://github.com/oaslananka/easyeda-mcp-pro/issues/1)
- **Renovate Dashboard**: Available via GitHub app
- **CodeQL**: Runs on every push and PR
- **Socket.dev**: Dependency vulnerability scanning on every PR

## Release Artifact Verification

For every public release, verify:

```bash
npm view easyeda-mcp-pro version dist-tags time.modified --json
gh release view easyeda-mcp-pro-vX.Y.Z --json tagName,isDraft,isPrerelease,assets
gh release view easyeda-mcp-pro-vX.Y.Z-rc.N --json tagName,isDraft,isPrerelease,assets
```

Expected release assets:

- `easyeda-bridge-extension.eext` — EasyEDA extension package
- `sbom.json` — CycloneDX SBOM attached to the release

Expected workflow evidence:

- npm publish uses provenance when supported by npm/GitHub Actions
- GitHub release includes build provenance attestation
- stable GHCR images include the exact version, minor tag, and `latest`; prereleases include the exact version and `next` only
- `pnpm verify:extension` reports marketplace metadata, documentation, logo, checksum, and phone-like-content checks

If any asset is missing, do not promote the release as marketplace-ready. Re-run or fix the release workflow before announcing the version.
