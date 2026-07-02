# Component Quality and Substitution Intelligence

BOM quality reports include a component-level quality assessment for lifecycle, stock, manufacturer/source diversity, package suitability, data freshness, and alternate candidates.

## Tool

```text
easyeda_bom_quality_report
```

The report now includes:

```text
component_quality.score
component_quality.risk
component_quality.dimensions
component_quality.alternates
component_quality.recommended_action
component_quality.provenance
```

## Score dimensions

| Dimension      | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `lifecycle`    | Active, unknown, discontinued, or missing supplier lifecycle evidence                 |
| `stock`        | Available stock compared with BOM quantity and low-stock threshold                    |
| `manufacturer` | Manufacturer metadata and source diversity                                            |
| `package`      | Footprint/package compatibility using BOM footprint and supplier description evidence |
| `freshness`    | Cache age and supplier response freshness                                             |

Risk levels:

```text
low
medium
high
critical
```

Recommended actions:

```text
accept
review
replace
insufficient_data
```

## Alternate candidate classification

Alternates are classified as:

| Compatibility     | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `drop_in`         | Lifecycle, stock and package evidence look compatible          |
| `review_required` | Candidate may be usable but needs datasheet or sourcing review |
| `unsafe`          | Candidate should not be used as a direct substitute            |

Each alternate includes:

```text
supplier
mpn
lcsc
manufacturer
description
lifecycle
stock
unit_price
currency
compatibility
score
reasons
caveats
```

Caveats explain why a candidate is not a drop-in substitute, for example stale supplier data, unknown lifecycle, missing manufacturer metadata, low stock, or package mismatch.

## New issue types

```text
stale_vendor_data
missing_vendor_data
package_mismatch
manufacturer_risk
lifecycle_risk
no_safe_alternate
```

These issue types appear alongside existing BOM quality findings such as `low_stock`, `single_source`, `missing_mpn`, `missing_footprint`, `unavailable`, and supplier error statuses.

## Example output

```json
{
  "reference": "R10",
  "component_quality": {
    "score": 92,
    "risk": "low",
    "recommended_action": "accept",
    "dimensions": {
      "lifecycle": {
        "score": 100,
        "risk": "low",
        "reason": "Found supplier records indicate active lifecycle."
      },
      "stock": {
        "score": 100,
        "risk": "low",
        "reason": "Supplier stock is above the configured threshold."
      },
      "manufacturer": {
        "score": 70,
        "risk": "medium",
        "reason": "Part has limited manufacturer/source diversity."
      },
      "package": {
        "score": 100,
        "risk": "low",
        "reason": "Package metadata is present and compatible."
      },
      "freshness": {
        "score": 100,
        "risk": "low",
        "reason": "Supplier data freshness is within threshold."
      }
    },
    "alternates": [
      {
        "supplier": "lcsc",
        "lcsc": "C12345",
        "mpn": "RC0805FR-0710KL",
        "manufacturer": "Yageo",
        "compatibility": "drop_in",
        "score": 100,
        "reasons": [
          "Lifecycle is active.",
          "Supplier stock is available.",
          "Package appears compatible with the requested footprint."
        ],
        "caveats": []
      }
    ]
  }
}
```

## Configuration

`easyeda_bom_quality_report` accepts:

```text
low_stock_threshold
require_mpn
require_footprint
stale_vendor_data_seconds
minimum_quality_score
```

Use a lower `stale_vendor_data_seconds` threshold for release-critical sourcing reviews. Use a higher `minimum_quality_score` when alternates must be reviewed before procurement.
