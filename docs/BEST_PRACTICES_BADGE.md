# OpenSSF Best Practices Badge Plan

Project page: <https://www.bestpractices.dev/projects/13406>

Current public status observed during the repository review: in progress at roughly one fifth of the passing tier. The badge application is a self-certification process; repository changes only improve the evidence base. The project owner still needs to mark criteria in the BadgeApp UI.

## Evidence now present in the repo

| Area                    | Evidence                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| Project description     | `README.md`, docs site, package metadata                                     |
| Contribution process    | `CONTRIBUTING.md`, issue templates                                           |
| License                 | `LICENSE`, package metadata                                                  |
| Documentation           | `docs/`, generated tool reference, installation guide, troubleshooting guide |
| HTTPS project/repo URLs | GitHub repository and GitHub Pages docs                                      |
| Version control         | GitHub repository using git                                                  |
| Unique releases         | SemVer npm releases and GitHub tags                                          |
| Release notes           | `CHANGELOG.md` and GitHub Releases                                           |
| Vulnerability reporting | `SECURITY.md` and GitHub Security Advisories                                 |
| Build system            | `pnpm build`, `pnpm build:extension`                                         |
| Automated tests         | `pnpm test`, CI quality workflow                                             |
| Static analysis         | ESLint, TypeScript, CodeQL, DeepScan                                         |
| Supply chain evidence   | npm provenance, SBOM, release assets, pinned actions                         |

## Remaining self-certification work

The owner should log in to BadgeApp and mark criteria as met only when the linked evidence is accurate. Start with Passing-level criteria under Basics, Change Control, Reporting, Quality, Security, and Analysis.

Recommended next manual entries:

- Project website: GitHub repo URL
- Repository URL: GitHub repo URL
- License: MIT
- Contribution URL: `CONTRIBUTING.md`
- License location: `LICENSE`
- Basic documentation: `README.md` and docs site
- Interface documentation: `docs/reference/tools.md` and `docs/reference/bridge-contract.md`
- Vulnerability process: `SECURITY.md`
- Build: `pnpm build` and `pnpm build:extension`
- Tests: `pnpm test`
- Static analysis: CI workflow with TypeScript, ESLint, CodeQL, DeepScan

## Repo-side rule

When a BadgeApp criterion cannot be marked because evidence is missing, create a GitHub issue with a concrete acceptance criterion rather than marking it as met prematurely.
