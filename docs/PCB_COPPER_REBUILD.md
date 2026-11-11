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
- A native return naming a different Pour is never trusted alone. It may only be reconciled when independent before/after Poured snapshots prove a newly generated target-linked fill and unchanged existing copper. Otherwise the mismatch fails closed.
- Verified generated copper requires at least one valid `fill=true` polygon. Outline-only (`fill=false`) segments cannot count as a successful rebuild.
- A native `undefined` result is reported as `no-copper`; it is **not** counted as a successful rebuild.
- PCB rebuild writes are not covered by the server transaction manager. If the bridge times out, the native outcome is unknown; inspect the active PCB before retrying.

## Compatibility boundary

The repository's current live desktop compatibility baseline is EasyEDA Pro `3.2.149.88089769`. The rebuild implementation was validated against the `@jlceda/pro-api-types` `0.4.25` instance-rebuild surface and the official EasyEDA API skill/docs. Upstream `0.4.26` retains that instance contract and also declares an `@alpha` class-level `PCB_PrimitivePour.rebuildCopperRegions()` method, but that class-level method is absent from the verified 3.2.149 runtime and is not used by this tool.

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

`easyeda_pcb_add_zone` now supports a **pure local preview** of a rectangular native Pour plan; it never calls the bridge in preview mode. All actual apply requests still fail closed, including `confirmWrite=true`. Preview must specify all nine creation parameters explicitly (net, layer, rectangle polygon, solid fill method, island preservation, name, priority, stroke width and lock state); no runtime net or board information is read or assumed. `requiredApplyChecks` lists unmet live preflight gates. The preview hash is only a deterministic representation of the planned native arguments, not authorization to apply.

An isolated MSI / EasyEDA Pro `3.2.206` positive-path experiment for #480 **did** create a BOTTOM/GND native Pour with `preserveSilos=true`, read 41 associated Poured fills, save, close/reopen, delete, save, close/reopen and restore the exact baseline. However a smaller rectangle failed to produce associated copper, native create accepted a nonexistent net name, and the SDK helper `rebuildCopperRegion()` returned the first available Pour's fill group (`e336`) rather than the target even when a valid target fill existed. Thus this positive-path experiment does not cover general inputs, invalid contexts or timeout recovery. Creation remains fail-closed until strict net membership/board checks, explicit authorization, appropriate version gates, exact-id read-back and deterministic error reconciliation have been implemented and verified. See #480 for detailed live evidence.

An isolated, disposable EasyEDA Pro `3.2.206` test for #480 showed why this guard matters: creating a new Pour returned a new, readable id, but rebuilding it returned **existing** Pour `e336` with 74 fills and produced no associated `PCB_PrimitivePoured` for the new id. The new Pour was deleted and the original Pour/Poured inventory restored. This does not meet the creation, filling, persistence, or rollback acceptance criteria; zone creation remains fail-closed.

The separate zone-preflight diagnostic is read-only and checks the exact
selected PCB document and parent project **both before and after** runtime
inspection, plus net membership, copper layer stackup, supported EasyEDA
3.2.206/3.2.209 versions, and native create/Poured/save API capabilities.
A truthy native PCB handle alone is not trusted as the selected document;
changed focus invalidates earlier net/layer/outline observations.

For a single verified native rectangular outline or a supported simple
closed-polyline outline, the diagnostic distinguishes board intersection
(intersectionVerified) from **strict candidate containment**
(containmentVerified). An overhanging or boundary-touching candidate may
intersect the board but is not fully contained; unsupported contours, arcs,
cutouts, identity drift, and missing outline data fail closed. Geometric
containment is not proof of copper clearance, net connectivity, DRC,
topology, or persisted fill. Even if every currently supported read succeeds,
readyToApply remains **false**, as production mutation, topology and
ambiguous-error rollback gates have not been implemented. The diagnostic is
not an apply authorization.

## New-zone candidate verification (not production apply)

The isolated, test-only `zone-create-evidence` and `zone-create-operation`
modules implement deterministic **pre/post native inventory reconciliation**
for a single candidate Pour. They are intentionally **not connected** to
`pcb.addZone` or `easyeda_pcb_add_zone`; public apply still fails closed.
The candidate verifies exact native source properties, one unique created
source, a matching source-linked truly filled Poured object, unchanged
pre-existing geometry, and exact-source-only rollback eligibility. It
rejects duplicate plans and leaves the same-dispatcher write fence active
after a native error, ambiguous result, or same-session save. A native
`save() === true` and same-session readback are reported as
`saved-readback`, **not** cold-reopen persistence proof. Similarly, an
exact-ID deletion followed by a same-session baseline match is called
`rollback-readback`, not verified durable rollback. Neither status clears
the write fence without independent fresh-session evidence.

Live direct native tests in the separate Ubuntu 24.04, EasyEDA Pro
3.2.209 disposable PCB showed target-associated filled copper can persist
across a full editor restart even when the beta rebuild _return object_
identifies the previous Pour. This does not prove that public MCP apply,
conflicting topology, multiple board geometries, timeout recovery, or
post-write DRC are safe. Issue #480 remains open.
