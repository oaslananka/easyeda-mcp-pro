# Release publication hardening design

## Goal

Make the release system fail closed before an immutable tag or GitHub Release is created, prevent newer runs from cancelling an active publication, preserve idempotent recovery, and align the workflow with current Release Please and npm publishing capabilities.

## Current problem

The existing `release-please.yml` combines four responsibilities: maintaining the release PR, creating the tag and GitHub Release, validating the release candidate, and publishing to registries. Release Please creates the tag and GitHub Release before the repository-specific EasyEDA compatibility gate runs. A failed gate therefore leaves a partial release that must be recovered. Workflow-level `cancel-in-progress: true` can also cancel an active publication when a newer `main` event or recovery dispatch arrives.

## Chosen architecture

Split the lifecycle into two workflows.

1. `release-please.yml` is a low-privilege release-PR manager. It runs on `main`, invokes Release Please with `skip-github-release: true`, and may cancel superseded PR-maintenance runs.
2. `publish-release.yml` owns immutable release creation and all publication. It detects a merged Release Please commit or an explicit manual recovery/prerelease request, runs compatibility and quality gates first, then invokes Release Please with `skip-github-pull-request: true` to create the tag and GitHub Release. Registry publication follows only after release identity is validated.

A single policy script resolves automatic and manual events into a normalized publication plan. Automatic runs require the Release Please squash-merge subject, synchronized package and manifest versions, and a stable tag. Manual runs require an existing stable or numbered RC tag plus a public repository issue/PR evidence URL. Re-running an automatic release after its tag already exists becomes an idempotent recovery run rather than attempting to recreate the release.

## Publication ordering

The automatic stable path is:

1. detect the release commit and expected tag;
2. verify commit-bound EasyEDA evidence against the candidate commit;
3. check metadata, dependency audit, formatting, types, lint, tests, coverage, docs, extension package, and size budget;
4. build the SBOM and provenance subjects;
5. create the immutable tag and GitHub Release through Release Please release-only mode;
6. validate tag, version, release classification, and target commit;
7. publish or restore npm state;
8. upload release assets;
9. publish the stable MCP Registry entry;
10. build and publish channel-safe GHCR tags.

Manual recovery runs use the current workflow policy from `main`, validate the requested immutable tag, check out that tag for reproducible build and publication, and never rewrite the tag.

## Concurrency and recovery

Publication concurrency is keyed by normalized release tag at the publish job. `cancel-in-progress` is false, so an active publication is never terminated by a later event. Different versions do not share a concurrency key. All registry steps remain idempotent where the external platform permits it: npm restores the requested dist-tag when the version already exists, GitHub assets use `--clobber`, and GHCR tags are rebuilt from the immutable release source.

## npm authentication

The publish job grants `id-token: write` and uses a GitHub-hosted runner. `npm publish` can therefore use npm Trusted Publishing when the package-side trust relationship is configured. `NODE_AUTH_TOKEN` remains available as a compatibility fallback and for `npm dist-tag add`, which OIDC does not authorize. A new publish does not fail merely because the recovery token is absent; an already-published version that needs dist-tag repair fails closed without that credential.

## Security boundaries

- The PR-manager workflow cannot publish packages, containers, attestations, or releases.
- The publication workflow receives write permissions only in the publish job.
- Third-party Actions are pinned to full commit SHAs.
- Stable and prerelease tag formats map only to `latest` and `next` respectively.
- Manual dispatch is accepted only from `main` and requires a public evidence URL in this repository.
- Compatibility checks run against the candidate/tag before release creation or registry mutation.

## Testing

Repository policy tests will parse the workflows and enforce the split, ordering, permissions, SHA pins, non-cancelling publication concurrency, and absence of publication steps from the PR manager. Unit tests will cover ordinary pushes, first automatic publication, automatic recovery with an existing tag, manual stable recovery, manual RC publication, version drift, invalid commit subjects, invalid evidence, channel mismatches, and non-`main` dispatches. The complete repository verification suite and GitHub PR checks must pass before merge.
