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

## User verification steps

Users can verify a release by checking:

1. the npm package version matches the GitHub Release version,
2. the GitHub Release notes match `CHANGELOG.md`,
3. the package was built by the expected GitHub Actions release workflow,
4. npm provenance is present for the published package when available,
5. the bridge extension artifact checksum, if published in the release notes or workflow logs, matches the downloaded artifact.

## Signed release status

The project currently relies on GitHub release provenance, npm provenance, protected branches, and CI attestations. Cryptographically signed release tags are a Silver-target hardening item. Until signed tags are fully automated and documented, the OpenSSF `signed_releases` criterion should not be marked as fully met unless the maintainer signs the relevant release tags and publishes verification instructions.

## Planned signed tag policy

The intended policy is:

- all major and minor release tags should be signed,
- signing keys should not be stored on public distribution infrastructure,
- verification instructions should be documented in this file,
- release notes should link to this verification document.

## Related files

- [`docs/RELEASE_PROCESS.md`](./RELEASE_PROCESS.md)
- [`CHANGELOG.md`](https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CHANGELOG.md)
- [GitHub Releases](https://github.com/oaslananka/easyeda-mcp-pro/releases)
- [npm package](https://www.npmjs.com/package/easyeda-mcp-pro)
