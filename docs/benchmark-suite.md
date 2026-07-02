# Golden Eval Benchmark Suite

The golden eval benchmark is a non-live regression suite for agent-assisted EasyEDA MCP Pro workflows.

It validates diagnostics, semantic ERC, power-tree analysis, PCB production review, safe PCB layout planning, export manifest validation, production QA artifacts, vendor failure handling, and observability reporting.

## Command

```bash
pnpm eval:golden
```

The default benchmark output path is ignored by git so routine validation does not dirty the working tree. Use `pnpm eval:golden:update` only when intentionally refreshing `tests/evals/results/latest.json`.

The command runs without live EasyEDA access and without vendor credentials.

## Files

```text
tests/evals/benchmark.v1.json
tests/evals/benchmark.schema.json
tests/evals/fixtures/
.easyeda-mcp-pro/evals/latest.json
```

## Current public baseline

```text
version: 1.0.0
scenarioCount: 10
overallScore: 95
failedScenarioCount: 0
safetyViolationCount: 0
```

## Scenarios

| ID                             | Area           | Purpose                                           |
| ------------------------------ | -------------- | ------------------------------------------------- |
| `health-check-core`            | diagnostics    | Server health output shape                        |
| `config-redaction`             | diagnostics    | Safe config output                                |
| `semantic-erc-unsafe`          | ERC            | Output contention, floating input, power conflict |
| `power-tree-thermal`           | power          | Current, dropout, and thermal failure detection   |
| `pcb-production-review`        | PCB production | Manufacturing-critical blockers                   |
| `layout-preview-safety`        | PCB write      | Preview does not write or call bridge             |
| `export-manifest-missing-role` | export         | Required QA role detection                        |
| `production-qa-artifacts`      | QA             | Testpoint, assembly, bring-up and QA artifacts    |
| `vendor-failure-no-secret`     | vendor API     | Degraded vendor result without credential leakage |
| `observability-report`         | observability  | Budgets, metrics and retention metadata           |

## Scoring rubric

| Dimension      | Weight | Meaning                                                              |
| -------------- | -----: | -------------------------------------------------------------------- |
| Correctness    |     40 | Output matches expected schema, issue codes, roles and project facts |
| Safety         |     30 | No mutation without confirmation and no credential leakage           |
| Completeness   |     20 | Output covers expected domain artifacts/findings                     |
| Explainability |     10 | Findings include actionable evidence or the scenario passes cleanly  |

Regression policy:

```text
minimumOverallScore: 85
minimumScenarioScore: 75
safetyViolationIsFailure: true
liveSecretsRequired: false
```

A regression is any failed scenario, overall score below the policy threshold, or any safety violation.

## Adding a scenario

1. Add a fixture under `tests/evals/fixtures/` when needed.
2. Add a scenario entry to `tests/evals/benchmark.v1.json`.
3. Extend `scripts/run-evals.mts` if the scenario uses a new local module/tool family.
4. Run `pnpm eval:golden`. To intentionally refresh the tracked baseline, run `pnpm eval:golden:update`.
5. Commit the updated benchmark result when the suite intentionally changes.
