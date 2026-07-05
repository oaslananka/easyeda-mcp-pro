# Verified Device Catalog: Ingestion Scope and Limits

`easyeda_catalog_verify_device` resolves an LCSC part number into a catalog device
entry (`src/catalog/schema.ts`) and caches it locally (`easyeda_catalog_list` reads
that cache back). This page states plainly what it can and cannot verify, because the
name "verify" is easy to over-read.

## What this pipeline actually does

It combines two independent, best-effort sources:

1. **The keyless LCSC tier** (`src/vendors/lcsc/client.ts`) — manufacturer/MPN string,
   package description, stock, price, and basic/preferred/extended classification.
   This is commodity metadata only.
2. **`library.getDeviceByLcscId`**, a bridge method backed by EasyEDA Pro's real,
   typed (`@beta`) `LIB_Device.getByLcscIds` API — a _reference_ (name + UUID) to a
   symbol and footprint, but only when the part is already known to the **connected
   EasyEDA Pro instance's own library**. This method is also documented as unavailable
   in private-deployment environments.

## What it cannot do, and why

**There is no available API — keyless LCSC or EasyEDA Pro's documented surface — that
returns real pin/pad geometry for an arbitrary LCSC part number.** Concretely:

- jlcsearch (the keyless tier) never returns pin lists, pad counts, or a parsed
  datasheet — its `package` field is a free-text description like `"0603"` or
  `"QFN-28"`, not a footprint definition.
- `LIB_Device.getByLcscIds` returns library UUID _references_ to a symbol/footprint —
  not their drawn content. Neither `LIB_Symbol` nor `LIB_Footprint` in EasyEDA Pro's
  API exposes a read method for the underlying drawing; the only related methods are
  `updateDocumentSource` (write-only) and `getRenderImage` (a bitmap image, not
  structured geometry).
- `courtyard` is not a modeled concept anywhere in EasyEDA Pro's typed API.

So this pipeline **cannot** and does not attempt to:

- Fetch or verify pad geometry, pad count, or pin-to-pad correspondence.
- Check for courtyard presence or footprint/pin-map consistency.
- Ingest a symbol/footprint for a part that is not already in the connected EasyEDA
  Pro instance's library — it can only find a _reference_ to one that already exists.

If a future data source changes this (e.g. an official LCSC symbol/footprint export
API, or a datasheet-parsing pipeline), these gates should be added to
`src/catalog/validation.ts` rather than assumed here.

## Status vocabulary

`easyeda_catalog_verify_device` reports one of three statuses:

| Status       | Meaning                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolved`   | A real EasyEDA library match was found and the entry passes catalog validation.                                                                                                                                 |
| `partial`    | A real EasyEDA library match was found, but validation still fails (e.g. no pin map, see above).                                                                                                                |
| `unresolved` | No EasyEDA library match was found; `symbolRef`/`footprintRef` are placeholder markers (`UNRESOLVED:<lcsc-id>`), which validation always flags as an error for categories that require a real symbol/footprint. |

A `resolved` status means the symbol/footprint reference and commodity metadata were
found and the entry is internally consistent — **not** that the pin mapping or
footprint is complete or manufacturable. Treat every ingested device as a starting
point for human review, the same way `docs/vendor-terms.md` treats all supplier data
as advisory.

## Storage

Verified devices are cached in the local SQLite database (`verified_devices` table,
`src/storage/database.ts`) under the user's own `SQLITE_PATH` — never committed to the
repository or redistributed, consistent with `docs/vendor-terms.md` rule 4.

## Using resolved devices in circuit planning

`src/circuit/component-planning.ts`'s `planComponents()` accepts an optional
pre-loaded catalog (`{ catalog: DeviceEntry[] }`) and will fill in
`mpn`/`manufacturer`/`package`/`lcsc` for a high-confidence component role when a
matching, non-obsolete catalog device exists, setting `planningState` to `resolved`
instead of `candidate`. This is opt-in and additive — omitting the option preserves
the original role/refdes/package-hint-only behavior. When no match exists, the plan
result includes a warning suggesting `easyeda_catalog_verify_device` for a candidate
LCSC part number.
