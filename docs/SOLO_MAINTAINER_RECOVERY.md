# Solo-maintainer continuity and release recovery

This runbook is the operational recovery source for `easyeda-mcp-pro`. It assumes the repository is intentionally operated by one maintainer and therefore replaces unavailable human approval with protected pull requests, required automated checks, immutable evidence, and tested recovery procedures.

## Security boundary

Never store plaintext credentials, npm tokens, GitHub recovery codes, signing keys, private keys, or successor contact details in this repository. Keep the confidential access inventory and recovery material in an offline encrypted record controlled by the maintainer. Repository documentation may name secret identifiers and recovery procedures, but never secret values.

## Required recovery inventory

The encrypted record must identify the recovery path, current owner, last verification date, and revocation procedure for:

- GitHub account recovery and repository administrator access;
- npm account recovery and the `easyeda-mcp-pro` package;
- GitHub Actions environments and secret names used by release publication;
- GitHub Container Registry package administration;
- MCP Registry publication identity and GitHub OIDC relationship;
- OpenSSF BadgeApp ownership;
- documentation or DNS ownership if hosting moves away from GitHub Pages.

Review this inventory every 180 days and after any ownership, token, workflow, or recovery-method change.

## Baseline health check

Before recovery, record the exact intended release tag and known-good rollback version. Do not mutate a published tag.

```bash
TAG=easyeda-mcp-pro-vX.Y.Z
VERSION=${TAG#easyeda-mcp-pro-v}

# Source and release identity
git ls-remote --tags origin "$TAG"
gh release view "$TAG" --json tagName,targetCommitish,isDraft,isPrerelease,assets

# Package and registry state
npm view "easyeda-mcp-pro@$VERSION" version dist.integrity dist.shasum --json
npm view easyeda-mcp-pro dist-tags --json
gh api "/orgs/oaslananka/packages/container/easyeda-mcp-pro/versions?per_page=20"
```

Capture outputs in the public evidence issue unless they contain sensitive account data.

## Immutable release tags

Immutable release tags are the recovery anchor. Never move or recreate a published release tag to include a workflow or documentation fix. Merge recovery policy changes to `main`, validate those current policies against the immutable tag commit, and then build and publish the tag.

A manual release recovery must run the workflow definition from `main`:

```bash
TAG=easyeda-mcp-pro-vX.Y.Z
EVIDENCE=https://github.com/oaslananka/easyeda-mcp-pro/issues/NUMBER

gh workflow run publish-release.yml --ref main \
  -f tag_name="$TAG" \
  -f release_channel=stable \
  -f evidence_url="$EVIDENCE"
```

The Publish Release workflow validates commit-bound EasyEDA evidence before checking out the tag. It then restores an existing npm dist-tag when the package version already exists, replaces release assets with `--clobber`, republishes the MCP Registry entry idempotently, and rebuilds moving GHCR tags from the immutable source.

## Partial publication decision tree

1. Identify the last successful publication step from the Actions job.
2. Check npm, GitHub Release assets, GHCR, and MCP Registry independently; never infer one registry from another.
3. Preserve the release tag, SBOM, checksums, provenance, and failed workflow logs.
4. Fix the policy or automation on a protected pull request to `main`.
5. Re-run the manual recovery from `main` with the existing tag and public evidence URL.
6. Verify all registries and moving tags before announcing recovery complete.

If the tagged source itself is defective, do not republish it as fixed. Deprecate the affected package version, mark the GitHub Release with an explicit warning, move only the documented moving tags back to the known-good version, and publish a new patch version.

## npm recovery

Check whether the version exists and where `latest` or `next` points:

```bash
npm view "easyeda-mcp-pro@$VERSION" version dist.integrity --json
npm view easyeda-mcp-pro dist-tags --json
```

For an already published healthy version, restore the intended moving tag:

```bash
npm dist-tag add "easyeda-mcp-pro@$VERSION" latest
```

For a defective version, prefer deprecation over unpublish:

```bash
npm deprecate "easyeda-mcp-pro@$VERSION" \
  "Defective release; use easyeda-mcp-pro@KNOWN_GOOD or a newer patch."
```

Normal new-version publication uses npm Trusted Publishing when the package-side trust relationship is configured. NPM_TOKEN is retained only for dist-tag repair and as a protected compatibility fallback. Rotate `NPM_TOKEN` through the account and GitHub Actions environment after suspected exposure. Verify the replacement token with a protected workflow; never paste it into an issue, log, shell history, or repository file.

## GitHub Release recovery

The GitHub Release must remain bound to the original tag. Verify and replace only generated assets:

```bash
gh release view "$TAG" --json tagName,targetCommitish,isDraft,isPrerelease,assets
gh release upload "$TAG" easyeda-bridge-extension.eext sbom.json --clobber
```

Expected assets are `easyeda-bridge-extension.eext` and `sbom.json`, each with a published digest. Do not delete provenance or failed-run evidence merely to make the release page look clean.

## GitHub Container Registry recovery

Stable releases require the exact version tag, minor tag, and `latest`. Prereleases require the exact version and `next` only. Re-run the protected release workflow to rebuild the image from the immutable tag rather than retagging an unverified local image.

Verify package versions and tags through the GitHub Packages API. If a defective stable image was promoted, move `latest` and the minor tag back to a verified image digest, retain the exact defective version tag for auditability, and document the warning in the release evidence.

## MCP Registry recovery

The MCP Registry stable entry must match the npm package version and repository identity. Recovery publication uses the GitHub OIDC identity in the protected release workflow.

Verify the exact entry:

```bash
curl --fail --silent --show-error \
  "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.oaslananka/easyeda-mcp-pro&version=$VERSION"
```

If publication fails after npm succeeds, do not republish npm. Fix the registry or workflow policy on `main`, rerun the existing-tag recovery, and confirm the exact version is active and latest where applicable.

## Branch protection recovery

The solo-maintainer baseline requires zero unavailable human approvals but does not permit an unprotected branch. Verify `main` through the GitHub API:

```bash
gh api repos/oaslananka/easyeda-mcp-pro/branches/main/protection
```

The result must match `config/repository-governance.json`: strict required checks, conversation resolution, administrator enforcement, linear history, no force-pushes, no deletion, zero required approvals, and no code-owner requirement while only one eligible maintainer exists.

If protection drifts, restore it before merging ordinary work. For an active emergency, record the exact temporary change and rollback command, restore normal protection immediately afterward, and create a follow-up issue within two business days.

## Credential rotation

Rotate credentials after suspected exposure, ownership change, unexplained publication, or loss of a trusted device. The order is:

1. revoke the exposed credential at its issuer;
2. create the least-privilege replacement;
3. update the relevant GitHub Actions environment or secret;
4. run a non-destructive protected verification;
5. inspect logs for accidental disclosure;
6. update the encrypted recovery record and verification date.

Do not rotate every credential simultaneously unless compromise scope requires it; preserve at least one verified administrative recovery path throughout the operation.

## Ownership transfer

A future successor must be a consenting human. Before transfer:

1. verify GitHub maintain or administrator access and private security-advisory access;
2. transfer or establish npm package recovery without sharing plaintext credentials;
3. review release, rollback, secret-rotation, vulnerability-disclosure, and branch-protection procedures;
4. complete a non-production or simulated emergency-release exercise;
5. record consent, verification date, revocation procedure, and asset ownership in the encrypted continuity record;
6. update public governance and enable independent review within two business days when a second eligible maintainer exists.

A nominal account, bot, pending invitation, or undocumented credential handoff does not increase the public bus-factor claim.

## Recovery exercise

Run a non-destructive exercise at least every 180 days. The exercise must verify branch protection, immutable tag handling, npm state, GitHub Release assets, GHCR tags, MCP Registry state, rollback instructions, and access-inventory freshness. Record only non-sensitive evidence under `docs/evidence/governance/` and link it from issue #407 or its successor governance issue.

The first recorded exercise is the successful v0.35.3 recovery on 25 July 2026.
