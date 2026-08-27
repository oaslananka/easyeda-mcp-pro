# Release Process

This document describes how the repository implements the channel, validation, and recovery rules in the authoritative [Release Policy](RELEASE_POLICY.md). The **Release Please PR** workflow automates stable version bumps and changelog PRs; the separate **Publish Release** workflow owns gated immutable release creation and registry publication; numbered release candidates use an explicit manual path that cannot update stable moving tags.

## 1. Conventional Commits

We enforce the [Conventional Commits specification](https://www.conventionalcommits.org/). Version bumping is determined by the commit prefixes pushed to `main`:

| Commit prefix                     | SemVer bump | Description                                                               |
| --------------------------------- | ----------- | ------------------------------------------------------------------------- |
| `fix:`                            | Patch       | A backwards-compatible bug fix.                                           |
| `feat:`                           | Minor       | A backwards-compatible feature.                                           |
| `feat!:` or `BREAKING CHANGE:`    | Major       | A breaking public change with migration and deprecation evidence.         |
| `chore:`, `docs:`, `test:`, `ci:` | None        | Internal or documentation-only change unless release notes say otherwise. |

## 2. Channel mapping

| Channel    | Version/tag                                  | npm      | GitHub Release | GHCR                       | MCP Registry |
| ---------- | -------------------------------------------- | -------- | -------------- | -------------------------- | ------------ |
| Stable     | `X.Y.Z` / `easyeda-mcp-pro-vX.Y.Z`           | `latest` | non-prerelease | exact, `X.Y`, and `latest` | publish      |
| Prerelease | `X.Y.Z-rc.N` / `easyeda-mcp-pro-vX.Y.Z-rc.N` | `next`   | prerelease     | exact and `next`           | skip         |

Release Please remains stable-only (`prerelease: false`). The PR manager uses `skip-github-release: true`, so merging a release PR does not create a tag or GitHub Release until the Publish Release workflow has completed its pre-publication gates. Manual workflow dispatch validates that the supplied tag, requested channel, `package.json` version, public evidence URL, and GitHub Release classification all agree before publication.

## 3. Stable automation

```mermaid
graph TD
    A[Conventional commits merge to main] --> B[Release Please PR workflow opens or updates stable release PR]
    B --> C[Maintainer verifies policy evidence and required gates]
    C --> D[Merge release PR]
    D --> E[Publish Release detects exact release commit]
    E --> F[Compatibility and quality gates run against exact commit]
    F --> G[Build extension, SBOM, and attestations]
    G --> H[Publish Release creates immutable tag and GitHub Release]
    H --> I[Publish npm, assets, MCP Registry, and GHCR]
    I --> J[Verify registries, docs, and evidence]
```

The Release Please PR updates `package.json`, `.release-please-manifest.json`, `server.json`, `easyeda-bridge-extension/extension.json`, release-managed TypeScript version constants, plugin metadata, and `CHANGELOG.md`. Do not manually create the normal stable tag. The automated gates finish **before the immutable tag and GitHub Release are created**.

When the final `rc.N` already contains all user-facing changes, Release Please can legitimately report `No user facing commits found` and skip opening the stable PR. In that case, create a reviewed promotion-only PR whose squash-merge commit body contains `Release-As: X.Y.Z` for the intended stable version. The promotion PR must not change runtime code, runtime dependencies, generated executable artifacts, or compatibility-sensitive behavior; it only seeds the stable Release Please PR after the final candidate has otherwise satisfied release policy. Never use `Release-As` to waive a failed release gate.

## 4. Prerelease automation

A prerelease is prepared in an ordinary reviewed candidate PR. The PR sets all release-managed versions to `X.Y.Z-rc.N`, updates release notes, and links the public evidence record. After merge:

```bash
TAG=easyeda-mcp-pro-vX.Y.Z-rc.N

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
gh release create "$TAG" --verify-tag --prerelease --generate-notes
gh workflow run publish-release.yml --ref main \
  -f tag_name="$TAG" \
  -f release_channel=prerelease \
  -f evidence_url=https://github.com/oaslananka/easyeda-mcp-pro/issues/NUMBER
```

The Publish Release workflow checks out the exact tag, verifies that the GitHub Release is non-draft and marked prerelease, reruns all gates, publishes npm with `--provenance --tag next`, publishes exact and `next` GHCR tags, uploads the extension, SBOM, and tag-bound portable Sigstore bundle and in-toto provenance asset, and skips the MCP Registry.

Published `1.0.0-rc.N` candidates retain the legacy EasyEDA install manifest mapping `0.99.N`, so their immutable package identities and monotonic upgrade to stable `1.0.0` do not change. Disposable EasyEDA Pro 3.2.149 validation later confirmed that standard `1.0.1-rc.N` SemVer package identities are accepted, persist across restart, and upgrade to stable `1.0.1`; only that patch-RC family is explicitly passed through. Other prerelease families fail closed until an explicit mapping is reviewed and live-validated.

Release Please and GitHub Release asset mutations authenticate with the repository-scoped `RELEASE_PLEASE_TOKEN`. This avoids the permission ceiling of a restricted merge integration while keeping npm publication on OIDC Trusted Publishing. The token is not exposed to build, test, npm, MCP Registry, or GHCR steps.

## 5. Release-blocking gates

Stable promotion has no time-based waiting gate. Once the release PR is reviewable and the exact candidate satisfies required checks and release evidence, it may proceed to publication. The publication workflow still fails closed before immutable release creation on source ancestry, channel/version identity, commit-bound EasyEDA compatibility evidence, and the full quality/security sequence. The publication job remains **Gate and publish immutable release**, making that mutation boundary explicit in workflow logs.

Before publication begins, `pnpm release:readiness:compatibility` must confirm that at least one live
EasyEDA record is current for the exact candidate commit. The release workflow runs this command
after runtime and dependency installation and before the remaining quality gates. Any later change
under the configured compatibility-sensitive paths makes older evidence stale and blocks both stable
and prerelease publication until a new disposable-project live run is recorded.

An `unavailable` result is also blocking. It means the candidate cannot be tied safely to Git history
or valid compatibility evidence; release automation must not reinterpret it as current. Publication
therefore requires a complete Git checkout even though archive-style source snapshots remain valid
for ordinary build and test verification.

Both channels must pass:

- supported Node.js and pnpm runtime preflight;
- dependency audit and peer-dependency checks;
- Prettier, TypeScript server/extension typechecks, ESLint, tool metadata, and tool coverage checks;
- server tests and coverage plus extension tests and coverage;
- generated tool-reference drift check and documentation build;
- server build, extension build, extension distribution verification, and extension size budgets;
- Docker loopback, fail-closed, and published-host-port smoke; CodeQL; Semgrep; Sonar; Codecov; dependency review; workflow/container security; and required platform CI checks;
- SBOM generation, npm provenance, GitHub artifact attestation, and a portable Sigstore bundle and in-toto provenance asset named `<tag>.provenance.sigstore.json` and `<tag>.intoto.jsonl`. The npm path uses npm Trusted Publishing. For first publication, new npm versions use Trusted Publishing without `NPM_TOKEN`; `NPM_TOKEN` is restricted to existing-version dist-tag recovery.

The evidence record must also satisfy the live EasyEDA validation rules in the Release Policy. Automation success alone does not waive those requirements. The full local convenience command is `pnpm release:readiness`; it intentionally fails before the expensive quality sequence when the compatibility evidence is stale.

## 6. Publication and verification

After a successful workflow:

1. verify the npm version and channel dist-tag;
2. verify GitHub Release draft/prerelease state and required assets;
3. verify extension checksums, artifact attestations, and the portable Sigstore bundle and in-toto provenance asset;
4. verify exact and moving GHCR tags point to the expected digest;
5. verify the MCP Registry only for stable releases;
6. verify deployed documentation describes the released version and support claims;
7. require the **Verify published release** workflow step to pass and archive `published-release.json`;
8. publish the final evidence comment before announcing or closing the tracking issue.

GitHub Actions keeps only bounded operational copies: SBOM workflow artifact: `14 days`; published-release verification artifact: `30 days`. The immutable GitHub Release assets, attestations, checksums, and public evidence record remain the long-lived release evidence and are not governed by these workflow-artifact retention windows.

See [Release Verification](RELEASE_VERIFICATION.md) for commands and [Release & CI Runbook](release-ci-runbook.md) for failure recovery.

## 7. Failed releases and emergency publication

For a transient failure, rerun the original workflow only when the tag, commit, channel, and evidence are unchanged **and that original run already contains every currently mandatory release gate**. If release policy was hardened after the failed attempt, do not rerun the historical workflow execution: dispatch the current `publish-release.yml` from `main` against the exact audited source and public evidence. A code, dependency, generated artifact, or release-metadata change requires a new version; never overwrite an immutable release.

Normal stable releases must use Release Please. Manual stable dispatch is allowed only for the documented **missing stable release identity recovery** path (exact reviewed release commit, no immutable stable identity yet) or the Emergency patch procedure. Emergency dispatch requires an existing stable-format tag, a non-draft/non-prerelease GitHub Release, and a public evidence URL. Both paths run the current quality, compatibility, provenance, and registry gates; neither is a shortcut around release policy.

If publication partially succeeds, stop promotion claims and follow the rollback/yanking sequence in the Release Policy plus the registry-specific procedures in [Solo-maintainer continuity and release recovery](SOLO_MAINTAINER_RECOVERY.md). Keep immutable tags, SBOMs, checksums, attestations, and the public evidence issue for auditability. Manual recovery runs use the current workflow policy from `main` and then build the immutable requested tag.
