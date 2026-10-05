# Codecov analytics

The repository publishes complementary quality signals from dedicated Node.js 24 CI jobs:

- server and EasyEDA bridge-extension code coverage,
- server and extension JUnit test results for Codecov Test Analytics,
- deterministic extension JavaScript bundle-size budgets enforced by `extension-integrity`.

The workflow follows Codecov's guidance for [coverage uploads](https://docs.codecov.com/docs/quick-start), [Test Analytics](https://docs.codecov.com/docs/test-analytics), [repository configuration](https://docs.codecov.com/docs/codecov-yaml), and [JavaScript bundle analysis](https://docs.codecov.com/docs/javascript-bundle-analysis).

## Coverage reports

Vitest produces separate LCOV files so Codecov can show independent histories for the two codebases:

| Component                | Flag        | LCOV file                                     |
| ------------------------ | ----------- | --------------------------------------------- |
| MCP server               | `server`    | `coverage/lcov.info`                          |
| EasyEDA bridge extension | `extension` | `easyeda-bridge-extension/coverage/lcov.info` |

`codecov.yml` also defines matching Codecov components. Project coverage remains informational at the current baseline (`target: auto`) with 1% tolerance. The umbrella `codecov/patch` status retains an 80% target with a two-percentage-point tolerance for advisory changed-line analytics, but it is not branch-protection-required. Separate `server` and `extension` flags and components preserve independent histories without filtering the umbrella patch status or hiding changed-line annotations. The rationale and triage process are in [Changed-code quality gates](QUALITY_GATES.md).

Generate the reports locally with:

```bash
pnpm test:coverage:ci
pnpm test:extension:ci
```

## Test Analytics and failed tests

Both suites write JUnit XML:

- `reports/server.junit.xml`
- `reports/extension.junit.xml`

The required `tests-and-coverage` job validates both LCOV/JUnit report sets before staging them for telemetry. Missing, empty, malformed, or below-threshold reports fail the required local job. Artifact staging is best-effort because provider telemetry is not part of the merge boundary.

The separate `coverage-telemetry` job downloads validated reports, installs the verified Codecov CLI, and records configuration/upload outcomes in its own summary. Provider or artifact-service failures remain diagnosable without masking the local test result.

Generated reports are ignored by Git and must not be committed.

## Bundle-size budgets and remote analysis status

The extension uses a custom esbuild script rather than Vite, Rollup, or Webpack. Repository-owned byte budgets remain the blocking bundle-size control for `index.js`, `dispatcher.js`, and the packaged extension.

Remote Codecov Bundle Analysis is disabled. The previous `@codecov/bundle-analyzer@2.0.1` integration repeatedly received `404 Not Found` from Codecov's pre-signed URL endpoint in trusted CI and was no longer invoked by repository scripts. In October 2026 its dependency chain also became the repository's only path to the unresolved high-severity `braces@3.0.3` advisory. The unused analyzer dependency was therefore removed instead of weakening dependency-audit policy. Primary LCOV coverage and Test Analytics remain available as advisory telemetry, while deterministic local coverage thresholds and extension byte budgets remain blocking repository-owned controls.

Reintroduce remote bundle analysis only after a separately verified Codecov service/tooling path both works in trusted GitHub Actions and has a dependency graph that passes the repository security policy.

```bash
pnpm build:extension
pnpm check:extension-size
```

The current limits live in `config/extension-size-budget.json`. Missing artifacts, malformed budgets, or files above their configured limit fail CI.

On 2026-09-28, the polygon argument materialization required by `easyeda_api_call` increased the deterministic extension builds from 260,002 to 262,811 bytes for `index.js` and from 185,386 to 188,040 bytes for `dispatcher.js`. The corresponding byte ratchets are 262,815 and 188,045 bytes; the packaged `.eext` remains under its unchanged 200,000-byte ceiling. Future growth still fails closed and requires another measured ratchet review.

On 2026-10-05, the existing-copper rebuild path added explicit runtime capability checks, pre-mutation target validation, sequential native execution, source-pour-keyed persisted read-back verification, a complexity-preserving helper split, and ES2020-compatible error-cause preservation. Against current `main`, the deterministic build increased from 263,531 to 276,820 bytes for `index.js` and from 188,745 to 201,168 bytes for `dispatcher.js`; the packaged `.eext` increased from 177,983 to 183,089 bytes and remains below the unchanged 200,000-byte package ceiling. The reviewed ratchets are therefore 276,824 and 201,173 bytes, preserving the existing 4/5-byte deterministic margin. Any further growth still fails closed and requires another measured ratchet review.

## Configuration validation

The non-blocking `coverage-telemetry` job validates `codecov.yml` through Codecov's validator after local tests have passed:

```bash
pnpm validate:codecov
```

The workflow uses the repository `CODECOV_TOKEN` only for trusted pushes and same-repository pull requests. Fork and Dependabot pull requests still run tests and upload the two LCOV reports through Codecov's tokenless public-repository path. Authenticated JUnit Test Analytics and bundle uploads remain trusted-event only because GitHub does not expose repository secrets to untrusted runs.

Before upload, `scripts/install-codecov-cli.mjs` downloads the exact Linux asset declared in `config/codecov-cli.json`. The installer restricts the source to the official Codecov GitHub release path, checks the expected byte length and SHA-256 digest, writes the executable atomically, and passes that verified local binary to the SHA-pinned Codecov Action. This avoids disabling validation when the Action's remote GPG-key bootstrap is unavailable.
