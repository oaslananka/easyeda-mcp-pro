# Route geometry review — read-only native evidence

`easyeda_pcb_route_geometry_review` is a bounded, read-only PCB **inspection**
tool. It complements, but never replaces, EasyEDA Pro's native DRC, a
fabricator's design rules, or physical current/EMC validation.

## Data contract

- A focused PCB with an exact project UUID is required. The bridge's existing
  project-scoped readers verify focused project/document identity before and
  after each native read. Wrong tab or project identity returns **UNKNOWN**.
- The MCP server reads one window of at most 200 `pcb.listTracks`
  (`PCB_PrimitiveLine`) and 200 `pcb.listVias` (`PCB_PrimitiveVia`) results.
  Source and extension/method-registry mismatches block native reads.
- Read results contain primitive IDs, net names, layer numbers and coordinate
  values in **native PCB mils**. Trace widths are converted to mm using
  `1 mil = 0.0254 mm`. If items are missing, malformed or truncated, the
  corresponding coverage is explicitly unknown.
- Reads are individually identity-protected but **not an atomic board
  snapshot**. An empty collection can also indicate an unsupported native
  primitive getter, so it never proves a clean board.
- If a native track or via collection is **unavailable**, any rows
  supplied alongside that unavailable result are ignored for measured
  warnings and right-angle advisories. Valid measurements from the
  _other_ available collection remain reportable with incomplete
  coverage and never establish a geometry or manufacturing pass.
- Measured track widths, copper overlaps, 90° bends and via-transition candidates
  require native segments with finite bounded coordinates, a positive width,
  a valid layer and an **exact, non-padded net name**. Missing copper
  geometry or ambiguous net identity produces \`UNKNOWN\`, not a geometry
  warning or style advisory. A misleading 90° bend from an invalid-width
  segment is excluded even when its endpoints appear connected.
- Via measurements additionally require an exact native net, finite bounded center
  coordinates, and positive bounded hole/copper diameters. An untrustworthy
  field yields `VIA_GEOMETRY_UNAVAILABLE=UNKNOWN`, not an annular warning;
  it also marks `collection_complete=false` even when the item count matches.
  Physically contradictory but attributable drill/land dimensions still warn.
- Native primitive IDs must be present, unpadded and **unique within
  each track/via inventory**. Duplicated track identities are excluded
  from width, overlap, corner and via-transition attribution; duplicated
  or absent via identities cannot yield an annular-geometry warning.
  Such an inventory sets `collection_complete=false` and reports
  `NATIVE_COLLECTION_INCOMPLETE=UNKNOWN`. Independent primitives
  with unique identities may still report genuine observed warnings.

- `minWidthMm` is a **caller-supplied** constraint, not proof of an active
  DRC or manufacturer minimum. The tool warns on observed segments narrower
  than that input; not observing such a warning is **not** a verified pass.
- `intent=high-speed` permits 90°-bend style advisories when exactly two
  segments with the same net/layer share an endpoint. Intersections without a
  joint, branches/T-junctions and unrelated nets/layers cannot be treated as
  an electrical failure solely due to geometry. The default `general`
  mode does not issue the style advisory.

## Example

```json
{
  "projectId": "your-exact-native-project-uuid",
  "intent": "high-speed",
  "minWidthMm": 0.15
}
```

Findings include stable identifiers, affected primitive IDs, the net/layer
when known, original junction coordinates, and the width/constraint that
triggered the warning. An invalid or physically contradictory via
drill-to-pad diameter may produce a warning. **When an observed same-net via center exactly matches native track
endpoints carrying the same net on **two or more distinct native layer
codes**, the tool emits `VIA_LAYER_TRANSITION_CANDIDATE=UNKNOWN` with
the via/track primitive IDs, net name, center coordinate and raw layer
codes. Missing or duplicate identities, malformed via dimensions and
incomplete segment geometry cannot establish this observation. Raw
layer codes are not treated as verified copper layers, and a coincident
endpoint does not prove a plated via connection, electrical continuity
or an adequate high-frequency return path. No via movement or DRC
execution occurs.

Via current carrying
capacity is not calculated**, because plated barrel thickness, via layer
span, current sharing and heat transfer are unverified.

### Observed track-to-track copper contact

A bounded pairwise check now measures shortest **finite centerline distance**
between valid, same-layer **different-net** native copper line segments,
subtracts half of both observed widths, and emits
`OBSERVED_TRACK_COPPER_OVERLAP=WARNING` only when their projected copper
widths touch or overlap. Findings identify both nets, primitive IDs, native
layer and signed `observed_edge_gap_mm` (a negative value indicates projected
overlap). Parallel, intersecting, and endpoint-to-endpoint cases are included;
same-net joins and different-layer crossings are excluded.

This is a **2D geometry warning**, not an assertion that the actual fabricated
board shorts: native line collections may not include every object and do not
prove finished copper topology. Pads, polygons, keepouts, board stackup and all
remaining clearances continue to report `COPPER_CLEARANCE_UNVERIFIED=UNKNOWN`.
An empty or disconnected native getter never supplies overlap evidence.
Run native DRC and verify the relevant manufacturer rules separately.

## Optional current / observed net-width review

The same tool accepts an opt-in `traceCurrent` declaration. It uses the
existing read-only `pcb.listTracks` result to find the **narrowest observed
primitive line segment** on the exact specified net, converts mils to mm,
and compares that measurement to an empirical IPC-2221 reference calculated
from the supplied load current, allowable temperature rise, copper weight
and declared internal/external layer class. No new native calls or writes
are introduced.

```json
{
  "projectId": "your-exact-native-project-uuid",
  "traceCurrent": {
    "net": "VCC",
    "currentA": 1,
    "temperatureRiseC": 10,
    "layer": "external",
    "copperWeightOz": 1,
    "manufacturerMinWidthMm": 0.15,
    "environment": "still-air"
  }
}
```

This is a **caller-declared scenario**, not a recommended design limit.
The `trace_current_review` reports `observed_narrowest_segment_width_mm`,
primitive IDs, editor/extension source versions and a model-reference width.
It emits `WARNING` only for a real observed narrower segment relative to
the stated empirical or manufacturer reference. **Even if the observed
width is larger, result remains `UNKNOWN`**, never a current-carrying PASS.

Native trace-width measurements require exact nonblank net/primitive IDs,
globally unique primitive IDs across the entire returned track collection,
bounded finite coordinates and positive bounded native segment widths. This
prevents attributing the same native track to two nets or treating malformed
net labels as measured copper. An invalid (nonpositive or nonfinite)
caller-declared manufacturer minimum is explicitly reported as
\`FABRICATION_DECLARATION_INVALID=UNKNOWN\`, not silently treated as a
verified process limit.

The comparison fails closed if the active project/focus/native reader fails,
if the read is truncated or malformed, if the named net is absent, or if
source versions are unavailable. The returned width is **not** an observed
whole-current-path minimum: native layer codes do not establish the
caller-declared copper stackup, and vias, fills, parallel conductors,
plating and thermal/environmental effects remain unverified.
The separate source-agnostic `easyeda_design_rules_lookup` calculation
remains backward-compatible and only interprets caller-supplied values.
Use disposable-board exact-source live acceptance before claiming this
optional native result compatible with a given EasyEDA runtime.

## Incomplete evidence

The result always discloses these unverified dimensions:

- Copper **pour/fill/plane electrical connectivity** and high-frequency
  return-current continuity: **UNKNOWN**. A visible primitive Fill/Region
  is not a guaranteed copper plane or electrically connected poured zone.
  The separately tracked [copper-zone issue #480](https://github.com/oaslananka/easyeda-mcp-pro/issues/480)
  is not bypassed or reimplemented here.
- Native per-net **clearance/keepout DRC**: **UNKNOWN**. This read-only tool
  intentionally does not execute DRC or mutate EasyEDA editor state.
- Via barrel/electrical current, trace thermal adequacy and manufacturing
  approval: **UNKNOWN** absent separately verified evidence.
- More than 200 tracks or vias: **incomplete review**, not a whole-board
  pass. Large result sets remain bounded, with coverage counts and
  mandatory uncertainty findings preserved even when warnings are numerous.

The tool returns only `WARNING`, `ADVISORY` and `UNKNOWN` findings, never
an electrical/fabrication `PASS` or engineering sign-off.

## Live acceptance still required

Run exact-source, actual EasyEDA Pro inspection only on a **disposable PCB**,
recording source commit, editor and extension versions, extension SHA-256,
read-back/no-write proof and supported native primitive shapes. For the
general acceptance procedure, see
[engineering review live acceptance](./development/engineering-review-live-acceptance.md).
Mock tests demonstrate software contracts, not live runtime compatibility
or physical/electrical correctness.

## Differential pair review (explicit opt-in)

The **same** read-only tool supports an optional `differentialPair` declaration.
It does not guess which nets form a pair, or apply a universal impedance,
spacing or length-matching threshold. State both exact native net names, one
protocol reference, and **only** limits justified by the target device
datasheet or actual PCB manufacturer.

```json
{
  "projectId": "your-exact-native-project-uuid",
  "intent": "high-speed",
  "differentialPair": {
    "positiveNet": "USB_D+",
    "negativeNet": "USB_D-",
    "protocol": "usb2",
    "maxSkewMm": 0.6,
    "minEdgeGapMm": 0.15,
    "maxEdgeGapMm": 0.35,
    "targetImpedanceOhms": 90,
    "constraintSource": "Illustrative only: verify against the target device datasheet revision"
  }
}
```

The optional `constraintSource` records the **caller-supplied** datasheet,
manufacturer document or design revision that motivated the numeric bounds.
The output `constraint_source` is `null` when omitted; protocol guidance
references are kept separate and cannot stand in for a device-specific
limit source. The source string itself is never independently verified.

This is an **example with hypothetical, caller-declared limits**, not a
manufacturer recommendation. The source of each limit must be established
separately. For LVDS and other device-specific interfaces use
`protocol: "custom"`, an explicit device-defined target and no assumed
universal threshold. Protocol references originate from the canonical
`src/design-rules/protocol-routing.ts` catalog, shared with
`easyeda_design_rules_lookup`; the model does not recreate the standard.

Both declared pair net names must be **distinct, exact, nonblank identities**.
A missing, padded or identical pair name leaves skew and spacing **UNKNOWN**,
rather than comparing the same copper path against itself. Caller-declared
skew/spacing limits must be finite and nonnegative; an inverted spacing
interval cannot establish a within-limit reference.

Differential-pair measurements require exact, nonblank native primitive IDs
that remain unique across the **entire observed track inventory**, and
unique IDs across observed vias. A repeated or padded identity produces
ambiguous source evidence, with skew/spacing **UNKNOWN** even if two
displayed net rows appear plausible. Native segment nets must be exact,
copper widths positive and bounded, and all coordinates finite within
the supported native range; malformed observations cannot establish a
length or within-limit spacing verdict. Neither this check nor the
native reader verifies a physical pad, electrical return path or full
device-to-connector signal route.

The optional `differential_pair` result reports both native net identities,
observed segment counts/primitive IDs, physical length in **mm**, and
the observed length difference. A bounded `OBSERVED_SINGLE_CHAIN` means
only that the **visible track primitives** form one unbranched single-layer
chain without a reported same-net via; it is _not_ a verified PHY-to-connector
signal path. Missing nets, disjoint/branched paths, unsupported geometry,
same-net via transitions, incomplete native reads and version mismatches
produce `MISSING`/`AMBIGUOUS`/`UNAVAILABLE` with **UNKNOWN** skew.

A supplied `maxSkewMm` is compared only when both chains are available.
`WITHIN_DECLARED_LIMIT_REFERENCE` means an observed line-segment comparison
meets the _supplied_ limit; it never means verified end-to-end performance.
`WARNING` denotes an observed threshold exceedance or missing declared
net in a complete read. Without a caller-supplied bound, the tool reports
the length delta without an electrical pass/fail decision.

For **parallel, overlapping, same-layer** trace segments, the tool samples
edge-to-edge copper separation (native centerline spacing minus half of
both line widths). Only those parallel samples can support a
`WITHIN_DECLARED_LIMIT_REFERENCE` comparison against the supplied
`minEdgeGapMm`/`maxEdgeGapMm` bounds. Perpendicular or nonoverlapping
paths cannot establish a **passing** differential spacing comparison.
Independently, a nonpositive 2D projected copper gap between any two
same-layer, different-net native trace segments (including perpendicular
crossings and near endpoint contacts) produces `WARNING` even with no
numerical spacing limit. The result exposes `observed_contact_count`
and a measured minimum projected edge gap in mm where observable;
`sample_count` still counts only the parallel-gap samples. No contact
warning establishes a verified fabricated-board short, pad/pour topology,
complete coupling, or spacing continuity. Missing native evidence remains
`UNKNOWN`; actual native DRC and fabricator clearance review are still
required.

**Impedance is always UNKNOWN** unless a separate, source-bound dielectric,
finished-copper and stackup model with justified field-solver/manufacturer
evidence is supplied by a future validated capability. A referenced
USB/Ethernet/RS-485 nominal impedance or a caller target is _not_ calculated
impedance. Reference-plane continuity, copper zones, launch/connector
transitions, propagation-delay skew and SI/EMC compliance remain unverified.
The tool does not execute DRC or mutate the EasyEDA PCB.

### Source-bound acceptance cases

Use a disposable, exact-version EasyEDA Pro PCB with clearly declared net
pairs to verify: a complete geometric pair within a _declared_ skew/spacing
bound; a known skew exceedance; a deliberately tight/wide parallel gap;
one absent native net; branched/disconnected routing; via/layer transition;
missing stackup and unsupported pours. Record the source revision, extension
checksum, actual editor version, native project identity and no-write
read-back as described in the general live acceptance checklist. Until
then, the deterministic tests demonstrate software behavior only.

## Component-origin placement relationships (optional)

Native component enumeration must contain unique, exact, nonblank primitive IDs
**and designators across the entire bounded inventory**, including parts not
named in a requested relation. Missing/padded/reused designators make
'collection_complete=false' and leave placement distances **UNKNOWN**;
a selected pair cannot be attributed safely from an ambiguous component
inventory. This does not verify physical pads or component packages.

The same read-only MCP tool supports up to eight `placementRelations` in a
single request, using the existing `pcb.listComponents` native reader. It
enumerates **at most 200** focused-PCB components and records native
designator, primitive ID, X/Y origin, rotation and layer. This is a component
**origin-to-origin** measurement in PCB mils, converted to millimetres.
It is **not** a pad-to-pad distance, electrical net path, via current,
copper geometry or closed high-frequency loop measurement.

```json
{
  "projectId": "your-exact-native-project-uuid",
  "placementRelations": [
    {
      "first": "U1",
      "second": "C1",
      "kind": "decoupling",
      "maxCenterDistanceMm": 2.0,
      "constraintSource": "Example only: verify against the device's actual layout datasheet"
    },
    {
      "first": "J1",
      "second": "D1",
      "kind": "esd-entry"
    }
  ]
}
```

The numeric limit above is **illustrative and not a universal bypass-cap
requirement**. No arbitrary component-origin distance or fixed rotation
becomes a hard electrical rule by default. To compare an origin distance,
same-native-layer expectation, or exact first-component rotation, an
explicit caller-provided `constraintSource` is required; it remains
**caller-declared/unverified**, not an automatically checked datasheet.

Supported relation contexts: `decoupling`, `switching-loop`, `crystal`,
`esd-entry`, `feedback`, and `sensitive-adjacency`. Rotation comparison
supports `firstRotationDeg` and `rotationToleranceDeg` with wraparound. It also supports `secondRotationDeg` and `secondRotationToleranceDeg` to check the second footprint independently; both comparisons use observed native rotation and caller-supplied tolerances, never inferred ESD, crystal, or power-loop compliance. If a required rotation is missing, the relationship remains `UNKNOWN` unless another independent declared limit already produces a `WARNING`. Duplicate native primitive identity across two named components is invalid evidence, not proof of their separation.
The optional `firstFootprintName` and `secondFootprintName` fields
compare **exact native PCB footprint names** against an explicitly
declared, sourced expectation. A mismatch is a `WARNING`; a matching
name remains `UNKNOWN` because this is not a physical package,
pad/pinout, library-revision or assembly side/orientation
certification. Absent or malformed native footprint names are
`UNKNOWN`, not invented mismatches or passes. The existing
`pcb.listComponents` read is reused without a new bridge capability
or design write.

`requireSameLayer` compares **native layer numbers only**; the tool does
not assume undocumented native layer codes prove top/bottom assembly side.

Each result includes implicated designators and native primitive IDs,
observed centre distance in mm, native layers/rotation when available,
the caller-supplied limit and constraint source, and relevant reasons.
If the observed origin distance exceeds the _supplied_ limit, or an
explicitly required layer/angle mismatches, the result is `WARNING`.
Even when the observed geometry meets an explicit constraint, the
relationship and `electrical_loop_status` remain **UNKNOWN** because
the component origin is not the relevant supply pad, connector pin,
crystal pin or ESD current path.

An absent, duplicated or malformed designator, unsupported/empty native
getter, wrong focused PCB, extension-version mismatch or truncated
collection fails closed to **UNKNOWN**, not `PASS` or a verified missing
component. Native `getAll()` enumeration is bounded, and separate
primitive reads are **not an atomic PCB snapshot**.

A verified power/buck loop needs actual pad coordinates, pad-net
connections, copper/return plane continuity and relevant device-layout
requirements; those data are **not exposed** by the current
`pcb.listComponents` read contract.

A bounded [read-only EasyEDA Web 3.2.209 beta pad experiment](./evidence/easyeda-live/2026-11-04-ubuntu-24-04-easyeda-3.2.209-v1.9.0-pcb-842-beta-pad.json)
confirmed that `PCB_PrimitivePad.getAll` and
`PCB_PrimitiveComponent.getAllPinsByPrimitiveId` return six source-matched
pad identities, parent footprint references, pad/net labels and finite
coordinates in **one disposable LED PCB**. Two consecutive global reads
agreed and the pad net labels matched the disposable schematic.
These native APIs are **beta and not recommended for production** by
EasyEDA's documentation, so the observation is research evidence only:
**no production pad reader, power-loop check or electrical approval** was
added. The observed raw native layer codes `1` and `12` are not
interpreted as physical copper-layer indices or board sides. Native
coordinate units/transforms, copper continuity and return paths remain
unverified. This bounded inspection does not
claim EMI immunity, SI correctness, safety compliance, autorouting
or a manufacturing approval. Exact-source live acceptance on a
disposable EasyEDA PCB remains a separate required milestone.
