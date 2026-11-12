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

`easyeda_pcb_add_zone` now supports a **pure local preview** of a rectangular native Pour plan; it never calls the bridge in preview mode. All actual apply requests still fail closed, including `confirmWrite=true`. Preview must specify all nine creation parameters explicitly (net, layer, rectangle polygon, solid fill method, island preservation, name, priority, stroke width and lock state); no runtime net or board information is read or assumed. `requiredApplyChecks` lists unmet live preflight gates. The preview hash is only a deterministic representation of the planned native arguments, not authorization to apply. The upstream [`PCB_PrimitivePour.create()` contract](https://prodocs.easyeda.com/en/api/reference/pro-api.pcb_primitivepour.create.html) is marked **BETA** with an explicit prohibition on production use. Even a successful isolated Z480 creation/reopen/rollback does not supersede that vendor restriction. The supported fallback is manual EasyEDA Pro editing: **Place > Copper Pour Area**, select the intended net and copper layer, rebuild the fill, inspect DRC, and save. MCP native zone apply remains unavailable.

An isolated MSI / EasyEDA Pro `3.2.206` positive-path experiment for #480 **did** create a BOTTOM/GND native Pour with `preserveSilos=true`, read 41 associated Poured fills, save, close/reopen, delete, save, close/reopen and restore the exact baseline. However a smaller rectangle failed to produce associated copper, native create accepted a nonexistent net name, and the SDK helper `rebuildCopperRegion()` returned the first available Pour's fill group (`e336`) rather than the target even when a valid target fill existed. Thus this positive-path experiment does not cover general inputs, invalid contexts or timeout recovery. Creation remains fail-closed until strict net membership/board checks, explicit authorization, appropriate version gates, exact-id read-back and deterministic error reconciliation have been implemented and verified. See #480 for detailed live evidence.

An isolated, disposable EasyEDA Pro `3.2.206` test for #480 showed why this guard matters: creating a new Pour returned a new, readable id, but rebuilding it returned **existing** Pour `e336` with 74 fills and produced no associated `PCB_PrimitivePoured` for the new id. The new Pour was deleted and the original Pour/Poured inventory restored. This does not meet the creation, filling, persistence, or rollback acceptance criteria; zone creation remains fail-closed.

The separate zone-preflight diagnostic is read-only and checks the exact
selected PCB document and parent project **both before and after** runtime
inspection, plus net membership, copper layer stackup, the measured EasyEDA
Pro 3.2.209 native-create version, and native create/Poured/save API capabilities.
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

## One-step preview with optional live prerequisites (no write)

`easyeda_pcb_add_zone` in `mode: "preview"` remains deterministic and
non-mutating. Supplying `inspectLive: true` additionally invokes the existing
**read-only** `pcb.zonePreflight` bridge diagnostic with the exact preview
net, layer and native rectangle. The response contains `liveReadiness`:
focus/net/layer/strict board containment evidence, runtime version, and
explicit blockers. It never creates a Pour, triggers a rebuild, saves,
confirms a write, or enables the public apply path. Without
`inspectLive: true`, preview requires no bridge connection and behaves
as before. Failed, disconnected or malformed live diagnostics yield
`checked: false`, not a fabricated successful preflight.

`preview.nativeProfile` separately identifies the **only measured
disposable-native settings combination** (EasyEDA Pro 3.2.209, GND,
BOTTOM layer 2, solid, preserveSilos=true, priority=1, width=0.2,
unlocked). Other combinations are presented as unverified rather than
quietly accepted. That match is evidence from one temporary PCB, not a
guarantee on arbitrary designs. Even a complete live diagnostic returns
`readyToApply: false` until electrical topology/DRC, remote approval,
durable write recovery and full public MCP acceptance are established.

## Write-ahead quarantine across adapter reconstruction (test-only)

The guarded native-zone candidate **requires** a write-ahead reservation
before any native creation call. The repository-owned, test-only adapter now
obtains a native extension-scoped store through EasyEDA Pro `SYS_Storage`:
`getExtensionUserConfig(key)` is a synchronous lookup, while
`setExtensionUserConfig(key, value)` is an asynchronous operation that must
resolve exactly `true`. The adapter re-reads the stored marker before any
`PCB_PrimitivePour.create()`; unavailable, malformed, false-returning,
unreadable or unwritable persistence blocks creation, never falls back to
browser `localStorage`. Its `reconciliation-required` marker survives
reconstructed adapters sharing the same native extension store and prevents
retries even after same-session save or source rollback.

The candidate engine serializes marker read+write+readback only through an
**explicitly injected single-writer reservation coordinator**. It no longer
implicitly calls `navigator.locks`: the EasyEDA extension's restricted
main-script runtime does not guarantee any standard browser globals.
A missing/denied coordinator blocks `PCB_PrimitivePour.create()` before
writing even the pending marker. A coordinator returning `true` without
actually running the protected marker write/readback callback is also refused;
that boolean alone does not constitute an acquired lease. The standalone `createBrowserZoneFenceLock`
helper is supported only for _actual browser contexts that expose the Web
Locks API_; it is **not** selected by default in the native adapter.
Until a durable, multi-session and cross-process coordinator is implemented
and proven, this **test-only candidate cannot be activated**.

A read-only capability probe in the isolated EasyEDA Pro 3.2.209 **host
page** observed `navigator.locks` and a `SYS_Storage` getter method, but
the getter threw a `TypeError` when called outside an extension runtime.
The official API explicitly documents that extension configuration access
throws in standalone scripting. Host-page visibility is **not** a proof
of availability inside the extension's own restricted runtime.

The pending marker now stores a **versioned full pre-write native
Pour/Poured inventory** (primitive identities, requested source properties,
and validated filled-copper signatures) together with the exact focused PCB
and requested zone plan. The serializer checks map-key/source-ID integrity,
orders sources deterministically, and refuses unsupported/malformed snapshots
or records larger than 256,000 characters **before** any native mutation.
The existing storage key is retained so legacy v1 markers cannot accidentally
be bypassed by a renamed key; those older records lack recoverable baseline
evidence and remain blocked.

`assessZoneRecoveryCandidate()` provides a **read-only** interpretation
of a subsequently observed inventory: `candidate-unchanged`,
`candidate-created` (one exact matching filled Poured), or `unresolved`.
It rejects changed existing copper, incorrect focus, duplicates, missing
filled copper, tampered snapshots, and legacy markers. Every verdict
explicitly returns `persistenceVerified: false` and
`releaseAuthorized: false`: this classifier neither proves a cold
editor restart happened nor deletes a marker or authorizes a retry.
A separate independently witnessed cold reopen and durable, audited
recovery protocol are still mandatory.

In one **read-only** inspection of the isolated 3.2.209 test PCB,
the original single Pour/Poured inventory encoded to a 32,813-character
marker, within this cap. This was only a capacity/readback probe:
no extension configuration or PCB was modified.

**No auto-clear, timeout-based expiry or manual reset API is provided.**
Removing the marker requires a separately designed and verified cold-reopen
reconciliation/restore contract. The key is intentionally global to the
extension origin (one unresolved copper write blocks all further candidate
writes), rather than assuming it is safe to continue on another PCB.

The existing read-only `easyeda_bridge_status` MCP tool now carries
`native_zone_safety` when the connected extension supports it. It reports
whether the extension-scoped storage getter was actually readable,
whether a pending write fence is absent/present/unknown, and the unchanged
`coordinator: unavailable`, `coldReopenVerified: false` and
`publicApplyEnabled: false` gates. It never returns stored fence contents
or calls native storage setters. A missing result from an older extension
means **unverified**, not safe-to-write. This lets actual extension runtime
tests distinguish an unavailable native storage API from a verified empty
pending key, without implying public zone-writing support.

**The candidate is still not installed in a production dispatcher.**
Even a working Web Lock applies only to contexts on the _same browser origin_.
An integration with the existing bridge session/relay must prove exclusive
reservation across native extension instances, separate browser
profiles/processes and reconnects before this path can be enabled.
`SessionDispatchQueue` currently serializes by **session ID**, not by
shared PCB identity, so reusing that queue alone would not prove
cross-session exclusivity. No lease provider has been installed by this PR.
Tests establish only injected mock-native persistence and serialization, not
live persistence, multi-profile coordination or cold browser recovery. The new adapter's real mutating acceptance was previously
blocked before write; no alternate mutating path is attempted here. Public
`easyeda_pcb_add_zone` apply and `pcb.addZone` stay fail-closed.

Official platform contracts:

- [SYS_Storage.getExtensionUserConfig](https://prodocs.easyeda.com/en/api/reference/pro-api.sys_storage.getextensionuserconfig.html)
- [SYS_Storage.setExtensionUserConfig](https://prodocs.easyeda.com/en/api/reference/pro-api.sys_storage.setextensionuserconfig.html)
- [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)

## New-zone candidate verification (not production apply)

The separate test-only `zone-native-api-adapter` now connects the candidate
engine to the **documented native method shapes** for version, project/PCB
identity, net/layer and full board-outline containment before mutation.
Its create/rebuild/save/exact-id delete delegates are covered by deterministic
native API mock contracts and still distinguish same-session saved-readback
from cold-reopen persisted evidence. An active PCB focus change is rejected
immediately before native rebuild, save and after exact-id rollback deletion,
not only before initial create. **The adapter is not wired into the bridge
dispatcher or public MCP apply route.** The earlier isolated native
3.2.209 acceptance used a locally constructed candidate dependency wiring;
the new repository-owned adapter has **not** yet passed live mutating
acceptance and must not inherit that claim. Live mutation execution for this
adapter was blocked by the execution environment before any write, so its
live acceptance is explicitly still pending. The disposable PCB and its
separate schematic were unchanged; no fallback execution was attempted.

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

A second real isolated 3.2.209 candidate-engine test identified a native
normalization hazard: explicitly requesting priority `5` and line width `10`
returned a new Pour with priority `1` and line width `0.2`. The candidate
correctly refused to claim success, did not rebuild/save, and blocked retries.
After full editor shutdown, an independently consistent pre-test SQLite backup
was restored, and native reopen confirmed original source/Poured `e336` with
74 fills. A follow-up request with native-measured priority `1`, line width
`0.2`, `solid`, `preserveSilos=true`, unlocked `GND` / BOTTOM (layer `2`)
produced a new matching source and one valid filled Poured object. Native
`save()` returned true; a completely new editor session retained the exact
source/Poured id and fill-signature SHA-256
`5aba6844f3ca27b9b66dd0a504b058382373afbbeca7e9be22041d5d4151cc87`.
The on-disk saved SQLite file matched its pre-close fingerprint. The test
then restored the consistent original snapshot; native reopen again confirmed
`e336`/74 only, byte-exact restored SQLite, and an unchanged separate
schematic project. Unverified native values and TOP/non-GND creation are now
blocked by the **test-only candidate before any write**.

Live direct native tests in the separate Ubuntu 24.04, EasyEDA Pro
3.2.209 disposable PCB showed target-associated filled copper can persist
across a full editor restart even when the beta rebuild _return object_
identifies the previous Pour. This does not prove that public MCP apply,
conflicting topology, multiple board geometries, timeout recovery, or
post-write DRC are safe. Issue #480 remains open.
