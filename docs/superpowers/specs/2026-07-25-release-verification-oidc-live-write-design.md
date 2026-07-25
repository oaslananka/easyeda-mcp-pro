# Release verification, OIDC publishing, and live write evidence design

## Goal

Ship a patch release that proves the new release architecture end to end: npm publishing uses Trusted Publishing/OIDC for new versions, every published registry target is checked for cross-registry consistency, live EasyEDA schematic write rollback behavior produces machine-readable evidence, and OpenSSF signed-release documentation reflects the actual provenance and attestation model.

## Scope

This change covers four related release-readiness improvements:

1. OIDC-first npm publishing for new package versions.
2. Automated post-publication verification across npm, GitHub Releases, GHCR, and the MCP Registry.
3. Structured live EasyEDA write/rollback evidence generated from a disposable schematic.
4. Documentation alignment for OpenSSF signed-release evidence.

The work concludes with a real stable patch release, expected to be `0.35.4`, created through the normal Release Please flow. The release number is determined by Release Please from a conventional `fix:` change; no version file is edited manually outside the Release Please PR.

## Architecture

### npm authentication boundary

The normal first publication path must not receive `NPM_TOKEN`. It runs `npm publish --provenance --tag <dist-tag>` with GitHub Actions `id-token: write`, allowing npm Trusted Publishing to authenticate the workflow identity `oaslananka/easyeda-mcp-pro` and `.github/workflows/publish-release.yml`.

The existing-version recovery path remains separate. When the exact package version already exists, the workflow may use the protected `NPM_TOKEN` secret only for `npm dist-tag add`, because Trusted Publishing does not authorize dist-tag repair. The workflow fails closed when a repair is required and the recovery credential is absent.

The workflow must make the selected mode visible in the job summary without printing credentials:

- `oidc-publish` for a new package version;
- `token-dist-tag-repair` for an existing version;
- failure when neither mode can complete the requested operation.

### Published release verifier

A new Node.js script, `scripts/verify-published-release.mjs`, receives the release tag, release channel, expected commit, repository, and optional summary-file path. It queries public APIs and local Git metadata and returns a non-zero exit code for any mismatch.

The verifier checks:

- package version parsed from `easyeda-mcp-pro-vX.Y.Z` or `easyeda-mcp-pro-vX.Y.Z-rc.N`;
- npm exact version exists;
- npm `latest` points to the stable version or npm `next` points to the prerelease version;
- npm package repository metadata points to this GitHub repository;
- npm provenance metadata is present when the npm registry exposes it through the public endpoint used by the verifier;
- GitHub Release exists, is non-draft, has the expected prerelease classification, and resolves to the expected commit;
- required GitHub Release assets `easyeda-bridge-extension.eext` and `sbom.json` exist and expose digests;
- GHCR contains the exact version tag;
- stable releases also contain `<major>.<minor>` and `latest`, while prereleases contain `next` and must not move stable tags;
- stable releases have an exact MCP Registry entry whose package version matches; prereleases are absent from the MCP Registry.

External registries can be eventually consistent. The script therefore retries read-only checks with bounded exponential backoff. Defaults are six attempts over approximately three minutes. A permanent schema, identity, digest, channel, or commit mismatch fails immediately; only not-yet-visible records are retried.

The script writes a JSON report under `reports/release-verification.json` and a Markdown summary when `GITHUB_STEP_SUMMARY` is supplied. No registry mutation occurs in the verifier.

### Workflow ordering

The existing publication sequence remains fail closed before immutable release creation. After npm, GitHub assets, MCP Registry, and GHCR publication complete, a final mandatory step runs the new verifier. Publication success is not reported unless the cross-registry report passes.

The verifier executes after the Docker push so it can observe every target. For stable releases it verifies all four public destinations. For prereleases it verifies npm, GitHub Release, and GHCR and confirms MCP Registry omission.

The JSON verification report is uploaded as a workflow artifact even on failure. The workflow uses `if: always()` only for report upload, not for bypassing verification failure.

### Live write/rollback evidence

The existing `scripts/live-schematic-transaction-smoke.mts` already performs self-cleaning create, modify, and delete rollback checks. It will be converted from console-only evidence into a structured report producer while preserving the safety behavior.

Required inputs:

- `EASYEDA_LIVE_TRANSACTION_TESTS=true`;
- `EASYEDA_TEST_PROJECT_ID=TestMcp`;
- explicit confirmation `EASYEDA_TEST_PROJECT_DISPOSABLE=true`;
- optional expected dispatcher build and report path.

The script must refuse all mutations unless the disposable confirmation is true. It captures:

- server commit and package version;
- OS, architecture, Node version, EasyEDA Pro version, bridge version, bridge contract, dispatcher build, and method registry hash;
- focused project, schematic, and page metadata;
- preflight cleanup results;
- baseline primitive/component/net/ERC digests;
- create rollback, modify rollback, delete rollback, and successful setup/cleanup results;
- final digest comparison and leftover primitive count;
- overall status, timestamps, and error/cleanup details.

The report is written atomically to a configurable path. A passing result requires baseline and final primitive inventories, component hashes, net hashes, and comparable ERC state to match, with no known smoke artifact left behind.

The live run is performed only on `TestMcp / Schematic1 / P1` in EasyEDA Pro on the connected Ubuntu workstation. The generated evidence is copied into `docs/evidence/easyeda-live/` and referenced from `config/easyeda-compatibility.json`. This run does not claim Windows or macOS live desktop validation.

### OpenSSF evidence alignment

`docs/OPENSSF_BEST_PRACTICES.md` will describe `signed_releases` as met through npm provenance and GitHub Artifact Attestations, matching `docs/RELEASE_VERIFICATION.md`. `version_tags_signed` remains explicitly not met through GPG-signed tags; the project uses immutable Release Please tags plus artifact/package attestations instead.

The documentation must not claim that provenance signs Git tags. It must distinguish package/artifact provenance from tag signatures.

## Error handling

- OIDC publication failures stop before downstream registry publication continues.
- Existing-version dist-tag repair without `NPM_TOKEN` fails with a specific recovery message.
- Missing or malformed public API responses are treated as retryable only when the record may still be propagating.
- Version, channel, repository, commit, asset digest, or tag mismatches are permanent failures.
- Live transaction smoke aborts before mutation when the project is not explicitly marked disposable or no stable focused schematic exists.
- On any live smoke failure, every known temporary primitive is deleted best-effort; cleanup errors are recorded and still cause failure.
- Evidence is never rebound to a newer commit unless that exact commit was installed and tested live.

## Testing

Unit tests will cover:

- stable and prerelease tag parsing;
- npm dist-tag validation;
- GitHub Release commit/classification/asset validation;
- GHCR exact and moving tag validation;
- MCP Registry stable presence and prerelease absence;
- retryable propagation versus permanent mismatch behavior;
- redacted job-summary output;
- OIDC-first workflow policy and token-only recovery policy;
- live transaction smoke configuration refusal without disposable confirmation;
- successful structured report generation and failed cleanup reporting using mocked bridge operations;
- OpenSSF signed-release wording consistency.

Repository policy tests will require the final verification step to run after GHCR publication and require report upload without allowing `continue-on-error`.

The full validation set is:

- targeted Vitest suites;
- Prettier, TypeScript, ESLint, actionlint, and zizmor;
- `pnpm verify`;
- repository pre-commit hooks;
- live EasyEDA transaction smoke on the disposable project;
- PR required checks;
- merge to `main`;
- Release Please release PR checks;
- stable `0.35.4` publication;
- final public verification report against npm, GitHub Release, GHCR, and MCP Registry.

## Rollout and rollback

The code and workflow changes are merged before the release PR. The `fix:` commit creates a patch release proposal. The Release Please PR is reviewed and merged only after its required checks pass and the fresh live evidence is bound to its exact candidate commit.

If OIDC publication fails before npm mutation, correct the Trusted Publisher configuration and rerun the same immutable release through the documented recovery dispatch. If npm publishes but a later target fails, keep the immutable tag and package, repair the missing target idempotently, and rerun post-publication verification. Never move the tag or overwrite an npm version.

## Out of scope

- Windows or macOS live EasyEDA validation in this patch.
- Public Remote Relay dogfooding.
- GPG signing of Git tags.
- Removing the recovery-only npm token before one successful OIDC release proves the normal path.
