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

## Silver evidence package

The repository now includes a dedicated Silver evidence package:

- `docs/OPENSSF_BEST_PRACTICES.md` — copy-ready BadgeApp criterion-to-evidence map.
- `docs/ROADMAP.md` — 12-month roadmap and non-goals.
- `docs/MAINTAINER_CONTINUITY.md` — continuity and bus-factor documentation.
- `docs/SECURITY_ASSURANCE_CASE.md` — threat model, trust boundaries, secure design argument, and countermeasures.
- `docs/RELEASE_VERIFICATION.md` — release verification and signed-release target policy.
- `scripts/maintainer/openssf-badgeapp-autofill.js` — optional browser-console helper for the logged-in BadgeApp form.

### Criteria that still need maintainer judgment

Do not blindly mark these as met:

- `achieve_passing`: only after BadgeApp shows Passing.
- `achieve_silver`: only after all Silver MUST/MUST NOT criteria are satisfied.
- `bus_factor`: currently one; either mark unmet/justified or add a backup maintainer.
- `signed_releases` and `version_tags_signed`: not fully met until signed tags/releases are implemented and verification instructions are complete.
- `internationalization`: likely N/A or justified unmet unless project text-localization support becomes a goal.

### BadgeApp workflow

1. Open the BadgeApp project page for project `13406`.
2. Complete Passing criteria first.
3. Use `docs/OPENSSF_BEST_PRACTICES.md` to fill Silver evidence links.
4. Save only answers that match the live repository state.
5. Create follow-up issues for any criterion that cannot honestly be marked `Met` or `N/A`.
