# Release Verification

This document explains how `easyeda-mcp-pro` releases are produced and how users can verify release integrity.

## Release channels

The project publishes release artifacts through:

- npm package: `easyeda-mcp-pro`
- GitHub Releases
- Git tags created by the release workflow
- bundled EasyEDA bridge extension artifact attached to GitHub Releases

## Automated release process

1. Conventional commits are merged into `main`.
2. Release Please opens or updates a release pull request.
3. The release pull request updates version metadata and `CHANGELOG.md`.
4. After merge, CI re-runs the quality gates.
5. The release workflow publishes the npm package with provenance and uploads release artifacts.

## Verification checks for maintainers

For each release, maintainers should verify:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm build
pnpm build:extension
pnpm verify:extension
pnpm docs:build
npm pack --dry-run
```

The release PR and release workflow must pass the required GitHub status checks before release artifacts are considered valid.

### Docker smoke check

The CI `quality` job is the source of truth for Docker release readiness. It builds the Docker image, starts the container, and checks `/healthz` before the release is considered valid.

Maintainers with Docker installed can repeat the same smoke locally:

```bash
docker build -t easyeda-mcp-pro:release-smoke .
cid=$(docker run -d easyeda-mcp-pro:release-smoke)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
sleep 3
docker logs "$cid"
docker exec "$cid" node -e "const r = await fetch('http://127.0.0.1:3000/healthz'); if (!r.ok) process.exit(1); console.log(await r.text());"
```

If the maintainer workstation or VPS does not have Docker installed, record that the local Docker smoke was skipped and link to the passing CI `quality` job. Do not treat a Docker-less local host as a release blocker when the CI Docker smoke has passed.

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
- Release creation and publishing run from the protected `main` branch after release quality gates pass.

This is the project's signed-release posture for the OpenSSF `signed_releases` criterion. It uses provenance and artifact attestations rather than manually managed GPG tag signatures.

## Verification examples

For npm provenance, inspect the package page or package metadata for provenance on the released version:

```bash
npm view easyeda-mcp-pro@latest version dist.integrity
```

For GitHub artifact attestations, download the released artifact and verify it against this repository:

```bash
gh attestation verify easyeda-bridge-extension.eext --repo oaslananka/easyeda-mcp-pro
```

## Signed tag policy

Release tags are created by Release Please. GPG-signed release tags are not the primary signing mechanism; provenance and artifact attestations are. If the project later adds manual or automated GPG-signed tags, document the public key and verification process in this file.

## Related files

- [`docs/RELEASE_PROCESS.md`](./RELEASE_PROCESS.md)
- [`CHANGELOG.md`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CHANGELOG.md)
- [GitHub Releases](https://github.com/oaslananka/easyeda-mcp-pro/releases)
- [npm package](https://www.npmjs.com/package/easyeda-mcp-pro)
