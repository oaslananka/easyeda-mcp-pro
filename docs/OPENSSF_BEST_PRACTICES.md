# OpenSSF Best Practices Map

BadgeApp project: <https://www.bestpractices.dev/projects/13406>

This file is a copy-ready evidence map for OpenSSF Best Practices self-certification. It records the current Passing, Silver, and future badge evidence in one stable location. The BadgeApp entry is owned by the maintainer, so this repository can provide evidence links, but the final `Met`, `Unmet`, or `N/A` selections must be saved by the logged-in project owner.

## How to use this file

1. Open the project in BadgeApp.
2. Complete Passing criteria first.
3. Move to Silver criteria after Passing is achieved.
4. Paste the evidence URL listed below into the criterion URL/comment field, or use the linked document as the supporting evidence.
5. Do not mark a criterion `Met` unless the linked evidence is accurate for the live repository.

## High-priority Passing evidence

| BadgeApp criterion                       | Suggested status | Evidence                                                                                                                                                                          |
| ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `homepage_url`                           | Met              | <https://github.com/oaslananka/easyeda-mcp-pro>                                                                                                                                   |
| `repo_url`                               | Met              | <https://github.com/oaslananka/easyeda-mcp-pro>                                                                                                                                   |
| `license`                                | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/LICENSE>                                                                                                                 |
| `contribution_requirements`              | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md>                                                                                                         |
| `documentation_interface`                | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/reference/tools.md> and <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/reference/bridge-contract.md> |
| `report_tracker`                         | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/issues>                                                                                                                            |
| `vulnerability_report_process`           | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md>                                                                                                             |
| `build`                                  | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/package.json> and <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/workflows/ci.yml>                     |
| `test`                                   | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/package.json> and <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/workflows/ci.yml>                     |
| `test_continuous_integration`            | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml>                                                                                                          |
| `static_analysis`                        | Met              | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/.github/workflows/ci.yml>                                                                                                |
| `static_analysis_common_vulnerabilities` | Met              | CodeQL workflow/checks: <https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml>                                                                                  |
| `delivery_mitm`                          | Met              | GitHub and npm HTTPS release channels.                                                                                                                                            |
| `no_leaked_credentials`                  | Met              | GitHub secret scanning and push protection are enabled; see governance checklist.                                                                                                 |

## Silver evidence

| BadgeApp criterion                | Suggested status                            | Evidence / rationale                                                                                                                                              |
| --------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `achieve_passing`                 | Met only after BadgeApp shows Passing       | <https://www.bestpractices.dev/projects/13406>                                                                                                                    |
| `dco`                             | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md#developer-certificate-of-origin-dco>                                                     |
| `governance`                      | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/REPOSITORY_GOVERNANCE.md>                                                                           |
| `code_of_conduct`                 | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CODE_OF_CONDUCT.md>                                                                                      |
| `roles_responsibilities`          | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/REPOSITORY_GOVERNANCE.md#roles-and-responsibilities>                                                |
| `access_continuity`               | Met if the offline continuity record exists | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/MAINTAINER_CONTINUITY.md>                                                                           |
| `bus_factor`                      | Unmet or justified                          | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/MAINTAINER_CONTINUITY.md#solo-maintainer-bus-factor-statement>                                      |
| `documentation_roadmap`           | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/ROADMAP.md>                                                                                         |
| `documentation_architecture`      | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/security-architecture.md>                                                                           |
| `documentation_security`          | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md> and <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/security-architecture.md> |
| `documentation_quick_start`       | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/README.md#quick-start>                                                                                   |
| `documentation_current`           | Met                                         | CI docs generation and documentation review are part of release gates.                                                                                            |
| `documentation_achievements`      | Met                                         | README includes the OpenSSF Best Practices badge.                                                                                                                 |
| `accessibility_best_practices`    | Met / N/A with explanation                  | CLI/server project; docs and README use semantic Markdown and image alt text.                                                                                     |
| `internationalization`            | N/A or unmet with explanation               | CLI/server project primarily emits technical English messages; broad i18n is not currently a project goal.                                                        |
| `sites_password_security`         | N/A                                         | Project sites use GitHub/BadgeApp authentication; the project does not store external-user passwords.                                                             |
| `maintenance_or_update`           | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/ROADMAP.md#maintenance-policy>                                                                      |
| `vulnerability_report_credit`     | Met / N/A                                   | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md#reporter-credit>                                                                             |
| `vulnerability_response_process`  | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/SECURITY.md#response-process>                                                                            |
| `coding_standards`                | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md#coding-standards>                                                                        |
| `coding_standards_enforced`       | Met                                         | CI enforces Prettier, ESLint, TypeScript, and tests.                                                                                                              |
| `build_standard_variables`        | N/A                                         | TypeScript/npm package; no native compiler/linker build is produced.                                                                                              |
| `build_preserve_debug`            | N/A                                         | TypeScript/npm package; no native binary stripping process.                                                                                                       |
| `build_non_recursive`             | Met                                         | pnpm/TypeScript build uses project-level scripts rather than recursive native subdirectory builds.                                                                |
| `build_repeatable`                | Met / justify                               | Eval outputs are written outside tracked files by default; release artifacts are produced by deterministic CI scripts where practical.                            |
| `installation_common`             | Met                                         | npm package and `npx easyeda-mcp-pro` setup.                                                                                                                      |
| `installation_standard_variables` | N/A                                         | npm-managed package install; no POSIX-style install path variables are used.                                                                                      |
| `installation_development_quick`  | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md#local-development-setup>                                                                 |
| `external_dependencies`           | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/package.json> and <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/pnpm-lock.yaml>               |
| `dependency_monitoring`           | Met                                         | Dependabot, Renovate, `pnpm audit`, Socket, and CodeQL.                                                                                                           |
| `updateable_reused_components`    | Met                                         | npm/pnpm-managed dependencies and lockfile updates.                                                                                                               |
| `interfaces_current`              | Met                                         | TypeScript strictness, dependency monitoring, and compatibility docs.                                                                                             |
| `automated_integration_testing`   | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml>                                                                                          |
| `regression_tests_added50`        | Met / justify                               | CONTRIBUTING requires regression tests for bug fixes where practical.                                                                                             |
| `test_statement_coverage80`       | Met                                         | Coverage is tracked through `pnpm test:coverage`; latest local audit exceeded 80% statements.                                                                     |
| `test_policy_mandated`            | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/CONTRIBUTING.md#testing-policy>                                                                          |
| `implement_secure_design`         | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/SECURITY_ASSURANCE_CASE.md>                                                                         |
| `input_validation`                | Met                                         | Zod schemas, MCP tool schemas, config validation, path constraints.                                                                                               |
| `crypto_algorithm_agility`        | Met / N/A                                   | OAuth/JWKS verification delegates algorithm support to standards-based JOSE/JWKS providers.                                                                       |
| `crypto_credential_agility`       | Met                                         | Credentials are supplied through environment variables/secrets, not compiled into code.                                                                           |
| `signed_releases`                 | Not yet fully met                           | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/RELEASE_VERIFICATION.md#signed-release-status>                                                      |
| `version_tags_signed`             | Suggested, not yet fully met                | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/RELEASE_VERIFICATION.md#planned-signed-tag-policy>                                                  |
| `hardening`                       | Met                                         | Security headers, OAuth, branch protection, secret scanning, and safe defaults.                                                                                   |
| `assurance_case`                  | Met                                         | <https://github.com/oaslananka/easyeda-mcp-pro/blob/main/docs/SECURITY_ASSURANCE_CASE.md>                                                                         |

## BadgeApp helper

The file [`scripts/maintainer/openssf-badgeapp-autofill.js`](../scripts/maintainer/openssf-badgeapp-autofill.js) is a best-effort browser-console helper for the logged-in BadgeApp form. It only sets radio values for criteria where evidence is present. Review every value before saving.
