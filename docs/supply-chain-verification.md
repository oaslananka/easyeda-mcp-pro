# Supply Chain Verification

This project publishes npm packages, GitHub Release assets, SBOMs, build provenance attestations, and GHCR images through GitHub Actions.

## Release assets

Each public release should contain:

- `easyeda-bridge-extension.eext` — EasyEDA Pro extension package.
- `sbom.json` — CycloneDX software bill of materials.

## npm package verification

```bash
npm view easyeda-mcp-pro version dist-tags.latest time.modified --json
npm view easyeda-mcp-pro dist.integrity dist.tarball --json
```

The `latest` dist-tag must match the GitHub Release version before users are asked to upgrade.

## GitHub Release verification

```bash
gh release view easyeda-mcp-pro-vX.Y.Z --json tagName,isDraft,isPrerelease,assets
```

The release must not be draft or prerelease for stable instructions. The extension asset must be present and non-empty.

## Extension package verification

Local release candidates must pass:

```bash
pnpm build:extension
pnpm verify:extension
```

The verifier checks required package files, manifest metadata, logo dimensions, packaged documentation, checksums, and Marketplace content constraints.

## Container verification

The GHCR package should publish the exact version tag, the minor version tag, and `latest` after the Docker job completes.

## Maintainer rule

Do not close release, security, or supply-chain issues until the release asset, npm dist-tag, SBOM, and workflow status have been verified from the public registry or GitHub API.
