# Supply Chain Verification

This project publishes npm packages, GitHub Release assets, SBOMs, build provenance attestations, and GHCR images through GitHub Actions. Channel selection and promotion rules are defined by the [Release Policy](RELEASE_POLICY.md).

## Release assets

Each public release should contain:

- `easyeda-bridge-extension.eext` — EasyEDA Pro extension package.
- `sbom.json` — CycloneDX software bill of materials.

## npm package verification

```bash
npm view easyeda-mcp-pro version dist-tags time.modified --json
npm view easyeda-mcp-pro@latest dist.integrity dist.tarball --json
npm view easyeda-mcp-pro@next dist.integrity dist.tarball --json
```

For stable releases, npm `latest` must match the non-prerelease GitHub Release. For numbered release candidates, npm `next` must match the GitHub prerelease while `latest` remains unchanged.

## GitHub Release verification

```bash
gh release view easyeda-mcp-pro-vX.Y.Z --json tagName,isDraft,isPrerelease,assets
gh release view easyeda-mcp-pro-vX.Y.Z-rc.N --json tagName,isDraft,isPrerelease,assets
```

A stable release must be non-draft and non-prerelease. A numbered candidate must be non-draft and marked prerelease. Both channels require a non-empty extension asset and `sbom.json`.

## Extension package verification

Local release candidates must pass:

```bash
pnpm build:extension
pnpm verify:extension
```

The verifier checks required package files, manifest metadata, logo dimensions, packaged documentation, checksums, and Marketplace content constraints.

## Container verification

Stable GHCR publication must provide the exact version, `X.Y`, and `latest` tags. A prerelease must provide only its exact `X.Y.Z-rc.N` tag and the moving `next` tag; it must not move `latest` or the stable minor tag.

## MCP Registry verification

The MCP Registry is a stable-only publication target. Confirm that a stable release is present after successful publication and that a prerelease did not update the registry entry.

## Maintainer rule

Do not close release, security, or supply-chain issues until the release asset, npm dist-tag, SBOM, and workflow status have been verified from the public registry or GitHub API.
