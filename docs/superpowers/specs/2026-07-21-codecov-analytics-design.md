# Codecov Analytics and Extension Size Budgets Design

## Goal

Add trustworthy coverage analytics and test analytics to the existing GitHub Actions quality job, while adding a dependency-free size regression gate for the EasyEDA extension artifacts.

## Scope

The implementation covers three related quality signals:

1. Upload server coverage from the existing Vitest V8 coverage run to Codecov.
2. Upload JUnit results for both the server and EasyEDA extension test suites to Codecov Test Analytics.
3. Enforce deterministic byte budgets for the packaged extension and its two browser bundles.

Codecov Bundle Analysis and `@codecov/vite-plugin` are intentionally excluded. The server is built with TypeScript and the extension is built directly with esbuild, so a Vite plugin would add an unrelated runtime dependency and duplicate a simpler artifact-size policy.

## CI Architecture

Only the Ubuntu/Node 24 `quality` job generates and uploads analytics. Platform matrix jobs remain focused on compatibility and do not upload duplicate coverage or test reports.

The server test run produces:

- `coverage/lcov.info`
- `reports/server.junit.xml`

The extension test run produces:

- `reports/extension.junit.xml`

Both uploads use `codecov/codecov-action` v6.0.1 pinned to commit `cddd853df119a48c5be31a973f8cd97e12e35e16`, with Codecov CLI `v11.3.1` pinned explicitly. Authentication uses the existing `CODECOV_TOKEN` repository secret. Uploads are skipped for fork pull requests because GitHub does not expose repository secrets to fork workflows.

Coverage and test-result uploads run with `if: !cancelled()` and explicit report-file checks, allowing reports to be uploaded after a test failure without hiding that failure from the job result.

## Coverage Policy

`vitest.config.ts` will guarantee an LCOV report in addition to text, JSON, and HTML output. `codecov.yml` will start with informational project and patch statuses:

- Project target: automatic baseline, 1% tolerance.
- Patch target: 80%, no tolerance.
- PR comments appear only when coverage changes.

The repository's existing local coverage thresholds remain authoritative and blocking: 80% lines, functions, and statements; 75% branches. Codecov statuses begin informational so the first uploads can establish a stable baseline before a separate decision makes them required branch checks.

## Test Analytics Policy

The server and extension suites are uploaded separately with the flags `server-tests` and `extension-tests`. This preserves independent timing and flakiness histories in Codecov. Vitest's default reporter remains enabled so GitHub logs stay readable while JUnit XML is written to disk.

## Extension Size Policy

A repository-owned Node script reads `config/extension-size-budget.json` and checks three files after `pnpm build:extension`:

- `easyeda-bridge-extension.eext`: maximum 200,000 bytes; baseline 158,435 bytes.
- `easyeda-bridge-extension/dist/index.js`: maximum 260,000 bytes; baseline 206,237 bytes.
- `easyeda-bridge-extension/dist/dispatcher.js`: maximum 185,000 bytes; baseline 146,162 bytes.

These limits provide approximately 25% headroom while still detecting accidental dependency or bundle growth. Missing files and invalid budget entries fail closed with actionable diagnostics.

## Security and Supply Chain

- GitHub Actions are pinned to full commit SHAs.
- The Codecov CLI version is pinned.
- The Codecov token is referenced only through GitHub Secrets and is never printed.
- Fork pull requests do not receive the token and therefore skip uploads.
- No new runtime or development dependency is added for analytics or bundle sizing.

## Testing

Repository policy tests will assert the Codecov action pin, CLI pin, report paths, token handling, informational policy, CI scripts, and absence of the Vite bundle plugin.

A behavioral test will execute the extension-size checker against temporary files and verify successful, over-budget, and missing-file cases. The complete repository verification command remains `pnpm verify`; workflow syntax is additionally checked with actionlint, and the pull request must pass all existing bot and agent checks.

## Success Criteria

- Local full verification passes.
- Server coverage generates `coverage/lcov.info`.
- Server and extension JUnit files parse as XML and contain test cases.
- Extension artifacts pass the configured size budgets.
- Pull-request CI uploads coverage and both test reports successfully.
- Codecov, SonarQube, Snyk, Semgrep, CodeQL, DeepScan, Socket, Dependency Review, and platform matrix checks report no blocking findings.
