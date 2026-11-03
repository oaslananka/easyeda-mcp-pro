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
drill-to-pad diameter may produce a warning. **Via current carrying
capacity is not calculated**, because plated barrel thickness, via layer
span, current sharing and heat transfer are unverified.

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
