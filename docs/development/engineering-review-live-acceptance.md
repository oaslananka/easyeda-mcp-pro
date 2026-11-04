# Engineering review: exact-source live acceptance

This is a **read-only acceptance protocol**, not a fabrication or electrical
sign-off. The deterministic fixtures in
`tests/fixtures/engineering-review/cases.json` establish software behavior,
not actual EasyEDA Pro API compatibility. Perform the live steps only in a
disposable EasyEDA Pro project; never alter an existing user design.

## Preconditions

1. Checkout the exact candidate source commit and record `git rev-parse HEAD`.
2. Verify the pinned runtime (`node scripts/check-runtime.mjs --require-pnpm`)
   and run `pnpm verify` before shipping a candidate.
3. Build the extension from **that exact source**, using `pnpm build:extension`.
   Record the generated `.eext` SHA-256 and byte size.
4. Import that exact `.eext` into the supported EasyEDA Pro runtime. Record
   the actual editor version, operating system, extension version, bridge
   method registry hash, and active disposable project identifier. A prior
   extension import or a mocked bridge is not live evidence.
5. Create and focus a disposable PCB document with a known outline and
   stackup. Preserve its initial state to verify the review does not edit it.

## Read-only observations and acceptance

- Run `easyeda_bridge_status` and confirm the connected editor and active
  extension version/method registry. Do not publish secrets or private design data.
- Call `easyeda_engineering_review` using the disposable `projectId`. Verify
  the native observation statuses, rule provenance, input units, unique
  finding IDs and the grouping of blocking, advisory, unknown, pass and
  not-applicable findings.
- Verify `coverage:DRC`, `coverage:ERC` and `coverage:POWER_TREE` remain
  `UNKNOWN`. The tool deliberately does **not** run native DRC/ERC because
  those operations may refresh editor state.
- Focus a non-PCB tab and repeat the read. If native PCB measurements are
  unavailable, record this as `UNKNOWN`, not a clean review. Restore the PCB
  tab and rerun.
- Where possible without touching real projects, test extension/runtime
  mismatch detection. If method registry or extension versions differ,
  affected evidence remains unverified until the exact matching extension
  is reimported and validated.
- Treat unavailable, blank or invalid editor/extension version values as
  **unverified native provenance**. Preserve raw read-only observations as
  diagnostics, but do not promote their fields to `measured` or issue a
  subset PCB `PASS`/`FAIL` until both runtime versions are known. The
  review reports `context:SOURCE_VERSION_UNAVAILABLE` in this case.
- Compare the disposable project's relevant state with the original
  state. There must be no design mutation, export, or implicit approval.
- Unsupported or missing native fields must be reported as unavailable;
  zero errors or an empty array cannot by itself establish a pass.

- Review a deliberately **stale/partial snapshot** only in the synthetic
  regression harness: a prior-tab `widthMm`, `hasOutline` or `layerCount`
  must not yield a constraint FAIL or a subset PASS if its owning native
  method is unavailable, not run, or the bridge disconnected. Only values
  attributable to a successfully observed native method **in that
  request** may enter the constraint evaluator. Retained values can
  remain in diagnostics with `quality: unverified` and
  `age: unverified`, but must not be presented as fresh measurements.
- A fulfilled native call with an empty object is **not** proof the
  document was inspected. Verify actual field presence and focus before
  interpreting result status. Do not accept a cached `observed` marker
  from a disconnected bridge. These are automated guardrails, not
  proof that the native editor provides a stable atomic multi-method
  snapshot; a focus change between calls still requires live review.
- For a live repeat, capture only non-sensitive status and document
  metadata. Compare measurements obtained from the same disposable
  PCB in two focused reads and then after deliberately switching to
  a non-PCB tab. Report all unsupported or cross-tab fields as UNKNOWN
  until a fresh source-bound PCB read succeeds. Never modify a user's
  existing project or silently save it.

## Evidence record

Document:

- Exact source commit, actual EasyEDA Pro and OS versions, extension `.eext`
  SHA-256 and byte size, server and extension versions, method registry hash.
- Disposable project/document identity, focus state, supported native
  methods, measured/inferred/unavailable fields and applicable limitations.
- Positive, negative, boundary and missing-input regression results.
- No-write read-back observations; failed or skipped scenarios and the
  qualified-human-review tasks still outstanding.

Record a result as **blocked/unverified** if a required live observation
cannot be performed. Keep credentials, personal device paths, private
project data, and internal infrastructure out of public evidence.

This procedure does not weaken the separate bridge write-approval, native
compatibility, release or provenance gates. Green mock tests cannot replace
required exact-source live EasyEDA acceptance.
