# Codecov analytics

The repository publishes three complementary quality signals from the Ubuntu and Node.js 24 `quality` job:

- server and EasyEDA bridge-extension code coverage,
- server and extension JUnit test results for Codecov Test Analytics,
- extension JavaScript bundle-size trends.

The workflow follows Codecov's guidance for [coverage uploads](https://docs.codecov.com/docs/quick-start), [Test Analytics](https://docs.codecov.com/docs/test-analytics), [repository configuration](https://docs.codecov.com/docs/codecov-yaml), and [JavaScript bundle analysis](https://docs.codecov.com/docs/javascript-bundle-analysis).

## Coverage reports

Vitest produces separate LCOV files so Codecov can show independent histories for the two codebases:

| Component                | Flag        | LCOV file                                     |
| ------------------------ | ----------- | --------------------------------------------- |
| MCP server               | `server`    | `coverage/lcov.info`                          |
| EasyEDA bridge extension | `extension` | `easyeda-bridge-extension/coverage/lcov.info` |

`codecov.yml` also defines matching Codecov components. Project and patch statuses use the current baseline (`target: auto`) with 1% tolerance and start as informational. This enforces the policy that new code should not materially reduce coverage without duplicating the repository's blocking Vitest thresholds.

Generate the reports locally with:

```bash
pnpm test:coverage:ci
pnpm test:extension:ci
```

## Test Analytics and failed tests

Both suites write JUnit XML:

- `reports/server.junit.xml`
- `reports/extension.junit.xml`

Codecov upload steps use the GitHub Actions `!cancelled()` condition. This allows JUnit and coverage artifacts produced before a failing assertion to reach Codecov, so the pull-request report can identify failed and flaky tests without hiding the original test failure.

Generated reports are ignored by Git and must not be committed.

## Bundle analysis and deterministic budgets

The extension uses a custom esbuild script rather than Vite, Rollup, or Webpack. The CI job therefore uses Codecov's general `@codecov/bundle-analyzer` CLI against `easyeda-bridge-extension/dist`.

Bundle Analysis is informational and tracks raw and gzip-size changes for `index.js` and `dispatcher.js`. It complements, but does not replace, the repository-owned blocking byte budgets:

```bash
pnpm build:extension
pnpm check:extension-size
```

The current limits live in `config/extension-size-budget.json`. Missing artifacts, malformed budgets, or files above their configured limit fail CI.

A local, non-uploading bundle report can be generated with:

```bash
pnpm exec bundle-analyzer easyeda-bridge-extension/dist \
  --bundle-name=easyeda-bridge-extension \
  --dry-run \
  --ignore-patterns='*.map' \
  --ignore-patterns='*.json'
```

## Configuration validation

Every quality run validates `codecov.yml` through Codecov's validator before tests begin:

```bash
pnpm validate:codecov
```

The workflow uses the repository `CODECOV_TOKEN` only for trusted pushes and same-repository pull requests. Fork and Dependabot pull requests still run tests, coverage generation, the deterministic size gate, and all other quality checks, but skip authenticated uploads because GitHub does not expose repository secrets to those runs.
