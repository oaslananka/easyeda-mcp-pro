# Release Policy

This policy defines the public release channels, verification evidence, promotion rules, and recovery responsibilities for `easyeda-mcp-pro`. It is authoritative for npm, GitHub Releases, the EasyEDA extension asset, GHCR, the MCP Registry, and the published documentation.

## Ownership

The release manager is `@oaslananka`. The release manager owns channel selection, evidence review, publication, rollback, npm dist-tags, GitHub Release classification, GHCR moving tags, and post-release verification. Security-sensitive releases also follow the incident ownership in `SECURITY.md` and `docs/REPOSITORY_GOVERNANCE.md`.

No release is approved only because a version tag exists. The evidence and channel rules below are release blockers.

## Release channels and identifiers

| Channel    | Version                   | Git tag                       | GitHub Release | npm                   | GHCR                                | MCP Registry   |
| ---------- | ------------------------- | ----------------------------- | -------------- | --------------------- | ----------------------------------- | -------------- |
| Stable     | `X.Y.Z`                   | `easyeda-mcp-pro-vX.Y.Z`      | non-prerelease | npm dist-tag `latest` | exact version, `X.Y`, and `latest`  | publish        |
| Prerelease | `X.Y.Z-rc.N`, where N ≥ 1 | `easyeda-mcp-pro-vX.Y.Z-rc.N` | prerelease     | npm dist-tag `next`   | exact version and moving tag `next` | do not publish |

The release-PR lifecycle advances from `autorelease: pending` to `autorelease: tagged` only after the separate publication succeeds and the exact release identity is verified. Unreconciled merged release PRs must fail visibly rather than stop future releases silently. Existing release assets must be byte-identical before reuse; overwriting immutable version assets is forbidden.

Release Please is stable-only. `release-please-config.json` keeps `prerelease: false`; merging its release PR creates the reviewed stable release commit, while the separate **Publish Release** workflow creates the immutable tag and GitHub Release only after publication gates pass. Prereleases use the manual workflow path and must never move npm `latest`, GHCR `latest`, or the stable MCP Registry entry.

Other prerelease identifiers such as `alpha`, `beta`, or an unnumbered `rc` are not supported. Increment `N` whenever candidate code, dependencies, generated artifacts, or release metadata changes.

## Candidate and promotion requirements

Stable promotion has **no time-based waiting period**. Once the exact source commit has the required review, CI/security results, release evidence, and applicable live EasyEDA validation, publication may proceed immediately.

- A numbered `rc.N` is optional for all SemVer levels. Use it for staged adoption or additional external testing when justified by release risk; a stable candidate can be validated directly against its exact audited source and generated package without publishing a prerelease.
- A narrow, reversible patch without compatibility-sensitive changes may publish directly after the standard required gates; release risk, not SemVer classification, determines whether a prerelease is useful.
- A release that changes the EasyEDA bridge, transport, authentication, transaction/rollback behavior, installer/setup path, save/export behavior, or any confirmed write path requires live EasyEDA validation bound to the exact candidate, even if no `rc.N` is published.
- Any code or runtime-dependency change after candidate validation invalidates affected evidence. Revalidate the new exact candidate; if an optional `rc.N` was published, a new versioned prerelease is needed before further prerelease publication.
- Numbered `release/` candidate pull requests must pass the commit-bound live EasyEDA compatibility gate before merge; stale or unavailable evidence is merge-blocking.
- After the final verified candidate, changes may only affect version, changelog, release notes, and promotion metadata. Behavioral changes require new evidence tied to the changed source, whether or not a prerelease exists.
- While repository metadata is prerelease, ordinary `main` pushes must not generate a stable Release Please PR. Stable PR generation resumes only from an explicit matching `Release-As: X.Y.Z` promotion commit.

## Required release evidence

The release PR, or the public issue/PR supplied to a manual workflow dispatch, must record:

1. the exact source commit and intended tag;
2. channel, SemVer rationale, candidate identity, and promotion decision;
3. passing required CI, CodeQL, Semgrep, dependency audit/review, and Codecov changed-code status, plus disposition of any SonarQube Cloud advisory findings reported for the head;
4. server and extension test totals, coverage summary, build results, and extension size-budget results;
5. Docker startup smoke evidence;
6. SBOM, npm provenance, artifact-attestation, portable Sigstore bundle and in-toto provenance asset, and extension checksum expectations;
7. documentation and compatibility-matrix changes;
8. the named release manager and a rollback owner;
9. known limitations, deferred failures, and the exact recovery version to restore if promotion fails.

A manual workflow dispatch must provide an `evidence_url` pointing to a public issue or pull request in this repository. The workflow rejects tags, channels, package versions, draft releases, or GitHub prerelease classifications that disagree.

## Live EasyEDA validation

**Live EasyEDA Pro validation is mandatory** for bridge-loader changes, dispatcher or native API changes, write/mutation paths, transaction and rollback behavior, save/export behavior, connection lifecycle, installer/setup changes, and support-matrix changes.

Evidence must identify the exact EasyEDA Pro version and operating system, the live-validated extension package SHA-256 and byte size, the exercised smoke scenarios, read-back/cleanup results, and any restored project state. Use a disposable project unless the validation plan explicitly proves restoration. For both stable and prerelease publications with live-required changes, the extension must be reproducibly built and its SHA-256 and byte size matched to current exact-source live evidence before registry or release-asset mutation. The versioned compatibility matrix in `docs/reference/easyeda-compatibility.md` must be current before stable promotion.

## Release-blocking automation

Stable promotion has no clock-based gate. The required PR checks and **Publish Release** workflow instead fail closed on source identity, channel/version consistency, commit-bound EasyEDA compatibility evidence, quality/security gates, and publication integrity. A passing candidate can therefore move directly to publication without weakening any non-time-based control.

Every stable and prerelease publication reruns the supported Node.js/pnpm preflight, dependency audit and peer checks, formatting, server and extension typechecks, lint, tool metadata/coverage validation, server tests and coverage, extension tests and coverage, generated-tool documentation drift checks, documentation build, server/extension builds, extension distribution verification, and extension size budgets. Publication jobs are serialized per release channel with `cancel-in-progress: false`, so concurrent stable publications cannot race on `latest` state and concurrent prereleases cannot race on `next`, while an active publication is never cancelled.

The workflow then verifies the rebuilt EasyEDA extension identity, produces the CycloneDX SBOM, GitHub build attestations, and a tag-bound portable Sigstore bundle and in-toto provenance asset, verifies the GitHub Release channel, publishes npm with provenance to the channel-specific dist-tag, uploads the extension, SBOM, `<tag>.provenance.sigstore.json`, and `<tag>.intoto.jsonl`, and publishes channel-safe GHCR tags. The final published-release verifier requires the GitHub `.eext` asset SHA-256 and byte size to equal the identity approved before publication. MCP Registry publication runs only for stable releases.

A failed required step blocks publication. A transient rerun is allowed only when the source tag and evidence are unchanged **and the original workflow run already contained every currently mandatory release gate**; otherwise publish a new candidate or patch version. If all publication mutations already succeeded and only final published-release verification failed, do **not** rerun the mutation workflow: use the read-only **Verify Published Release** workflow from current `main` against the immutable tag. That workflow rebuilds the release package only inside its disposable runner so it can re-derive the approved extension SHA-256/size; it performs no registry or release mutation. Prerelease verification does not query the MCP Registry because prereleases are forbidden from publishing there; stable verification still requires the registry record. If a mandatory gate was added after an earlier failed run, maintainers **must not re-run a pre-gate workflow attempt**. Use the current workflow definition from `main` against the exact audited source and public evidence through the documented recovery paths. Recovery never waives a current executable gate.

## Stable release procedure

1. Confirm the required release evidence and applicable live-validation evidence is complete.
2. Review the Release Please PR and verify that only the expected version, changelog, and release metadata changed.
3. Confirm every required PR check and bot/agent review thread is resolved.
4. Merge the Release Please PR. Do not create the stable tag manually in the normal path.
5. Verify npm `latest`, the non-prerelease GitHub Release, exact and moving GHCR tags, the extension/SBOM assets, provenance/attestations, MCP Registry status, and deployed documentation.
6. Publish the final evidence comment before closing the release-tracking issue.

## Prerelease procedure

1. Open a candidate PR that sets every release-managed version to `X.Y.Z-rc.N`, updates release notes, and includes the required evidence link.
2. Merge only after the candidate PR gates pass. Create and push the annotated tag `easyeda-mcp-pro-vX.Y.Z-rc.N` for that exact commit.
3. Create a GitHub Release marked **prerelease**, not draft, for the same tag.
4. Dispatch `.github/workflows/publish-release.yml` with the tag, `release_channel=prerelease`, and the public `evidence_url`.
5. Verify npm `next`, GHCR `next`, exact-version artifacts, SBOM, provenance, attestations, and documentation. Confirm npm/GHCR `latest` did not move and the MCP Registry was not published.
6. Record the final prerelease verification evidence after all checks and registry verifications pass.

## Emergency patch

An **Emergency patch** path is reserved for an active security incident, a broken stable installation, data-loss risk, or a release-system outage that prevents normal recovery. It does not skip executable automated gates or required live EasyEDA validation.

The public evidence issue must state the incident, customer impact, urgency, the exact known-good rollback target, the release manager, and the follow-up owner. Use a normal stable SemVer patch, not an untracked build suffix. Record a follow-up review within two business days and create a new issue for every deferred non-automated follow-up.

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
- Major releases require a reviewed exact-source candidate, migration guide, rollback plan, and live validation for every affected EasyEDA path; publishing a numbered prerelease is optional.

## Documentation consistency

`docs/RELEASE_PROCESS.md` describes the mechanics, `docs/RELEASE_VERIFICATION.md` describes artifact verification, and `docs/release-ci-runbook.md` describes operational recovery. `CONTRIBUTING.md` links contributors to this policy. When workflow behavior changes, update all four documents and the repository-policy tests in the same pull request.
