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
  "total": 3,
  "parts": [
    { "ref": "U1", "val": "ESP32-WROOM-32E", "lcsc": "C701342" },
    { "ref": "C1", "val": "10uF", "lcsc": "C19702" },
    { "ref": "R1", "val": "10k", "lcsc": "C25804" }
  ]
}
```

---

### 2. Validate BOM Against LCSC Inventory

Check if the LCSC parts specified in your design are active, in stock, or obsolete:

**MCP Call**:
`easyeda_bom_validate` with the generated parts list.

**Validation Response**:

```json
{
  "isValid": true,
  "obsoleteParts": [],
  "lowStockParts": [
    {
      "lcsc": "C701342",
      "stock": 12,
      "message": "Low stock warning: only 12 units available at LCSC."
    }
  ]
}
```

---

### 3. Query Real-Time Pricing and Sourcing

Fetch current pricing tiers for assembly budgeting:

**MCP Call**:
`easyeda_bom_sourcing` with LCSC part numbers.

**Sourcing Output**:

```json
{
  "parts": {
    "C19702": {
      "stock": 45000,
      "priceTiers": [
        { "minQty": 10, "price": 0.012 },
        { "minQty": 100, "price": 0.008 }
      ],
      "status": "active"
    }
  }
}
```

If a part is out of stock, the assistant can query `lib_recommend_part` or search LCSC using keywords to propose pin-compatible alternates.

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
