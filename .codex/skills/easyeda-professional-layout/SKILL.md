---
name: easyeda-professional-layout
description: Codex guidance for deterministic, geometry-aware professional EasyEDA schematic layout and QA.
---

# EasyEDA Professional Layout

Load the canonical repository skill at `skills/easyeda-professional-layout/SKILL.md` and apply its workflow in full.

Core policy IDs are normative and may not be omitted: `PAGE_GEOMETRY_REQUIRED`, `TITLE_BLOCK_KEEP_OUT`, `RENDERED_BOUNDS_ONLY`, `NO_BLIND_RETRY`, `STAGED_PREVIEW_READBACK_QA`, `CONNECTIVITY_FINGERPRINT_REQUIRED`, and `NO_SAVE_WITH_CRITICALS`.

Use 100 mil border, 150 mil title-block, 50 mil component, 25 mil text, and 75 mil section clearances unless runtime units or stricter caller constraints require explicit conversion. Require preview, write approval, readback, QA, and connectivity-preserving rollback gates. Missing geometry blocks placement; it never permits guessed coordinates.
