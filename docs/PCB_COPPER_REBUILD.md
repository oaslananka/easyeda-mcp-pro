# PCB Copper Rebuild

`easyeda_pcb_rebuild_copper` rebuilds **existing** EasyEDA Pro copper pours after routing or via changes. It does not create a new pour and does not implement negative inner-layer `PlaneZone` objects.

## Safety contract

- Profile: `full`
- Risk: `high`
- `confirmWrite: true` is mandatory.
- Optional selectors are `pourIds`, exact `net`, and copper `layer` (TOP `1`, BOTTOM `2`, INNER_1..INNER_30 `15..44`).
- Every explicit `pourIds` target is resolved before the first mutation. If any requested id is missing, the operation fails before rebuilding anything.
- The extension calls the documented instance method `IPCB_PrimitivePour.rebuildCopperRegion()`.
- Success is accepted only after `PCB_PrimitivePoured.getAll()` read-back links exactly one derived primitive to the source pour through `getState_PourPrimitiveId()`.
- A native `undefined` result is reported as `no-copper`; it is **not** counted as a successful rebuild.
- PCB rebuild writes are not covered by the server transaction manager. If the bridge times out, the native outcome is unknown; inspect the active PCB before retrying.

## Compatibility boundary

The repository's current live desktop compatibility baseline is EasyEDA Pro `3.2.149.88089769`. The rebuild implementation is contract-backed by the current `@jlceda/pro-api-types` `0.4.25` surface and the official EasyEDA API skill/docs, but this new mutation path is **not newly live-validated by this change**.

At runtime the tool fails closed unless the focused PCB exposes all of these capabilities:

- `PCB_PrimitivePour.get()`
- `PCB_PrimitivePour.getAll()`
- `IPCB_PrimitivePour.rebuildCopperRegion()`
- `PCB_PrimitivePoured.getAll()`
- `IPCB_PrimitivePoured.getState_PourPrimitiveId()`
- `IPCB_PrimitivePoured.getState_PrimitiveId()`

Other EasyEDA Pro versions are therefore capability-gated rather than assumed compatible.

## Plane-zone boundary

This tool intentionally excludes EasyEDA inner `PlaneZone` objects. The verified public API surface exposes normal `PCB_PrimitivePour` rebuilds but no equivalent writable PlaneZone class contract. Plane-zone creation/rebuild remains tracked separately by issue #480 and the [upstream EasyEDA API request #43](https://github.com/easyeda/pro-api-sdk/issues/43) referenced from issue #596.

Do not substitute `easyeda_pcb_add_zone`: native `PCB_PrimitivePour.create()` remains fail-closed in this repository until its complete creation contract is live-verified.
