# Schematic Layout Benchmarks

> **Status:** Active (fixture suite tracked by [#276](https://github.com/oaslananka/easyeda-mcp-pro/issues/276))
> **Applies to:** easyeda-mcp-pro v0.34.0+

This page explains what a golden fixture for schematic layout/QA needs to
assert, and what to check before you add or change one. It builds on the
general fixture mechanism described in [Golden E2E Fixtures](/golden-fixtures)
— read that page first for the fixture file layout and CI-safe smoke-test
model.

A dedicated `tests/fixtures/golden/*` layout fixture suite (deterministic
plans, QA score snapshots, capture comparisons per template) is tracked by
issue #276 and is not yet part of this repository. Until it lands, use this
page as the contract that suite must satisfy, and validate layout changes
manually against the checklist below.

## What a layout golden fixture must pin down

Unlike a BOM or export fixture, a layout fixture is checking a workflow that
combines a deterministic engine (page geometry, placement, collision) with
runtime-dependent evidence (ERC results, native EasyEDA warnings). Keep those
two kinds of assertion separate:

| Layer                | Source                                                               | Assertion style                                                                                                                                |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometry & placement | `easyeda_schematic_plan_layout`, `easyeda_schematic_check_placement` | Exact — same input must produce the same plan/verdict every run (`professionalLayoutCatalogDigest`-style hashing)                              |
| Layout QA scores     | `easyeda_schematic_layout_qa`                                        | Exact for `geometry`/`spacing` (derived from rendered bounds); range-bounded for `electrical`/`runtime` (depends on live ERC/DRC availability) |
| Visual capture       | `easyeda_schematic_capture_full_page`                                | Structural — dimensions, transform math, and `deterministic_viewport` must hold; do not diff raw pixels                                        |
| Connectivity         | `easyeda_schematic_connectivity_fingerprint`                         | Exact — a cosmetic-only fixture must show an unchanged fingerprint before/after                                                                |

## Before updating a golden fixture

1. Confirm the change is intentional. A layout fixture only moves when the
   planner, QA scoring, or a template's numeric defaults changed on purpose —
   never to make a flaky assertion pass.
2. Re-run the fixture against a live EasyEDA Pro + bridge session (per the
   [Professional Schematic Layout](/professional-schematic-layout) workflow),
   not just the CI-safe smoke test — the smoke test validates structure, not
   real geometry.
3. Diff every score dimension individually
   (`geometry`/`readability`/`grouping`/`spacing`/`wiring`/`electrical`/`runtime`/`overall`),
   not just `overall`. A stable `overall` can hide a regression in one
   dimension offset by an improvement in another.
4. If a template's `numericDefaults` or `supportRules` changed, bump its
   `version` (`src/professional-layout-templates/types.ts`) and re-run
   `validateProfessionalLayoutTemplateCatalog` — the catalog throws at import
   time if validation fails, so this is caught by `pnpm build` as well as
   tests.
5. Never hand-edit a captured image or a plan hash into a fixture file to
   make a test pass — regenerate it from a real run.

## Related

- [Golden E2E Fixtures](/golden-fixtures) — general fixture architecture and
  CI-safe smoke-test model this suite extends.
- [Professional Schematic Layout](/professional-schematic-layout) — the
  workflow being benchmarked.
- [MCP Tools Reference](/reference/tools) — schemas for every tool named
  above.
