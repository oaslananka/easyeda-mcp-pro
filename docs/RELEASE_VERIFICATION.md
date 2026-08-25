# Release Verification

This document explains how `easyeda-mcp-pro` releases are produced and how users can verify release integrity.

Channel selection, soak periods, live-validation requirements, and rollback ownership are defined by the authoritative [Release Policy](RELEASE_POLICY.md).

## Release channels

Stable releases use `easyeda-mcp-pro-vX.Y.Z`, a non-prerelease GitHub Release, npm `latest`, stable GHCR moving tags, and the MCP Registry. Numbered candidates use `easyeda-mcp-pro-vX.Y.Z-rc.N`, a GitHub prerelease, npm `next`, and GHCR `next`; they do not publish to the MCP Registry or move stable tags.

Both channels publish the npm package, GitHub Release assets, SBOM, provenance/attestation evidence, and bundled EasyEDA bridge extension.

## Automated release process

1. Conventional commits are merged into `main`.
2. Release Please opens or updates a release pull request.
3. The release pull request updates version metadata and `CHANGELOG.md`.
4. After merge, CI re-runs the quality gates.
5. For first publication, new npm versions use Trusted Publishing without `NPM_TOKEN`; the workflow then uploads release artifacts and publishes the remaining registries.
6. The final **Verify published release** step compares npm, GitHub Release, GHCR, MCP Registry, assets, and Git commit identity and stores `published-release.json`.

GitHub Actions keeps bounded operational copies after publication: SBOM workflow artifact: `14 days`; published-release verification artifact: `30 days`. Long-lived verification must use the immutable GitHub Release assets, provenance/attestation evidence, checksums, and public release record rather than depending on expiring workflow artifacts.

## Verification checks for maintainers

Stable promotion also has an executable soak check in `scripts/release-soak-policy.mjs`. Major/minor release PRs cannot satisfy the required quality check until the exact final RC has the policy soak; the publication workflow repeats the check before any immutable release or registry mutation. The gate uses a successful manual RC publication run for the exact candidate SHA only when its **Gate and publish immutable release** job also succeeded, using that run as a conservative clock source and rejects post-candidate runtime changes or dependency drift. For a patch without an RC, the 24-hour clock starts from the stable release commit after it is merged to `main`. This RC-free path is rejected when the patch changes compatibility-sensitive, authentication, transport, transaction/rollback, save/export, installer/setup, or other configured release-candidate-required paths; those patches require an RC and at least 72 hours.

An early automatic publication failure caused by this gate is expected and safe: do not create a replacement tag or change the source commit. Re-run the original Publish Release workflow only if that historical run already contained the current mandatory soak gate. If the failed attempt predates a mandatory gate, use the current workflow from `main` and the exact audited source through missing stable release identity recovery after the reported eligibility timestamp. `emergency_soak_override=true` is reserved for the documented manual emergency stable-patch procedure and does not bypass compatibility, quality, live validation, provenance, or final published-release verification.

For each release, maintainers should start with the commit-bound compatibility check:

```bash
pnpm install --frozen-lockfile
pnpm release:readiness:compatibility
```

This check compares the candidate commit with every recorded live EasyEDA evidence commit across the
compatibility-sensitive source paths. It fails when later bridge, transport, remote, tool, or
transaction changes make the available live evidence stale. A historical compatibility row can
remain valid for its original commit while being insufficient for a new release.

The check reports `unavailable` when Git metadata or the Git executable is missing, the requested
candidate ref cannot be resolved, or the compatibility evidence is missing or malformed. That state
is always release-blocking; source archives may run the test suite, but they are not valid publication
environments. Run publication checks from a complete Git checkout. Automation can request one
machine-readable report with `pnpm release:readiness:compatibility -- --json`; stdout remains a single
JSON document and the command exits nonzero unless the status is `current`.

After a fresh live record is bound to the exact candidate commit, run the complete local gate:

```bash
pnpm release:readiness
```

The command executes dependency audit, the full `pnpm verify` suite, coverage, extension distribution
verification, and `npm pack --dry-run`. The release workflow independently repeats its publication
quality gates. Neither a passing unit-test matrix nor fake-runtime evidence can waive stale live
EasyEDA evidence.

The release PR and release workflow must pass the required GitHub status checks before release artifacts are considered valid.

### Docker smoke check

The CI `quality` job is the source of truth for Docker release readiness. It verifies three distinct
behaviors: the default loopback listener works inside the container, an unauthenticated non-loopback
bind fails closed, and a correctly configured OAuth/JWKS deployment is reachable through the
published host port and returns a Bearer challenge.

Maintainers with Docker installed can repeat the same smoke locally:

```bash
docker build -t easyeda-mcp-pro:release-smoke .
node scripts/e2e/docker-network-smoke.mjs --image easyeda-mcp-pro:release-smoke
```

If the maintainer workstation or VPS does not have Docker installed, record that the local Docker smoke was skipped and link to the passing CI `quality` job. Do not treat a Docker-less local host as a release blocker when the CI Docker smoke has passed.

## Recording fresh live EasyEDA evidence

When `pnpm release:readiness:compatibility` reports `stale`, run the documented smoke workflow on a
disposable EasyEDA project and record the exact server commit, package version, extension package,
loader version, EasyEDA Pro build, operating system, bridge contract, method registry hash, and
capability results in `config/easyeda-compatibility.json`. Generate and check the public matrix:

```bash
pnpm generate:compatibility
pnpm check:compatibility
pnpm release:readiness:compatibility
```

The evidence commit must be the full 40-character Git commit of the tested candidate. Do not update
that field to a newer commit unless the live run actually used that commit. If no disposable live
runtime is available, the correct status is blocked; do not replace the evidence with CI output.

## Live create/modify/delete rollback evidence

Compatibility-sensitive releases can include a self-cleaning create/modify/delete rollback smoke against the disposable `TestMcp / Schematic1 / P1` fixture. The machine-readable report records the bridge identity, the three rollback outcomes, cleanup state, and equality of primitive inventory, components, nets, and comparable ERC state. Temporary primitive identifiers and local paths are removed from public evidence.

## User verification steps

Users can verify a release by checking:

1. the npm package version matches the GitHub Release version,
2. the GitHub Release notes match `CHANGELOG.md`,
3. the package was built by the expected GitHub Actions release workflow,
4. npm provenance is present for the published package when available,
5. the bridge extension artifact checksum, if published in the release notes or workflow logs, matches the downloaded artifact.

## Signed and attested release status

The project uses signed and attested release mechanisms for the release artifacts intended for broad use:

- npm packages are published with `npm publish --provenance`, tying the package to the GitHub Actions workflow and source commit.
- GitHub release build outputs are covered by GitHub Artifact Attestations through `actions/attest-build-provenance` for `dist/**`, `easyeda-bridge-extension.eext`, and `sbom.json`.
- The same attestation is attached to the GitHub Release as a portable Sigstore bundle named `<tag>.provenance.sigstore.json`, so verification does not depend only on the GitHub Attestations API.
- The identical signed bundle is also serialized as one JSON line in `<tag>.intoto.jsonl`, which provides the conventional in-toto provenance asset expected by release tooling.
- Release creation and publishing run from the protected `main` branch after release quality gates pass.

This is the project's signed-release posture for the OpenSSF `signed_releases` criterion: npm provenance, GitHub Artifact Attestations, the portable `.provenance.sigstore.json` bundle, and the matching `.intoto.jsonl` provenance asset satisfy the project signed-release posture. It uses those verifiable attestations rather than manually managed GPG tag signatures.

## Verification examples

For npm provenance, inspect the package page or package metadata for provenance on the released version:

```bash
npm view easyeda-mcp-pro@latest version dist.integrity
npm view easyeda-mcp-pro dist-tags --json
```

For GitHub artifact attestations, download the released artifact and verify it against this repository:

```bash
gh attestation verify easyeda-bridge-extension.eext --repo oaslananka/easyeda-mcp-pro
```

The portable bundle is listed with the release assets and can be inspected without changing the signed statement:

```bash
gh release download easyeda-mcp-pro-vX.Y.Z --pattern '*.provenance.sigstore.json'
jq -e '.mediaType | startswith("application/vnd.dev.sigstore.bundle.")' \
  easyeda-mcp-pro-vX.Y.Z.provenance.sigstore.json
gh release download easyeda-mcp-pro-vX.Y.Z --pattern '*.intoto.jsonl'
test "$(wc -l < easyeda-mcp-pro-vX.Y.Z.intoto.jsonl)" -eq 1
```

## Signed tag policy

Stable release tags are created by Release Please. Numbered prerelease tags are annotated tags created by the release manager for the exact reviewed candidate commit. GPG-signed tags are not the primary signing mechanism; npm provenance and GitHub artifact attestations are. If the project later adds GPG-signed tags, document the public key and verification process in this file.

## Related files

- [Release Policy](RELEASE_POLICY.md)
- [`docs/RELEASE_PROCESS.md`](./RELEASE_PROCESS.md)
- [`CHANGELOG.md`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CHANGELOG.md)
- [GitHub Releases](https://github.com/oaslananka/easyeda-mcp-pro/releases)
- [npm package](https://www.npmjs.com/package/easyeda-mcp-pro)
