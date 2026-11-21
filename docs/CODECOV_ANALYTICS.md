# Codecov analytics

The repository publishes complementary quality signals from dedicated Node.js 24 CI jobs:

- server and EasyEDA bridge-extension code coverage,
- server and extension JUnit test results for Codecov Test Analytics,
- deterministic extension JavaScript bundle-size budgets enforced by `extension-integrity`.

The workflow follows Codecov's guidance for [coverage uploads](https://docs.codecov.com/docs/quick-start), [Test Analytics](https://docs.codecov.com/docs/test-analytics), [repository configuration](https://docs.codecov.com/docs/codecov-yaml), and [JavaScript bundle analysis](https://docs.codecov.com/docs/javascript-bundle-analysis).

## Coverage reports

Vitest produces separate LCOV files so Codecov can show independent histories for the two codebases:

| Component                | Flag        | LCOV file                                     |
| ------------------------ | ----------- | --------------------------------------------- |
| MCP server               | `server`    | `coverage/lcov.info`                          |
| EasyEDA bridge extension | `extension` | `easyeda-bridge-extension/coverage/lcov.info` |

`codecov.yml` also defines matching Codecov components. Project coverage remains informational at the current baseline (`target: auto`) with 1% tolerance. The umbrella `codecov/patch` status retains an 80% target with a two-percentage-point tolerance for advisory changed-line analytics, but it is not branch-protection-required. Separate `server` and `extension` flags and components preserve independent histories without filtering the umbrella patch status or hiding changed-line annotations. The rationale and triage process are in [Changed-code quality gates](QUALITY_GATES.md).

Generate the reports locally with:

```bash
pnpm test:coverage:ci
pnpm test:extension:ci
```

## Test Analytics and failed tests

Both suites write JUnit XML:

- `reports/server.junit.xml`
- `reports/extension.junit.xml`

The required `tests-and-coverage` job validates both LCOV/JUnit report sets before staging them for telemetry. Missing, empty, malformed, or below-threshold reports fail the required local job. Artifact staging is best-effort because provider telemetry is not part of the merge boundary.

The separate `coverage-telemetry` job downloads validated reports, installs the verified Codecov CLI, and records configuration/upload outcomes in its own summary. Provider or artifact-service failures remain diagnosable without masking the local test result.

Generated reports are ignored by Git and must not be committed.

## Bundle-size budgets and remote analysis status

The extension uses a custom esbuild script rather than Vite, Rollup, or Webpack. Repository-owned byte budgets remain the blocking bundle-size control for `index.js`, `dispatcher.js`, and the packaged extension.

Remote Codecov Bundle Analysis is disabled. The previous `@codecov/bundle-analyzer@2.0.1` integration repeatedly received `404 Not Found` from Codecov's pre-signed URL endpoint in trusted CI and was no longer invoked by repository scripts. In October 2026 its dependency chain also became the repository's only path to the unresolved high-severity `braces@3.0.3` advisory. The unused analyzer dependency was therefore removed instead of weakening dependency-audit policy. Primary LCOV coverage and Test Analytics remain available as advisory telemetry, while deterministic local coverage thresholds and extension byte budgets remain blocking repository-owned controls.

Reintroduce remote bundle analysis only after a separately verified Codecov service/tooling path both works in trusted GitHub Actions and has a dependency graph that passes the repository security policy.

```bash
pnpm build:extension
pnpm check:extension-size
```

The current limits live in `config/extension-size-budget.json`. Missing artifacts, malformed budgets, or files above their configured limit fail CI.

On 2026-09-28, the polygon argument materialization required by `easyeda_api_call` increased the deterministic extension builds from 260,002 to 262,811 bytes for `index.js` and from 185,386 to 188,040 bytes for `dispatcher.js`. The corresponding byte ratchets are 262,815 and 188,045 bytes; the packaged `.eext` remains under its unchanged 200,000-byte ceiling. Future growth still fails closed and requires another measured ratchet review.

On 2026-10-05, the existing-copper rebuild path added explicit runtime capability checks, pre-mutation target validation, sequential native execution, source-pour-keyed persisted read-back verification, a complexity-preserving helper split, and ES2020-compatible error-cause preservation. Against current `main`, the deterministic build increased from 263,531 to 276,820 bytes for `index.js` and from 188,745 to 201,168 bytes for `dispatcher.js`; the packaged `.eext` increased from 177,983 to 183,089 bytes and remains below the unchanged 200,000-byte package ceiling. The reviewed ratchets are therefore 276,824 and 201,173 bytes, preserving the existing 4/5-byte deterministic margin. Any further growth still fails closed and requires another measured ratchet review.

On 2026-11-03, native PCB drill inspection and active DRC spacing-profile reads increased the current deterministic build to 310,895 bytes for `index.js`, 248,309 bytes for `dispatcher.js`, and 206,179 bytes for the packaged `.eext`. The `index.js` ratchet is unchanged; the measured dispatcher and package ratchets are 248,314 and 206,184 bytes (5-byte deterministic margins). The added read-only inspection capability is the measured cause. These remain bounded byte budgets, not permission for unreviewed growth; any further increase requires another measured ratchet review.

On 2026-11-10, issue #995's narrowly scoped read-only `LIB_Device.get` metadata
query added a typed library sub-part inspection tool without enabling unverified
multi-unit placement. Measured deterministic builds against protected
`main@80b4118d`: packaged `.eext` **210,948 → 211,697 bytes**, `index.js`
**331,654 → 333,198 bytes**, `dispatcher.js` **269,136 → 270,680 bytes**.
The reviewed ratchets are **211,702 / 333,203 / 270,685 bytes** respectively
(5-byte deterministic margins). This is a measured additive read-only feature,
not a blanket ceiling increase or permission to bypass size gates; future
growth still fails closed. Actual EasyEDA runtime sub-part data and shared BOM
semantics require independent live acceptance.

On 2026-11-10, the multi-unit BOM identity correctness patch for #995 made BOM
quantity count verified **physical component identities** rather than every
schematic section; it also preserves native `AddIntoBom=false` and rejects
ambiguous reference/UniqueId/device/library/part mismatches before returning a
purchase quantity. The exact source example showed two same-designator/same-
UniqueId schematic units linked to one PCB component, but live native
two-unit placement/BOM sign-off remains **unverified**. This additional
read-only handling changed the deterministic extension package from
**211,697 → 213,140 bytes**, index from **333,198 → 336,312 bytes**,
and dispatcher from **270,680 → 273,794 bytes**. Ratchets are
**213,145 / 336,317 / 273,799 bytes** (5-byte deterministic margin each),
with no quality/security gate disabled and no release authorization implied.

On 2026-11-16, Cloud PR #1057 added a preconfigured official Cloud menu,
independent Custom Cloud WSS selection, and owner-bound expiring device
resume after relay restarts. The full production .eext measured
**234,835 bytes** against the previous **234,551-byte** ratchet (+284);
dist/index.js measured **390,715 bytes** against **389,554** (+1,161);
the unchanged dispatcher artifact measured **313,113 bytes** against
its **313,115-byte** ratchet. The reviewed new limits are
**234,840 / 390,720 / 313,115 bytes** (package/index each measured
size +5, dispatcher unchanged). The package check remains mandatory
and fail-closed; these narrow deltas do not authorize general bundle
growth, enable experimental native writes, or complete Cloud rollout.

On 2026-11-16, PR #1057 follow-up made Cloud owner device removal visible
immediately inside the live extension through a session-bound revocation
notification. On the deterministic full production build, the package measured
**234,930 bytes** (previous limit 234,840), dist/index.js measured
**391,208 bytes** (previous limit 390,720), and dist/dispatcher.js remained
**313,113 bytes** (within the existing 313,115 limit). The narrowly reviewed
new ratchets are **234,935 / 391,213 / 313,115 bytes**. Each changed
artifact retains a five-byte margin; the dispatcher limit is unchanged.
These limits remain enforced by CI and do not authorize unrelated growth.

On 2026-11-21, PR #1110 closed a native standalone schematic-delete
fail-open path: before any mutation, the extension now requires exact native
component ID and type readback and refuses flags, ports, sheet frames,
ambiguous inventory, and stale ID results. The deterministic Node.js 24.22.3
build changed from **247,010 to 247,802 bytes** for the packaged extension
(+792 bytes), **422,452 to 424,261 bytes** for index.js (+1,809),
and **336,523 to 338,332 bytes** for dispatcher.js (+1,809).
The reviewed byte ratchets are **247,807 / 424,266 / 338,337 bytes**
(respectively, exactly measured output + five bytes each). The separate
extension-integrity job, its byte limits, and source/package integrity checks
remain mandatory and fail closed. This is a narrow safety overhead review,
not broad permission for extension growth or native marker deletion.

The 2026-11-21 follow-up to PR #1110 further restricts fixture-only native V4
Ground reconstruction: even with a scoped native document and opt-in capability,
a snapshot missing an exact marker-matched isolation descriptor or reporting
wires, free pins, additional components, missing embedded pins or invalid
attribute counts cannot call the native create API. This does not authenticate
caller-supplied evidence or authorize production marker deletion. The
reproducible extension package measured **248,069 bytes** (previous
**247,802**, +267), index.js **424,827** (previous **424,261**, +566) and
dispatcher.js **338,898** (previous **338,332**, +566). The reviewed budget
ratchets remain output plus five bytes: **248,074 / 424,832 / 338,903**.
All size and integrity checks remain mandatory.

The 2026-11-21 continuation of PR #1110 adds a second native component
type/identity check during the **full-batch ownership resolution**, before
any standalone schematic delete is executed. This refuses stale component
lookups that change from an ordinary component into a marker between reads,
and prevents duplicate IDs from causing repeated deletes. The reproducible
build changed from **248,069 to 248,379 bytes** for the packaged extension
(+310 bytes), **424,827 to 425,642 bytes** for index.js (+815), and
**338,898 to 339,713 bytes** for dispatcher.js (+815).
The reviewed byte ratchets are **248,384 / 425,647 / 339,718 bytes**
(output plus five bytes each); the integrity/size checks remain enforced.
This is a bounded in-process preflight, not a cross-process native editor
writer fence or permission to delete markers in production.

The 2026-11-21 #1102 native marker acceptance follow-up ensures a typed
Ground rollback descriptor is not silently discarded when the bridge parses
a snapshot for recreation. The new strict parser retains a cloned descriptor
only when its exact marker ID, isolated native topology counts, field set
and scoped netflag shape agree; malformed, extra or cross-kind fields are
rejected before any native API call. This is NOT authenticated provenance
or production permission to delete markers. The separate disposable V4.1.105
Ground and IN netport direct-native delete/recreate/save/full-cold-reopen
round trips preserved symbol identity, net, position, pin and nonvolatile
attributes, with only sheet Update Time refreshed; these were not integrated
MCP transactional rollback tests. The reproducible extension package grew
from 248,379 to 249,222 bytes (+843), loader from 425,642 to
427,709 bytes (+2,067), dispatcher from 339,713 to 341,779 bytes
(+2,066). The enforced byte ratchets remain measured plus five bytes:
249,227 / 427,714 / 341,784. No size check is disabled.

A further 2026-11-21 #1102 regression test now traverses the full Bridge
snapshot input parsing and fixture-only Ground recreation path using a
verified-shaped scoped isolation witness. It failed before the optional
unit-fixture capability was forwarded to the recreator, then passed. A
separate negative test ensures an untrusted caller cannot enable this
capability: the production dispatcher supplies no such opt-in and remains
fail-closed even with a complete caller-provided witness. This is a unit
test, not authorization to delete native markers or proof of an integrated
native marker rollback. The exact reproducible extension archive changed
from **249,222 to 249,343 bytes** (+121), loader from **427,709 to
427,890 bytes** (+181), and dispatcher from **341,779 to 341,960 bytes**
(+181). Enforced byte limits are the measured sizes plus five:
**249,348 / 427,895 / 341,965 bytes**. CI integrity/size checks remain
enabled.

## Configuration validation

The non-blocking `coverage-telemetry` job validates `codecov.yml` through Codecov's validator after local tests have passed:

```bash
pnpm validate:codecov
```

The workflow uses the repository `CODECOV_TOKEN` only for trusted pushes and same-repository pull requests. Fork and Dependabot pull requests still run tests and upload the two LCOV reports through Codecov's tokenless public-repository path. Authenticated JUnit Test Analytics and bundle uploads remain trusted-event only because GitHub does not expose repository secrets to untrusted runs.

Before upload, `scripts/install-codecov-cli.mjs` downloads the exact Linux asset declared in `config/codecov-cli.json`. The installer restricts the source to the official Codecov GitHub release path, checks the expected byte length and SHA-256 digest, writes the executable atomically, and passes that verified local binary to the SHA-pinned Codecov Action. This avoids disabling validation when the Action's remote GPG-key bootstrap is unavailable.

On 2026-11-10, the #480 read-only native Pour?Poured association inspection added a bounded
MCP tool with explicit absent/unavailable/mismatch evidence and no PCB mutations.
The reproducible Windows build measured 350,926 bytes for `dist/index.js`,
288,404 bytes for `dist/dispatcher.js`, and 220,087 bytes for the `.eext`
archive. The previous limits were 349,134 / 286,612 / 219,338 bytes respectively.
The ratchets were deliberately increased only to **350,931 / 288,409 /
220,092 bytes** (each actual artifact size plus five bytes), retaining the
automatic build and release fail-closed budget gate. This does **not**
constitute native post-mutation copper rebuild acceptance or permission to
release #985.

The 2026-11-18 first-user Cloud reconnect change added **explicit opt-in**
device trust, strict expiry/revocation behavior and lifecycle regression tests
without extending remote tool privileges or retaining one-time pairing codes.
The reproducible production extension package measured **236,709 bytes**
(previous **235,224**, +1,398 bytes, +0.59%) and its non-minified loader
measured **397,648 bytes** (previous **391,729**, +5,567 bytes, +1.42%).
The dispatcher remained **313,297 bytes**. The size configuration was
updated only to these observed bytes; the checker, deterministic build,
package identity verification and fail-closed limits remain enforced.
The change is **not** general-availability or live cold-restart acceptance
without a separate real EasyEDA trial.

The Web V4 background-timer recovery regression on 2026-11-19 retains
authenticated relay heartbeat liveness while avoiding a false disconnect on
the first callback after a browser timer suspension. **If the server does not
acknowledge the fresh probe, the next ordinary liveness sweep still closes
the dead connection.** Source test coverage exercises both resumed acknowledgments
and unresponsive transports. The measured extension distribution grew from
236,709 to **236,787 bytes** (+78), the loader from 397,648 to **397,963
bytes** (+315), and the dispatcher remained **313,297 bytes**. The extension
size checker and hard ceiling remain enabled; this is QA source behavior,
not a claim of public release or real Web V4 acceptance.
