# Eval Scenarios

These scenarios are versioned acceptance examples for agent-assisted EasyEDA workflows. They are intended to be used with mocked fixtures or live EasyEDA smoke tests depending on the scenario. Non-live scenarios must run without secrets.

## Scoring rubric

| Dimension      | Weight | Description                                                                              |
| -------------- | -----: | ---------------------------------------------------------------------------------------- |
| Correctness    |     40 | Tool output matches expected schema and project facts.                                   |
| Safety         |     30 | No mutation occurs without explicit confirmation.                                        |
| Completeness   |     20 | Output covers schematic, BOM, DRC/ERC, export, or bridge state expected by the scenario. |
| Explainability |     10 | Findings include severity, evidence, and next action.                                    |

A regression is any score drop below the scenario's documented threshold or any safety violation.

## Scenario 1: Server health check

- Call `easyeda_health_check`.
- Expect: response with status `ok`, version string, uptime.

## Scenario 2: Tool profiles

- Call `easyeda_get_tool_profiles`.
- Expect: list of profiles, default profile is `core`, profile counts match generated docs.

## Scenario 3: Feature flags

- Call `easyeda_get_feature_flags`.
- Expect: flags returned as booleans, dangerous flags disabled by default.

## Scenario 4: Server config redaction

- Call `easyeda_get_server_config`.
- Expect: no secrets or tokens in output.

## Scenario 5: Capabilities

- Call `easyeda_get_capabilities`.
- Expect: server name, version, profiles, feature flags, and transports.

## Scenario 6: Bridge offline diagnostics

- Run `easyeda-mcp-pro doctor` without EasyEDA connected.
- Expect: bridge offline is reported as informational, not fatal.

## Scenario 7: EasyEDA live smoke report

- Call `easyeda_live_smoke_report` when EasyEDA is connected.
- Expect: bridge status, API inventory, component probe, wire probe, and net extraction checks.

## Scenario 8: Schematic net extraction

- Use a simple power-to-resistor-to-ground schematic.
- Expect: non-empty `+5V` and `GND` nets with component nodes.

## Scenario 9: BOM generation

- Generate BOM from a fixture.
- Expect: structured rows with designator, value, footprint, and source metadata when available.

## Scenario 10: Vendor API failure handling

- Simulate missing credentials or vendor API failure.
- Expect: low-confidence or unavailable result, no crash, no secret leakage.

## Scenario 11: Export manifest validation

- Validate a fixture export package.
- Expect: hashes, missing-file detection, and actionable errors.

## Scenario 12: Marketplace package validation

- Run `pnpm verify:extension`.
- Expect: manifest metadata, logo, packaged docs, checksums, and phone-like-content checks pass.

## Scenario 13: Design rules lookup citation

- Call `easyeda_design_rules_lookup` with `topic=trace-width` for a given current/temperature-rise/layer/copper-weight.
- Expect: a computed `traceWidthMils`, plus a non-empty `source` and `caveat` — an agent citing this tool's output must be able to point at where the number came from and what it does not account for.

## Scenarios 14-18: Golden benchmark — Intent to Gerber (five canonical designs)

- Five hand-authored, fully-worked-out designs, each scored across five pipeline milestones (`ir_valid`, `erc_clean`, `drc_clean`, `export_manifest_valid`, `bom_fully_sourced`): a 12V→5V/3A buck converter, an ESP32-S3 + ADXL355 sensor node (exercising the starter catalog's real entries), a USB-C powered 3.3V dev board with input protection, an RS-485 field node with isolation notes, and a constant-current LED driver.
- Expect: all five milestones pass for all five designs in non-live mode, with no secrets required. See `docs/benchmark-suite.md`'s "Golden benchmark" section for exactly what each milestone checks and does not prove.
