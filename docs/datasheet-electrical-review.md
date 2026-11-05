# Source-declared electrical and datasheet review

The existing read-only `easyeda_semantic_erc_validate` MCP tool accepts an
optional `datasheetConstraints` array of up to 24 exact-part constraints.
This is **not** a datasheet fetcher or a complete design approval. It reuses
the existing netlist and semantic ERC model without running native editor
mutations, changing power-tree formulas, or adding an MCP tool.

## Evidence contract

Each constraint must include the **exact reference designator**, exact pin
number/identity where applicable, and a source claim with `partNumber`,
`package`, `revision`, `source` and `section`. These fields are provided by
the caller and **not independently authenticated** by this tool. The source
must refer to the actual manufactured component and package; a guessed pin
function, a generic application note or a different datasheet revision is not
proof of device-specific limits.

For example, the following is **hypothetical** and is not a real part's
datasheet specification:

```json
{
  "projectId": "your-project",
  "nets": [
    {
      "id": "supply-rail",
      "name": "5V",
      "type": "power",
      "voltage": 5,
      "nodes": [{ "deviceRef": "U1", "pin": "VDD" }]
    }
  ],
  "devices": [
    {
      "id": "U1",
      "ref": "U1",
      "pins": [{ "pin": "VDD", "electricalType": "power_input" }]
    }
  ],
  "datasheetConstraints": [
    {
      "kind": "pin_voltage",
      "componentRef": "U1",
      "pin": "VDD",
      "minVoltageV": 1.8,
      "maxVoltageV": 3.6,
      "reference": {
        "partNumber": "EXAMPLE-DEVICE",
        "package": "EXAMPLE-QFN",
        "revision": "rev-A",
        "source": "Example only; replace with exact manufacturer datasheet",
        "section": "Example operating-supply range"
      }
    }
  ]
}
```

The result records actual **caller-supplied** net/pin identities, explicit
numeric voltage, limit source, and a `WARNING` when these declarations
conflict. A net called `3V3` or `VCC` with no numeric `voltage` field
does **not** establish a verified 3.3 V or other operating voltage.
An observed in-range point remains `UNKNOWN` for electrical certification.

## Supported bounded constraints

- `pin_voltage`: compare exact net wiring (`expectedNet`) and explicitly
  declared voltage against minimum/maximum pin or I/O-domain limits. A
  mismatched wired net or observed exceedance is `WARNING`.
- `io_domain_voltage`: compare an explicitly declared I/O pin and
  same-device supply pin using numeric net voltages and the
  caller-declared `maxAboveSupplyV` limit. For example, a hypothetical
  non-5V-tolerant input may have an upper bound relative to its I/O
  supply; the tool does **not** assume any device has that limit unless
  it is declared with an exact part/package/revision source. Exceeding
  the limit yields `WARNING`; a value within the limit is
  `UNKNOWN`, not I/O compliance. Missing pin identity, numeric rail
  data or valid bounds also remains `UNKNOWN`. This is an upper-bound
  observation only, not proof of logic thresholds, negative-rail ratings,
  power sequencing, current injection, absolute-maximum suitability or
  rail tolerance.
- `intentional_nc`: flag a pin declared NC but actually mapped to a net.
  No observed net remains `UNKNOWN` because a native no-connect marker
  and the correctness of the datasheet declaration were not independently
  verified. A valid NC is **not** falsely failed by this review.
- `required_support`: record required pull resistor, local decoupling,
  reset/boot support, connector ESD or other protection by exact
  `supportRef`. An optional exact `supportPin` tests whether that pin
  and the target component's declared pin appear on the same explicit net.
  When both pins are uniquely identified and map to **different** nets,
  the review reports `WARNING` with both net names and the support-pin
  identity. Matching names/net IDs remain `UNKNOWN`, not a support PASS:
  the other terminal, component function/value, location, and physical
  behavior are not independently verified. Duplicate component or pin
  identities are ambiguous and never produce a false mismatch.
  The support reference must identify a **different component** from the
  target; repeating the target itself does not establish an external
  pull, decoupling or protection part. Such self-support remains
  \`UNKNOWN\` even when its pins share a net.
  Presence of a designator does not prove electrical
  Presence of a designator does not prove electrical
  connection, values, location, or adequacy. Absence from the supplied
  device list is a candidate finding, not certified absence from the
  live board, because the supplied list may be partial. Both remain
  `UNKNOWN` for physical compliance until source-bound live proof.
- `regulator_headroom`: compare input and output **numeric net voltages**
  on the declared regulator pins with a caller-supplied `minHeadroomV`.
  Insufficient margin yields `WARNING`. Load-dependent dropout,
  temperature, transient and current constraints require separate
  evidence from the existing `easyeda_power_tree_analyze`.

Every net ID and name, and every device ID and designator, must be exact,
nonblank and **globally unique** across its respective supplied inventory.
A conflicting ID on an otherwise unrelated device or net makes source
attribution ambiguous for the entire caller-supplied snapshot, rather than
proving an exact pin/rail measurement on one apparently unaffected device.
The review retains \`UNKNOWN\` without observed voltages or invented electrical
conformity; this is a conservative input-integrity check, not evidence that
a duplicate exists in the live EasyEDA project.

Exact pin references are required in the supplied device inventory before
the netlist is considered a unique connection observation. A pin mapped to
multiple nets, a repeated pin node, a net ID or name reused by another
net entry, an omitted component, missing voltage, incomplete device
inventory or absent source revision yields `UNKNOWN` or input validation
error, never an invented PASS. Duplicate net names are **not** evidence
of shared electrical connectivity; exact pin-to-net identity must first
be unambiguous.

The original `passed`, `errors` and `warnings` fields retain the semantic
ERC contract when this optional review is omitted. When source-declared
constraints are supplied, an observed datasheet mismatch also makes
`passed=false`. The additional `datasheet_review` describes every
constraint's findings and limitations; `electrical_approval=false`
is always present in this mode. A true semantic `passed` without
source-declared violations is **not** datasheet sign-off.

## Live acceptance and follow-up

A bounded [EasyEDA Pro Web 3.2.209 source-matched live read-only schematic
observation](./evidence/easyeda-live/2026-11-04-ubuntu-24-04-easyeda-3.2.209-v1.9.0-schematic-844.json)
records three exact net/pin support tests using a disposable LED-indicator
fixture: a shared net yields `UNKNOWN`, a different net yields `WARNING`,
and an absent support pin yields `UNKNOWN`. This is a **synthetic support
requirement applied to observed native connectivity**, not evidence of a
device-specific datasheet requirement. No external voltage measurements,
power-tree sign-off, or electrical/fabrication approval were made.

Run the exact-source, real EasyEDA Pro read-only review on a disposable
schematic with a verified editor/extension version, native project identity,
correct pin map and chosen datasheet/package/revision; compare recorded
netlist/readback against the declared facts and ensure no design mutation.
Representative cases include: an overvoltage rail, unsafe I/O level,
intentional NC, missing support component, regulator headroom and
incomplete library metadata. Mock and unit tests alone are not live editor
acceptance. Do not claim product-safety, electrical or fabrication
compliance from this software contract.
