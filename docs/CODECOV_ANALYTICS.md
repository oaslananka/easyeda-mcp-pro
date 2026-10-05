# Codecov analytics

The repository publishes three complementary quality signals from the Ubuntu and Node.js 24 `quality` job:

- server and EasyEDA bridge-extension code coverage,
- server and extension JUnit test results for Codecov Test Analytics,
- deterministic extension JavaScript bundle-size budgets.

The workflow follows Codecov's guidance for [coverage uploads](https://docs.codecov.com/docs/quick-start), [Test Analytics](https://docs.codecov.com/docs/test-analytics), [repository configuration](https://docs.codecov.com/docs/codecov-yaml), and [JavaScript bundle analysis](https://docs.codecov.com/docs/javascript-bundle-analysis).

## Coverage reports

Vitest produces separate LCOV files so Codecov can show independent histories for the two codebases:

| Component                | Flag        | LCOV file                                     |
| ------------------------ | ----------- | --------------------------------------------- |
| MCP server               | `server`    | `coverage/lcov.info`                          |
| EasyEDA bridge extension | `extension` | `easyeda-bridge-extension/coverage/lcov.info` |

`codecov.yml` also defines matching Codecov components. Project coverage remains informational at the current baseline (`target: auto`) with 1% tolerance. The umbrella `codecov/patch` status is blocking at 80% with a two-percentage-point tolerance, fails when coverage is missing or CI fails, and applies only to pull requests. Separate `server` and `extension` flags and components preserve independent histories without filtering the umbrella patch status or hiding changed-line annotations. The rationale and triage process are in [Changed-code quality gates](QUALITY_GATES.md).

Generate the reports locally with:

```bash
pnpm test:coverage:ci
pnpm test:extension:ci
```

## Test Analytics and failed tests

Both suites write JUnit XML:

- `reports/server.junit.xml`
- `reports/extension.junit.xml`

Coverage producers have explicit step IDs and their LCOV/JUnit outputs are validated before any Codecov upload. Server and extension producers remain independently diagnosable: an executed server coverage failure does not prevent the extension producer from running, but an upstream pre-coverage failure skips both producers. Codecov CLI installation runs only when at least one validated report exists, and each coverage or test-results upload requires both its matching report validation and the verified CLI installation to have succeeded.

An always-run quality summary records the dependency-audit, coverage, validation, Codecov CLI, and upload outcomes so the primary failure remains visible while dependent stages are reported as skipped. Missing, empty, or malformed reports therefore fail closed instead of creating secondary Codecov noise.

Generated reports are ignored by Git and must not be committed.

## Bundle-size budgets and remote analysis status

The extension uses a custom esbuild script rather than Vite, Rollup, or Webpack. Repository-owned byte budgets remain the blocking bundle-size control for `index.js`, `dispatcher.js`, and the packaged extension.

Remote Codecov Bundle Analysis is disabled. The previous `@codecov/bundle-analyzer@2.0.1` integration repeatedly received `404 Not Found` from Codecov's pre-signed URL endpoint in trusted CI and was no longer invoked by repository scripts. In October 2026 its dependency chain also became the repository's only path to the unresolved high-severity `braces@3.0.3` advisory. The unused analyzer dependency was therefore removed instead of weakening dependency-audit policy. Primary LCOV coverage, Test Analytics, the blocking `codecov/patch` status, and deterministic extension byte budgets remain unchanged.

Reintroduce remote bundle analysis only after a separately verified Codecov service/tooling path both works in trusted GitHub Actions and has a dependency graph that passes the repository security policy.

```bash
pnpm build:extension
pnpm check:extension-size
```

The current limits live in `config/extension-size-budget.json`. Missing artifacts, malformed budgets, or files above their configured limit fail CI.

On 2026-09-28, the polygon argument materialization required by `easyeda_api_call` increased the deterministic extension builds from 260,002 to 262,811 bytes for `index.js` and from 185,386 to 188,040 bytes for `dispatcher.js`. The corresponding byte ratchets are 262,815 and 188,045 bytes; the packaged `.eext` remains under its unchanged 200,000-byte ceiling. Future growth still fails closed and requires another measured ratchet review.

## Configuration validation

Every quality run validates `codecov.yml` through Codecov's validator before tests begin:

```bash
pnpm validate:codecov
```

The workflow uses the repository `CODECOV_TOKEN` only for trusted pushes and same-repository pull requests. Fork and Dependabot pull requests still run tests and upload the two LCOV reports through Codecov's tokenless public-repository path. Authenticated JUnit Test Analytics and bundle uploads remain trusted-event only because GitHub does not expose repository secrets to untrusted runs.

Before upload, `scripts/install-codecov-cli.mjs` downloads the exact Linux asset declared in `config/codecov-cli.json`. The installer restricts the source to the official Codecov GitHub release path, checks the expected byte length and SHA-256 digest, writes the executable atomically, and passes that verified local binary to the SHA-pinned Codecov Action. This avoids disabling validation when the Action's remote GPG-key bootstrap is unavailable.
