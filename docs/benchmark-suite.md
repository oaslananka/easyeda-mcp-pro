# Golden Eval Benchmark Suite

The golden eval benchmark is a non-live regression suite for agent-assisted EasyEDA MCP Pro workflows.

It validates diagnostics, semantic ERC, power-tree analysis, PCB production review, safe PCB layout planning, export manifest validation, production QA artifacts, vendor failure handling, observability reporting, and — via the five golden intent-to-Gerber scenarios below — an end-to-end pipeline-milestone check for five canonical board designs.

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
scenarioCount: 16
overallScore: 96.88
failedScenarioCount: 0
safetyViolationCount: 0
```

## Scenarios

| ID                                    | Area             | Purpose                                            |
| ------------------------------------- | ---------------- | -------------------------------------------------- |
| `health-check-core`                   | diagnostics      | Server health output shape                         |
| `config-redaction`                    | diagnostics      | Safe config output                                 |
| `semantic-erc-unsafe`                 | ERC              | Output contention, floating input, power conflict  |
| `power-tree-thermal`                  | power            | Current, dropout, and thermal failure detection    |
| `pcb-production-review`               | PCB production   | Manufacturing-critical blockers                    |
| `layout-preview-safety`               | PCB write        | Preview does not write or call bridge              |
| `export-manifest-missing-role`        | export           | Required QA role detection                         |
| `production-qa-artifacts`             | QA               | Testpoint, assembly, bring-up and QA artifacts     |
| `vendor-failure-no-secret`            | vendor API       | Degraded vendor result without credential leakage  |
| `design-rules-trace-width-citation`   | design-rules     | A rule lookup cites its source before use          |
| `observability-report`                | observability    | Budgets, metrics and retention metadata            |
| `golden-01-buck-converter`            | golden-benchmark | 12V→5V/3A buck converter: full pipeline milestones |
| `golden-02-esp32-adxl355-sensor-node` | golden-benchmark | ESP32-S3 + ADXL355 sensor node (starter catalog)   |
| `golden-03-usbc-dev-board`            | golden-benchmark | USB-C powered 3.3V dev board with input protection |
| `golden-04-rs485-field-node`          | golden-benchmark | RS-485 field node with isolation notes             |
| `golden-05-led-driver`                | golden-benchmark | Constant-current LED driver                        |

## Golden benchmark: Intent → Gerber pipeline milestones

The five `golden-0N-*` scenarios are the program's public, reproducible "intent to manufacturing artifacts" proof. Each scenario fixture (`tests/evals/fixtures/golden-0N-*.json`) bundles five hand-authored sections representing one canonical design fully worked out:

- `designIntent` — a `DesignIntent` document (project goal, functional blocks, power rails, mechanical/manufacturing intent)
- `ercInput` — a `NetValidationInput` (nets, devices, pin electrical types) representing the completed schematic's connectivity
- `drcInput` — a `PcbConstraintInput` representing the completed board's layout facts
- `exportManifestInput` — an `ExportManifestInput` representing a completed, checksummed export package
- `bomEntries` — a fully-sourced BOM (`ref`/`mpn`/`lcsc`/`quantity` per line)

`scripts/run-evals.mts`'s `easyeda_golden_benchmark` case runs each section through the same pure validation functions the corresponding MCP tools use — `compile()` (DesignIntent → CircuitIR), `validateNets()`, `validatePcbConstraints()`, `validateExportManifest()`, and a static BOM-completeness check (every line has a resolvable-looking LCSC id and a positive quantity) — and reports five boolean milestones:

```text
ir_valid              — compile() did not throw
erc_clean             — validateNets().valid
drc_clean             — validatePcbConstraints().valid
export_manifest_valid — validateExportManifest().valid
bom_fully_sourced     — every BOM line has an LCSC-shaped id and quantity > 0
```

**What this does and does not prove:** each milestone runs the real validation logic the MCP tools expose, but the _inputs_ are hand-authored fixtures representing "what a correctly-completed version of this design looks like" — not the output of an agent actually driving the bridge through schematic entry, layout, and export end-to-end. Closing that gap (an agent producing these five artifacts from the `designIntent` alone via live tool calls) is future work; today this scenario set proves the validation pipeline accepts a well-formed design cleanly end-to-end and rejects real mistakes (see the `semantic-erc-unsafe`, `power-tree-thermal`, `pcb-production-review`, and `export-manifest-missing-role` scenarios above for the negative-path coverage).

## CI

`.github/workflows/golden-benchmark.yml` runs the full mocked-fixture benchmark (`pnpm exec tsx scripts/run-evals.mts`) on push to `main`, on a weekly schedule, and on manual dispatch — **not** on pull requests, so a regression fails that workflow run loudly (visible in the Actions tab, report uploaded as an artifact) without blocking any PR merge. The live tier (an agent actually driving a connected EasyEDA Pro instance) remains manual, per the existing live-test opt-in policy — never run in CI.

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
