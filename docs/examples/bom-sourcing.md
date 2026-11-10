# BOM Sourcing & Validation Example Workflow

This guide demonstrates how to generate a Bill of Materials (BOM) from your EasyEDA Pro project, validate it against the LCSC database, and query real-time stock levels and pricing.

---

## Steps

### 1. Generate the BOM

Run the BOM tool to extract all schematic symbols, values, footprints, and associated LCSC part numbers from the active project sheet:

**MCP Call**:
`easyeda_bom_generate`

**Response Output**:

```json
{
  "project_id": "proj-123",
  "format": "json",
  "group_by": "value",
  "entries": [
    {
      "reference": "U1",
      "value": "ESP32-WROOM-32E",
      "footprint": "MODULE",
      "lcsc": "C701342",
      "quantity": 1
    },
    { "reference": "C1", "value": "10uF", "footprint": "0603", "lcsc": "C19702", "quantity": 1 },
    { "reference": "R1", "value": "10k", "footprint": "0603", "lcsc": "C25804", "quantity": 1 }
  ],
  "total_entries": 3
}
```

**Multi-unit device protection:** BOM quantity counts verified _physical component
instances_, not schematic symbol sections. For example, two units of one amplifier
sharing the same designator, device, library and native `UniqueId`, with different
`subPartName` values, contribute **one** physical device. An explicit native
`AddIntoBom=false` flag excludes that symbol from purchasing quantities.

If a designator/physical identity conflicts or required unit identity is missing,
`easyeda_bom_generate` returns `not_available=true` and
`error_code="BOM_IDENTITY_AMBIGUOUS"` instead of inventing a quantity. Use the
read-only `easyeda_schematic_components` fields `uniqueId`, `subPartName`
and `addIntoBom` to inspect the mismatch before ordering. This safeguard is
not proof of native multi-unit placement, complete physical BOM authentication,
supplier stock, or manufacturing approval.

---

### 2. Verify Supplier Part IDs Without Guessing

Use `easyeda_bom_validate` with a `projectId` to check which BOM lines
resolve to LCSC supplier records. For example:

```json
{
  "project_id": "proj-123",
  "total_parts": 4,
  "missing_lcsc": ["R1"],
  "invalid_lcsc": [],
  "unverified_lcsc": ["U2"],
  "obsolete": ["U3"],
  "valid_count": 1,
  "validated": false
}
```

**Do not treat `validated` as manufacturing approval.** It is `true` only
when at least one supplied LCSC part ID was confirmed by the provider and
no supplied part ID remains unverified. Parts without an LCSC code still
appear under `missing_lcsc`; known-discontinued IDs appear under `obsolete`.
If the supplier client is disconnected, times out, returns a different
part ID, or cannot find a part in the free keyless _top in-stock_
snapshot, `unverified_lcsc` lists the affected reference designators and
`validated=false`. A missing free-snapshot match is **not proof that
the part number is invalid or obsolete**. `valid_count` counts only
supplier-confirmed IDs that are not known to be discontinued, and does
not promise that stock, price, availability, or suitability is current.
For purchasing decisions, resolve unknown IDs and check live supplier
availability separately.

---

### 3. Query Real-Time Pricing and Sourcing

Fetch current pricing and stock for BOM parts. With an empty `.env`, this works out of
the box: LCSC parts are resolved through the keyless jlcsearch tier
(`KEYLESS_SOURCING_ENABLED=true` by default), no credentials required.

**MCP Call**:
`easyeda_bom_sourcing` with a `projectId` (an optional `suppliers` filter restricts which
suppliers are tried; omit it to try every configured supplier).

**Sourcing Output**:

```json
{
  "project_id": "proj-123",
  "parts": [
    {
      "reference": "R1",
      "value": "10k",
      "lcsc": "C25804",
      "sourcing": [
        {
          "supplier": "lcsc",
          "tier": "keyless",
          "in_stock": true,
          "quantity_available": 37165617,
          "unit_price": 0.000842857,
          "currency": "USD",
          "classification": "basic",
          "from_cache": false,
          "cache_age_seconds": 0
        }
      ]
    }
  ],
  "total_parts": 1,
  "keyless_sourcing_enabled": true
}
```

`tier` reports which provider answered: `keyless` (public jlcsearch data, no
credentials) or `authenticated` (Mouser/DigiKey, requires API credentials).
`classification` reports LCSC/JLCPCB assembly status (`basic`, `preferred`, `extended`)
when the source provides it. A part missing from the sourcing array means no configured
supplier had it in stock in the queried tier — the keyless tier only sees each
category's top in-stock snapshot, so a low-stock or obscure part may need an
authenticated supplier or manual lookup. If a part is out of stock, the assistant can
query `lib_recommend_part` or search LCSC using keywords to propose pin-compatible
alternates.

---

## Vendor provenance and failure states

`easyeda_bom_quality_report` now reports vendor status and provenance for each supplier query. A degraded vendor must not crash the report. Instead, the affected supplier returns structured low-confidence data.

Example supplier datum:

```json
{
  "supplier": "mouser",
  "status": "rate_limited",
  "found": false,
  "source": "mouser:search-api",
  "queried_at": "2026-06-11T21:00:01.000Z",
  "cache_age_seconds": 0,
  "from_cache": false,
  "confidence": "low",
  "reason": "rate limit exceeded",
  "status_code": 429
}
```

Use the `status` field to decide whether the report is procurement-ready:

- `found` and `no_match` are normal query outcomes.
- `unauthorized`, `rate_limited`, `timeout`, `invalid_response`, and `unavailable` mean the supplier data is incomplete and should be rechecked before ordering.
- `source`, `queried_at`, `from_cache`, and `cache_age_seconds` provide freshness/provenance for audit trails.

## Component quality and alternates

`easyeda_bom_quality_report` includes `component_quality` per entry. It summarizes lifecycle, stock, manufacturer/source diversity, package suitability, freshness, recommended action and alternate candidates.

Use the top-level summary counters to track stale vendor data, missing vendor data, package mismatch, manufacturer risk, lifecycle risk, and entries without a safe alternate.
