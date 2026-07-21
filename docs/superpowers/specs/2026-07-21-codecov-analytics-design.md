# Codecov Analytics and Extension Size Budgets Design

## Goal

Add trustworthy coverage, test, and bundle analytics to the existing GitHub Actions quality job, while retaining a dependency-free blocking size regression gate for the EasyEDA extension artifacts.

## Scope

The implementation covers three related quality signals:

1. Upload separate server and EasyEDA bridge-extension coverage reports to Codecov.
2. Upload JUnit results for both test suites to Codecov Test Analytics.
3. Publish informational bundle-size trends through Codecov's general bundle analyzer.
4. Enforce deterministic byte budgets for the packaged extension and its two browser bundles.

`@codecov/vite-plugin` remains excluded because the extension does not use Vite. Codecov's general `@codecov/bundle-analyzer` CLI is appropriate for the custom esbuild output and complements the repository-owned byte gate rather than replacing it.

## CI Architecture

Only the Ubuntu/Node 24 `quality` job generates and uploads analytics. Platform matrix jobs remain focused on compatibility and do not upload duplicate coverage or test reports.

The server test run produces:

- `coverage/lcov.info`
- `reports/server.junit.xml`

The extension test run produces:

- `easyeda-bridge-extension/coverage/lcov.info`
- `reports/extension.junit.xml`

All four report uploads use `codecov/codecov-action` v6.0.1 pinned to commit `cddd853df119a48c5be31a973f8cd97e12e35e16`. Codecov CLI `11.3.1` is downloaded from its official GitHub release, verified against the repository-pinned byte length and SHA-256 digest, and supplied through the Action's `binary` input. Authentication uses the existing `CODECOV_TOKEN` repository secret. Uploads are skipped for fork pull requests because GitHub does not expose repository secrets to fork workflows.

Coverage and test-result uploads run with `if: !cancelled()` and explicit report-file checks, allowing reports to be uploaded after a test failure without hiding that failure from the job result.

## Coverage Policy

The server and extension Vitest configurations guarantee separate LCOV reports. `codecov.yml` defines `server` and `extension` flags plus matching components, and starts with informational project and patch statuses:

- Project target: automatic baseline, 1% tolerance.
- Patch target: automatic baseline, 1% tolerance.
- PR comments appear only when coverage changes.

The repository's existing local coverage thresholds remain authoritative and blocking: 80% lines, functions, and statements; 75% branches. Codecov statuses begin informational so the first uploads can establish a stable baseline before a separate decision makes them required branch checks.

## Test Analytics Policy

The server and extension suites are uploaded separately with the flags `server-tests` and `extension-tests`. This preserves independent timing and flakiness histories in Codecov. Vitest's default reporter remains enabled so GitHub logs stay readable while JUnit XML is written to disk.

## Bundle Analysis Policy

The pinned `@codecov/bundle-analyzer` CLI scans `easyeda-bridge-extension/dist` after the production extension build. It uploads raw and gzip-size data for JavaScript assets under the stable bundle name `easyeda-bridge-extension`; source maps and JSON metadata are excluded. Bundle status and PR-comment behavior remain informational, with a 5% warning threshold and comments only for bundle increases of at least 1 KB.

This remote trend signal is not a release gate by itself. Its upload is explicitly best-effort so Codecov onboarding, feature availability, or an API outage cannot fail the quality job. The deterministic repository-owned budgets below remain blocking and work without Codecov availability.

## Extension Size Policy

A repository-owned Node script reads `config/extension-size-budget.json` and checks three files after `pnpm build:extension`:

- `easyeda-bridge-extension.eext`: maximum 200,000 bytes; baseline 158,435 bytes.
- `easyeda-bridge-extension/dist/index.js`: maximum 260,000 bytes; baseline 206,237 bytes.
- `easyeda-bridge-extension/dist/dispatcher.js`: maximum 185,000 bytes; baseline 146,162 bytes.

These limits provide approximately 25% headroom while still detecting accidental dependency or bundle growth. Missing files and invalid budget entries fail closed with actionable diagnostics.

## Security and Supply Chain

- GitHub Actions are pinned to full commit SHAs.
- The Codecov CLI version, release asset, byte length, and SHA-256 digest are pinned; installation fails closed before upload.
- The Codecov token is referenced only through GitHub Secrets and is never printed.
- Fork pull requests do not receive the token and therefore skip uploads.
- `@codecov/bundle-analyzer` is an exact-pinned MIT-licensed development dependency and is never shipped in the runtime package.
- Codecov YAML is validated through the official validator in every quality run.

## Testing

Repository policy tests assert the Codecov action pin, CLI pin, report paths, token handling, flags/components, bundle policy, validation command, and absence of the unrelated Vite plugin.

A behavioral test will execute the extension-size checker against temporary files and verify successful, over-budget, and missing-file cases. The complete repository verification command remains `pnpm verify`; workflow syntax is additionally checked with actionlint, and the pull request must pass all existing bot and agent checks.

## Success Criteria

- Local full verification passes.
- Server and extension coverage generate separate LCOV files.
- Server and extension JUnit files parse as XML and contain test cases.
- Codecov's validator accepts `codecov.yml`.
- The general bundle analyzer generates a report for the two extension JavaScript assets.
- Extension artifacts pass the configured size budgets.
- Pull-request CI uploads both coverage reports, both test reports, and bundle metadata successfully.
- Codecov, SonarQube, Snyk, Semgrep, CodeQL, DeepScan, Socket, Dependency Review, and platform matrix checks report no blocking findings.
