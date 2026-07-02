# Third-Party Notices

This project is distributed under the MIT License. This notice file summarizes third-party materials and external services that maintainers should review before each release. It is not legal advice.

## Runtime and development dependencies

The npm package depends on third-party open source packages declared in `package.json` and resolved in `pnpm-lock.yaml`. Maintain release evidence through:

- `pnpm audit --audit-level low`
- generated CycloneDX SBOM from the release workflow
- npm package provenance / GitHub attestations
- dependency review via Renovate, Dependabot, and CodeQL

Before a v1.0 release, attach the SBOM to the GitHub release and retain the generated artifact with the release notes.

## Bundled extension artifact

The npm package includes `easyeda-bridge-extension.eext`. The source for that artifact lives under `easyeda-bridge-extension/` and is built by `pnpm build:extension`.

The extension interacts with EasyEDA Pro through the user's installed EasyEDA environment. It must not claim endorsement by EasyEDA, JLCPCB, LCSC, Mouser, DigiKey, or any other vendor unless that vendor has granted explicit permission.

## External services and trademarks

`easyeda-mcp-pro` can integrate with or reference external services:

| Service          | Project use                                         | Maintainer note                                                                                                |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| EasyEDA Pro      | Local editor/runtime bridge                         | Users must comply with EasyEDA's terms for their own account, projects, and extension use.                     |
| JLCPCB           | Quote/manufacturing workflow preparation            | Quote and order workflows must remain non-binding unless explicit human review and credentials are configured. |
| LCSC / jlcsearch | Part search, availability, and BOM context          | Public search data must be treated as advisory and rechecked before ordering.                                  |
| Mouser           | Optional supplier search/cart/order API integration | Requires user-provided credentials and compliance with Mouser API/account terms.                               |
| DigiKey          | Optional supplier API integration                   | Requires user-provided credentials and compliance with DigiKey developer/account terms.                        |

All vendor names, logos, product names, and trademarks belong to their respective owners. This repository does not redistribute vendor databases, datasheets, pricing feeds, or proprietary EasyEDA/JLCPCB/LCSC/Mouser/DigiKey content.

## Generated outputs

The server can generate local review, manifest, BOM, export, benchmark, and QA artifacts. Generated outputs are user/project data and are not part of the project license unless explicitly committed by the maintainer.

## Release checklist

Before each public release:

- Run the complete CI gate from `docs/release-ci-runbook.md`.
- Confirm `npm pack --dry-run` includes only intended files.
- Verify `easyeda-bridge-extension.eext` is rebuilt and checksummed.
- Review `docs/vendor-terms.md` for stale vendor links or unsupported workflows.
- Attach SBOM and extension artifacts to the GitHub release.
- Do not include credentials, private designs, vendor API responses, or generated customer data in release artifacts.
