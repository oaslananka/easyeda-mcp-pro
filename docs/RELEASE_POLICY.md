# Release Policy

This policy defines the public release channels, verification evidence, soak periods, promotion rules, and recovery responsibilities for `easyeda-mcp-pro`. It is authoritative for npm, GitHub Releases, the EasyEDA extension asset, GHCR, the MCP Registry, and the published documentation.

## Ownership

The release manager is `@oaslananka`. The release manager owns channel selection, evidence review, publication, rollback, npm dist-tags, GitHub Release classification, GHCR moving tags, and post-release verification. Security-sensitive releases also follow the incident ownership in `SECURITY.md` and `docs/REPOSITORY_GOVERNANCE.md`.

No release is approved only because a version tag exists. The evidence and channel rules below are release blockers.

## Release channels and identifiers

| Channel    | Version                   | Git tag                       | GitHub Release | npm                   | GHCR                                | MCP Registry   |
| ---------- | ------------------------- | ----------------------------- | -------------- | --------------------- | ----------------------------------- | -------------- |
| Stable     | `X.Y.Z`                   | `easyeda-mcp-pro-vX.Y.Z`      | non-prerelease | npm dist-tag `latest` | exact version, `X.Y`, and `latest`  | publish        |
| Prerelease | `X.Y.Z-rc.N`, where N ≥ 1 | `easyeda-mcp-pro-vX.Y.Z-rc.N` | prerelease     | npm dist-tag `next`   | exact version and moving tag `next` | do not publish |

Release Please is stable-only. `release-please-config.json` keeps `prerelease: false`; merging its release PR creates the stable tag and GitHub Release. Prereleases use the manual workflow path and must never move npm `latest`, GHCR `latest`, or the stable MCP Registry entry.

Other prerelease identifiers such as `alpha`, `beta`, or an unnumbered `rc` are not supported. Increment `N` whenever candidate code, dependencies, generated artifacts, or release metadata changes.

## Soak requirements

The clock starts when the exact candidate commit has all required checks passing and the evidence record links that commit.

- A non-safety patch release requires a **24-hour** green soak on `main`. A separate release candidate is optional when the change is narrow and reversible.
- A minor stable release requires at least one `rc.N` prerelease and a **72-hour** green soak.
- A major stable release requires at least one `rc.N` prerelease and a **7-day** green soak.
- A release that changes the EasyEDA bridge, transport, authentication, transaction/rollback behavior, installer/setup path, save/export behavior, or any confirmed write path requires an `rc.N`, a minimum **72-hour** soak, and live validation even when the SemVer bump would otherwise be a patch.
- Any code or runtime-dependency change after the final candidate resets the soak clock and requires a new `rc.N`.
- Stable promotion may change only version, changelog, release notes, and promotion metadata after the final candidate. Behavioral changes require another candidate.

## Required release evidence

The release PR, or the public issue/PR supplied to a manual workflow dispatch, must record:

1. the exact source commit and intended tag;
2. channel, SemVer rationale, and soak start/end timestamps;
3. passing CI, CodeQL, Semgrep, dependency audit/review, Sonar quality gate, and Codecov changed-code status;
4. server and extension test totals, coverage summary, build results, and extension size-budget results;
5. Docker startup smoke evidence;
6. SBOM, npm provenance, artifact-attestation, and extension checksum expectations;
7. documentation and compatibility-matrix changes;
8. the named release manager and a rollback owner;
9. known limitations, deferred failures, and the exact recovery version to restore if promotion fails.

A manual workflow dispatch must provide an `evidence_url` pointing to a public issue or pull request in this repository. The workflow rejects tags, channels, package versions, draft releases, or GitHub prerelease classifications that disagree.

## Live EasyEDA validation

**Live EasyEDA Pro validation is mandatory** for bridge-loader changes, dispatcher or native API changes, write/mutation paths, transaction and rollback behavior, save/export behavior, connection lifecycle, installer/setup changes, and support-matrix changes.

Evidence must identify the exact EasyEDA Pro version and operating system, the extension package checksum, the exercised smoke scenarios, read-back/cleanup results, and any restored project state. Use a disposable project unless the validation plan explicitly proves restoration. The versioned compatibility matrix in `docs/reference/easyeda-compatibility.md` must be current before stable promotion.

## Release-blocking automation

Every stable and prerelease publication reruns the supported Node.js/pnpm preflight, dependency audit and peer checks, formatting, server and extension typechecks, lint, tool metadata/coverage validation, server tests and coverage, extension tests and coverage, generated-tool documentation drift checks, documentation build, server/extension builds, extension distribution verification, and extension size budgets.

The workflow then produces the CycloneDX SBOM and build attestations, verifies the GitHub Release channel, publishes npm with provenance to the channel-specific dist-tag, uploads the extension and SBOM, and publishes channel-safe GHCR tags. MCP Registry publication runs only for stable releases.

A failed required step blocks publication. A transient rerun is allowed only when the source tag and evidence are unchanged; otherwise publish a new candidate or patch version.

## Stable release procedure

1. Confirm the applicable soak and live-validation evidence is complete.
2. Review the Release Please PR and verify that only the expected version, changelog, and release metadata changed.
3. Confirm every required PR check and bot/agent review thread is resolved.
4. Merge the Release Please PR. Do not create the stable tag manually in the normal path.
5. Verify npm `latest`, the non-prerelease GitHub Release, exact and moving GHCR tags, the extension/SBOM assets, provenance/attestations, MCP Registry status, and deployed documentation.
6. Publish the final evidence comment before closing the release-tracking issue.

## Prerelease procedure

1. Open a candidate PR that sets every release-managed version to `X.Y.Z-rc.N`, updates release notes, and includes the required evidence link.
2. Merge only after the candidate PR gates pass. Create and push the annotated tag `easyeda-mcp-pro-vX.Y.Z-rc.N` for that exact commit.
3. Create a GitHub Release marked **prerelease**, not draft, for the same tag.
4. Dispatch `.github/workflows/release-please.yml` with the tag, `release_channel=prerelease`, and the public `evidence_url`.
5. Verify npm `next`, GHCR `next`, exact-version artifacts, SBOM, provenance, attestations, and documentation. Confirm npm/GHCR `latest` did not move and the MCP Registry was not published.
6. Start or restart the applicable soak only after all checks and registry verifications pass.

## Emergency patch

An **Emergency patch** may shorten or waive the normal soak only for an active security incident, a broken stable installation, data-loss risk, or a release-system outage that prevents normal recovery. It still requires all executable automated gates and live EasyEDA validation when the affected path requires it.

The public evidence issue must state the incident, customer impact, why waiting is riskier, the exact known-good rollback target, the release manager, and the follow-up owner. Use a normal stable SemVer patch, not an untracked build suffix. Record a follow-up review within two business days and create a new issue for every waived non-automated check.

## Rollback and yanking

Do not delete provenance evidence or silently replace immutable version artifacts.

- Move npm `latest` or `next` back to the last verified version as appropriate.
- Deprecate the affected npm version with an actionable message rather than relying on unpublish as the recovery mechanism.
- Mark the GitHub Release prominently with the incident and known-good replacement; retain the tag, SBOM, checksums, and attestations for auditability.
- Move GHCR `latest` or `next` back to the verified image digest. Exact version tags remain immutable evidence.
- For a stable MCP Registry problem, stop promotion claims, record the registry state in the incident, and follow the registry's supported correction process.
- Publish a forward-fix version as soon as it passes the applicable emergency or normal policy.

A rollback is complete only after npm, GitHub Releases, GHCR, documentation, and any stable MCP Registry claim agree on the recommended version.

## Deprecation and breaking changes

Public MCP tool names, schemas, bridge protocol fields, environment variables, configuration keys, CLI behavior, and documented installation paths require a deprecation notice before removal.

- Use a major SemVer release for breaking stable behavior, even before v1.0 when practical; never hide a breaking change inside an ordinary patch.
- Announce deprecation in the changelog, release notes, migration documentation, and runtime warning where feasible.
- Keep the deprecated path for at least one minor release and **30 days** before removal.
- Security or correctness risks may shorten the notice period, but the release evidence must explain the risk, migration, and accelerated timeline.
- Major releases require the 7-day candidate soak, migration guide, rollback plan, and live validation for every affected EasyEDA path.

## Documentation consistency

`docs/RELEASE_PROCESS.md` describes the mechanics, `docs/RELEASE_VERIFICATION.md` describes artifact verification, and `docs/release-ci-runbook.md` describes operational recovery. `CONTRIBUTING.md` links contributors to this policy. When workflow behavior changes, update all four documents and the repository-policy tests in the same pull request.
