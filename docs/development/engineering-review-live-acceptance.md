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
- Compare the disposable project's relevant state with the original
  state. There must be no design mutation, export, or implicit approval.
- Unsupported or missing native fields must be reported as unavailable;
  zero errors or an empty array cannot by itself establish a pass.

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
