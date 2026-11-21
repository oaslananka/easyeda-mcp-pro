# Safety Model

This document explains the security posture, permission checks, data privacy controls, and risk levels associated with the MCP tools in `easyeda-mcp-pro`.

---

## Native schematic text deletion — version-gated persistence

The EasyEDA Pro 3.2.209 BETA `SCH_PrimitiveText.delete` call can acknowledge a
successful deletion and remove text from the in-memory inventory **without
persisting it**. A controlled offline `.eprj2` test found the text returned
after closing and reopening the editor. Selecting the same text in the GUI,
pressing **Delete**, saving with **Ctrl+S** and reopening did persist the
removal. This is a specific native API limitation, not a general claim that
saving `.eprj2` fails.

In **EasyEDA Pro 4.1.105**, a separate disposable offline `.eprj2` was tested
with the actual **v1.16.0 source-built MCP server and imported extension**:
`easyeda_schematic_add_text` and an explicit MCP save survived a complete
cold restart; the isolated V4 BETA `SCH_PrimitiveText.delete(exactId)` path
through `easyeda_schematic_delete_primitive` then removed that one text.
After MCP save, stopping the editor and server and opening the same file in
a new native process found **zero** matching markers, one remaining page-frame
primitive and no wires. The installed extension dispatcher build was
independently matched against the rebuilt package. This is **one runtime,
one primitive ID, one project format**, not acceptance for every EasyEDA
release, file format, Cloud route or later asynchronous editing session.

The extension therefore permits **a single text ID only** when the trusted
native editor version is exactly `4.1.105` and the native API acknowledges
the delete and a fresh native text inventory no longer contains that ID.
Other versions (including `3.2.209`), unknown runtimes, mixed/multi-ID text
requests and unavailable readback still fail closed before unrelated writes.
The native BETA API expects a scalar ID; other primitive classes use their
separate documented deletion contracts. The public MCP deletion and save
responses **still report `persistence_verified=false`** until the user
independently cold reopens and checks the exact document. Never blindly
retry an ambiguous write.

The advanced `easyeda_api_call` entry point **continues to refuse** both
`SCH_PrimitiveText.delete` and `SCH_SourcePrimitiveText.remove` on all
versions. The latter source API failed to persist its removal even on the
isolated V4 editor. Do not expose either API as an undocumented bypass.
No synthetic keypresses, direct SQLite edits or automatic persistence
fallbacks are part of this implementation.

The previous 3.2.209 native regression, the 4.1.105 direct-vendor API tests
and the new source-built MCP path are separately tracked in
[issue #1060](https://github.com/oaslananka/easyeda-mcp-pro/issues/1060).

### Native schematic marker deletion: standalone fail-closed preflight

The native schematic Component class also contains net flags, hierarchical
net ports and sheet-frame primitives. A generic UUID-only standalone delete
must not infer that every object owned by that class is an ordinary component.
The extension now checks **every requested ID before any deletion**: only a
component whose exact ID and native type can both be read as component may
use the standalone component path. Explicit netflag, netport, sheet,
unknown types, missing identities, failed native reads, and ID-only component
inventories are refused without deleting earlier primitives in a mixed batch.

Experimental V4 Ground reconstruction now also refuses a missing or
inconsistent read-only native isolation descriptor (exact marker ID,
two-component/zero-wire/zero-page-pin topology, one embedded pin and bounded
attribute count) **before** the native create API is called. A descriptor
carried in a caller-supplied snapshot is not independently trusted proof of
disconnection, so the fixture-only flag and the production delete prohibition
remain necessary. Runtime scope checks and cold-reopen verification are
additional gates, not substitutes for native writer coordination.

The V4.1.105 disposable QA also confirmed native direct Ground-GND and
IN netport delete/recreate workflows, followed by native sch_Document.save(),
complete editor termination and independent cold reopen. Each recovered the
expected symbol/library, net name, orientation, embedded pin and all
nonvolatile attributes. The only observed attribute difference after save
was the sheet's generated @Update Time. These tests do NOT establish
the end-to-end MCP transactional DELETE/ROLLBACK path or general connected
schematic safety. The netport native Direction getter was absent; its
IN direction was independently identified through the exact native
Netport-IN symbol and pin, not guessed from the net name.

Typed read-only V4.1.105 IN netport snapshots now attach the observed
native Netport-IN library and symbol identity only when the exact component
ID, native net/name, finite position, unmirrored zero rotation, embedded
pin identity and independent native pin read agree. A conflicting direction
getter, different editor version, wrong symbol/pin, stale component or
changed focused project/page cannot earn the derived descriptor. Other
native variants remain unverified. The descriptor is direction/identity
evidence only, not proof of electrical isolation, attribute equivalence,
a native writer reservation or supported transactional deletion.

The isolated Ground evidence format is now version 2. It compares exact
attribute list/ID/get results across two native reads and includes a
SHA-256 fingerprint of every verified owned attribute's key, value, position,
rotation, color, font, alignment, text style, fill and visibility. The
fingerprint retains the surviving sheet identity and multiplicity; regenerated
marker/pin/attribute IDs do not change the semantic digest. Only native
sheet update date/time metadata and the unset (undefined versus null)
visibility fields of empty marker Relevance metadata are normalized.
Actual true/false visibility and other content or style changes are not
equivalent. Raw repeated reads still compare exact unnormalized state.

A disposable V4.1.105 acceptance harness using the repository's actual
TransactionManager and source-built Bridge snapshot/recreation operations
through the native CLI demonstrated a real Ground delete and verified
rollback with a new ID and matching full attribute fingerprint. The initial
run deliberately failed rollback verification on the observed unset metadata
representation change; a fresh copy passed after the narrow normalization.
An altered pre-delete fingerprint was refused before mutation in the
fixture harness. The native Save was acknowledged. This is **not** acceptance
of a production MCP dispatcher marker-delete method or native writer fence;
fixture-only deletion/recreation remains opt-in, and the production
transactional delete allowlist is unchanged.

The typed native Ground snapshot now attaches isolation evidence only when
all nine owned marker/pin attributes match the verified default creation
profile, including relative geometry and the complete attribute style and
visibility state. Real V4.1.105 native creation at three distinct integer
positions established the relative profile; hidden native metadata retains
its null/zero coordinates. Extra, missing, duplicate or customized attributes
are readable but cannot earn the reconstruction witness. Mirrored, rotated or
noninteger poses are refused by the experimental recreation helper too.
An isolated native CLI probe exercised the actual source dispatcher: an
unchanged default Ground earned a witness, a deliberately customized
Description did not, and standalone delete was refused without mutating that
marker. These unsaved test edits were discarded; the backup and test file
hashes remained unchanged. The probe is not an installed MCP mutation test.

Immediate delete compensation now obtains an independent explicitly typed
Ground snapshot after native recreation, rather than trusting the generic
snapshot returned by create. Missing scope/evidence or incorrect native ID
cannot pass that readback; the transaction manager still checks the full
normalized fingerprint. This does not establish an exclusive native writer
reservation or grant production marker deletion permission.

An internal private-file-worker candidate now connects the schematic
batch transaction preflight to a host-constructed Ground session adapter.
It accepts only one verified target in an isolated session; ordinary
BridgeManager, CDP and remote-relay paths cannot opt in through request
data. It checks exact session ownership before and after native calls,
rechecks the full snapshot before deletion, and prohibits retries after
ambiguous native mutation or incomplete reconstruction. Isolation is a
launcher prerequisite, not something inferred from a headless flag or
a caller-supplied descriptor.

A Linux acceptance harness ran the actual MCP SDK registry and transaction
tools with an isolated native editor, private display/network/process
namespace and disposable in-memory project copy. Duplicate session
preflight and missing confirmWrite were refused; a dry run made no
mutation. An actual MCP Ground delete succeeded, but rollback failed:
a newly created marker lacked its native library identity in the fresh
offline profile. No file was exported and the original was unchanged.
The project export identified the cause: the native snapshot contains
project-local device and symbol copies, not the system-library record IDs.
The private adapter now requires both project-local source associations
from the native device archive and an independent lookup of the actual
system Ground device and its associated symbol, during preflight and
immediately before mutation. A readable project copy, matching name, or
unrelated system record cannot authorize deletion. The offline system
library does not contain the matching source IDs. The project library
export preserved the associations, but the tested project and private
personal import APIs did not restore source availability.

A subsequent isolated half-offline fixture retained independent network,
process, display and filesystem namespaces and used a bounded HTTPS relay
to the verified vendor library endpoints. The actual SDK MCP client and
registry performed Ground delete, verified native absence, and explicit
rollback with a newly allocated ID and matching v2 attribute fingerprint
(38 attributes, one embedded pin, no wires or free pins). Native Save
acknowledged the restored state. This is real MCP/native source-adapter
acceptance, not a shipped launcher, installed extension capability, or
general native writer lock. The production GUI/Cloud allowlist remains
unchanged. The native document-source beta API is not used for production
rollback.

The explicit Linux-only acceptance command is:

    easyeda-mcp-pro private-ground-check --project input.eprj2 --output verified.eprj2 \
      --editor /path/to/easyeda-pro --activation /path/to/existing-activation.txt \
      --confirm-write --allow-library-network

This runs a real MCP delete/rollback round-trip against a disposable copy
of the narrowly supported V4.1.105 single-page default Ground fixture,
including the verified project-local device and symbol IDs and exact owned
attribute profile. Other project-local IDs are currently unsupported. It
does not expose a general interactive worker or extend ordinary marker
mutation permission. It needs a non-root Linux account with functional
user namespaces, bubblewrap, Xvfb, socat, Python 3, and a legitimate locally
activated EasyEDA Pro 4.1.105 installation. The output must not exist.
The worker uses a separate network namespace and a bounded CONNECT relay
to pro.easyeda.com; the relay restricts destinations, not individual
encrypted requests. No existing editor profile or login is reused.
The native editor receives the selected local offline activation through a
read-only mount; the HTTPS relay does not inspect encrypted vendor traffic.
If the precise device, topology, native state or persistence cannot be
verified, it produces no output. The original is never overwritten.
The command publishes only after a fresh isolated native cold reopen and
matching snapshot, with a no-clobber output operation. This is a narrow
acceptance/diagnostic workflow, not a claim of general component rollback.

The Bridge's typed Ground recreation integration is verified through an
explicitly opted-in unit fixture. The actual production dispatcher does
not provide that capability, and an MCP caller cannot request or grant it.
Matching an untrusted snapshot's claimed isolation fields is not native
provenance or permission to perform a real marker delete.

A typed Ground recreation snapshot now parses and retains only a strictly
bounded isolation descriptor consistent with its primitive ID and native
project/page context; malformed, unexpected and cross-kind evidence is
refused. A caller-supplied descriptor remains untrusted data, so no
production marker deletion is authorized by this parser or the direct
native round-trip alone.

The schematic component-ID fallback must not convert the native
getAllPrimitiveId collection into an untyped list of requested net flags,
net ports or ordinary components. The same native component class includes
sheet symbols and multiple marker kinds. When getAll is empty or stale,
the fallback now checks every returned ID with an independent exact native
get(id) and ComponentType read. Wrong, stale, duplicate or malformed IDs
and unavailable native type evidence fail closed rather than pretending
that a different marker was recreated. Sheet primitives are never included
in the ordinary-component inventory. This is a reconstruction identity
guard, not a native writer fence or production marker-delete permission.

Before the first write, the extension now resolves the entire deletion batch,
rechecks exact native component identity and type at ownership resolution,
and rejects duplicate IDs. If a component changes into a marker or becomes
unreadable between preflight and ownership resolution, no earlier wire is
deleted. This is fail-closed preflight, not atomic execution: an external
native editor writer may still change state after the final read.

This closes a standalone-delete path that otherwise bypassed transactional
marker rollback restrictions. It does not grant transactional deletion of
components, flags or ports; the existing production transaction allowlist
remains unchanged. Native editor concurrency and persisted outcomes still
require independent verification; an in-process check is not a native
cross-process writer lock. See
[issue #1102](https://github.com/oaslananka/easyeda-mcp-pro/issues/1102).

### Project save: exact native target versus persisted outcome

A successful native `sch_Document.save()` or `pcb_Document.save()`
acknowledgment does **not** prove a design change survives cold reopen.
The `easyeda_project_save` tool therefore requires `confirmWrite=true`
and delegates only to the **exact active project and focused document**,
whose native UUIDs and document type must agree. It never uses workspace
`saveAll`, switches documents, or retries a save through an unrelated
document type.

For a native acknowledgment without independent persisted-state evidence,
the public result is explicitly `success=false`,
`native_acknowledged=true`, `persistence_verified=false`, and
`status=persistence_unverified`. An unconfirmed or ambiguous native
result also fails, without exposing native filesystem details. This is
deliberate: users must not mistake a pending disk verification for a
durably saved schematic. Read the exact project back after closing and
reopening it; never blindly repeat a non-idempotent write.

The disposable .eprj2 text-delete regression is still open for automated
MCP writes. On EasyEDA Pro 3.2.209, a controlled API-created marker persisted
after **GUI Ctrl+S** and a full editor restart, although the native MCP save
returned `native_save_unconfirmed`. The BETA `SCH_PrimitiveText.delete`
returned true and removed the exact marker from the in-memory inventory,
but GUI Ctrl+S did not update the file: reopening the editor restored it.
Selecting the same marker in the GUI showed **Selected Objects 1**.
Pressing Delete marked the schematic tab dirty (`*`); GUI Ctrl+S updated
the file. A second full restart found **zero** matching text primitives.

This establishes a difference between GUI deletion and the BETA API path,
not an automated persistence workaround. A prior unsuccessful GUI-selection
attempt did not prove a native disk delete failed. No direct SQLite
modification or production design edit was performed.

## Native copper-zone live preview (read-only)

The easyeda_pcb_add_zone tool with mode=preview and inspectLive=true checks
the focused PCB, net, layer, board containment and the class-level native
APIs needed for creation, copper inventory, exact-id rollback and save.
Only the tested EasyEDA Pro 3.2.209 runtime is recognized; older 3.2.206
builds are not silently promoted to write-verified. The preview also
combines unsupported native setting warnings with live diagnostic blockers.
These checks do not prove fill topology/DRC or supply write authorization:
readyToApply=false and public zone apply remain fail-closed.

### Explicit focused-PCB preview

The optional expectedPcbUuid paired with inspectLive=true causes the
native target-document guard to compare the selected EasyEDA PCB UUID
before returning any confirmed focus or board-readiness evidence. The tool
also requires a matching native response and returns the verified PCB name
and UUID. A mismatched, missing or untrusted target response fails closed
without revealing private native error details. A static preview without
inspectLive is not a live target check. This does not certify a specific
project/revision, give write permission, or override remote approval;
public native copper-zone apply remains disabled.

### Focused owning-project preview (read-only)

An optional expectedProjectUuid may accompany expectedPcbUuid with
inspectLive=true. The extension compares the active project with the
selected PCB's owning project before probing. The MCP response displays
the verified project UUID only on an exact match, and the common MCP
registry rejects an inconsistent native project/document response without
exposing private identifiers. A connected older extension must explicitly
advertise documentProjectGuard=true before any project-bound native call;
missing support fails before accessing the document. These checks only
bind **current project and PCB identity**, not a saved PCB revision, live
copper topology, remote approval, or authorization to mutate. The guarded
read-only zone preflight checks the project+PCB identity again after native
net/layer/outline inspection, discarding results when native focus changes or
post-read verification fails. Even this continuity check is **not** a saved
revision/content fingerprint; public native zone apply remains disabled.

## Native copper-zone host reservation (experimental, not a write permission)

The host writer reservation is an internal, extension-to-local-Bridge
`host.nativeZone.reserve` request, **not a public MCP tool**. The local Bridge
must already have accepted the active extension handshake, and the installed
extension version and method registry must both exactly match the server.
No arbitrary file path or client-selected lock directory is accepted.

The local MCP `easyeda_bridge_status` now also reports a separate
`native_zone_host_reservation` observation: `unreserved`, `reserved`,
or `unknown`. This is an OS-account-local filesystem check available even
if the editor is disconnected. A crash-retained or partially initialized
lock remains `reserved`; unexpected files, symlinks, and read errors are
`unknown`, **not free**. The observation never reveals the lock token,
owner path/PID or release mechanism and never authorizes native writes.
It is not proof that the extension's independent zone pending fence is clear.

The OS-user-home lock is atomic between independent local server processes.
A successful reservation remains held across a dropped connection, timeout,
or server restart. **The extension cannot release it**; future release requires
independent, trusted persisted-state and pending-fence recovery verification.
The response explicitly states `authorizesMutation=false`. This internal
transport includes a one-attempt response-correlated extension client; it rejects malformed/late replies, connection replacement and timeout, and never retries an ambiguous reservation. The extension never requests this host lock on startup or during ordinary read-only work. This internal transport alone does **not** connect the reservation to the native zone engine
or enable `pcb.addZone` / `easyeda_pcb_add_zone apply`. Both remain fail-closed
until the entire create/rebuild/save/cold-reopen/rollback and approval chain
has been accepted on a disposable project.

Once the private candidate receives a confirmed durable reservation,
its in-process reconciliation latch is set **before** the next focus
check or any native create call. A focus mismatch or unexpected native
API exception at that point is uncertain, not a routine blocked
preflight, even if no create call began: the host lease and pending marker
may remain. Same-instance retries remain blocked until independent
cold-reopen recovery. No automatic lease release or marker cleanup occurs.

Before requesting the host's crash-retained native-zone lease, the
private pending-fence operation now first performs a read-only check of
the persistent marker. A present, malformed, or unreadable marker blocks
the attempt without acquiring a new OS-host lock. The marker is **rechecked
after** a host grant to protect against a racing second editor or process.
Neither check clears a marker, frees a lease, or authorizes a write.
The real localhost Bridge WebSocket integration test verifies that an
existing marker consumes no host lease or one-attempt RPC permission.

A pending native zone fence is inspected only through the extension's native
storage provider. When one exists, read-only status reports a narrow recovery
state: invalid marker, PCB focus required, focus mismatch, awaiting independent
recovery, or unresolved. This status never performs a full copper inventory
scan or leaks marker/source IDs, and always reports
recoveryReleaseAuthorized=false. A matching active PCB focus does not prove
cold-reopen persistence or correct copper geometry: coldReopenVerified=false
and publicApplyEnabled=false remain unchanged. A failed native storage read
never turns a pending marker into an absent fence.

A real, source-linked Z480 baseline has also been serialized **in memory**
as a complete project-derived v2 pending marker, without storing it or
obtaining a host lease. The 32,840-byte rehearsal marker decoded correctly;
the read-only recovery classifier returned \`candidate-unchanged\`, while
a changed filled-copper signature and the wrong PCB focus both returned
\`unresolved\`. Every result kept persistenceVerified=false and
releaseAuthorized=false. This does not validate a post-write cold reopen,
release any crash-retained lease, or authorize a new native write.

Recovery marker creation also rejects two different Pour sources sharing
the same native Poured primitive identity. An older schema-valid marker
with that contradictory identity is classified as unresolved and never
grants recovery or lease-release authority. Distinct source-linked Poured
identities remain valid evidence candidates, not cold-reopen proof.

Recovery marker creation now rejects a source-less Poured baseline before
any durable reservation. If a legacy schema-shaped marker already carries
such an orphan source link, the independent recovery classifier keeps it
unresolved with no release authority. Schema shape alone is not sufficient
evidence of a coherent native source/Poured inventory.

A synthetic v2 marker was also tested in an isolated EasyEDA Pro 3.2.209
editor using its real installed Bridge: native SYS_Storage write/readback,
complete editor shutdown/restart, exact persisted readback, independent
read-only unchanged PCB inventory, and exact-value cleanup passed. The
temporary marker was not created under a host-writer lease and held a
synthetic, not project-derived, baseline; the result proves **zone-key
storage durability only**, not independent full recovery or native writes.

The bounded read-only recovery-status addition increases the measured
extension package from 222,372 to 223,998 bytes (+1,626 compressed),
the loader from 357,046 to 360,822 bytes and the dispatcher from
291,600 to 295,370 bytes. Exact size ratchets remain enabled; no
quality gate or maximum package cap is bypassed.

Read-only native-zone safety status now marks older v2 pending records as
`invalid-marker` when their baseline has an orphaned Poured source link or
two Pour sources claiming one native Poured identity. Previously those
schema-valid but contradictory records could be reported as needing only
PCB focus or independent recovery. No expensive native inventory scan,
marker cleanup, lease release or native write is performed by this status
check. Two synthetic RED/GREEN regressions cover the contradictions; they
do not establish real cold-reopen recovery. The measured 2026-11-12
extension artifacts are package 224,335 bytes (+278), loader 361,464
(+549), and dispatcher 296,012 (+549). Exact size limits remain enforced
on those measured outputs and existing release/compatibility gates remain
mandatory.

The common native Poured inventory now also rejects one physical Poured
primitive ID being claimed by two different Pour sources **before any
existing-copper rebuild mutation**. This closes the same identity ambiguity
for both the existing rebuild path and the candidate zone baseline, without
enabling public zone creation. The focused regression tests were red before
and green after this check. The measured 2026-11-12 production artifacts are:
package 224,057 bytes (+59), loader 360,915 bytes (+93), and dispatcher
295,463 bytes (+93). The exact artifact budgets track those values; the
size check and all release/compatibility gates remain mandatory. This
synthetic safety test does not replace native EasyEDA cold-reopen acceptance.

After a native beta create returns, an initial source/Poured inventory
that is **exactly identical** to the before snapshot is now observed one
more time, read-only. If a new exact source appears only on that later read,
the candidate reports a delayed-visibility diagnostic and stays uncertain.
If no source appears, or the later inventory changes unexpectedly, it remains
uncertain with the corresponding bounded diagnostic. No extra native
create, rebuild, delete, save, automatic fence release or retry is triggered.
An initial inventory with any baseline difference is not reinterpreted by
a later read, and no read-only observation constitutes cold-reopen proof.

Unexpected native API and reservation exceptions are never copied into
candidate result text: error messages can contain private project paths,
net names or other data. Only a fixed failure-phase diagnostic is exposed,
while pre-write failures stay blocked and post-write failures stay uncertain
with their recovery fence held. This differs from safe, predefined inventory
reconciliation reasons, which remain available for investigation.

Private native-zone candidate rejection now preserves the precise, predefined
inventory-delta reason through the create and rebuild reconciliation paths.
A changed original Pour/Poured, missing unique source, mismatched source
properties, or unrelated copper delta can be distinguished without exposing
project/source identifiers, raw fill signatures, or attempting a second native
write. A rejected post-write candidate remains uncertain with its persistent
fence held pending independent reconciliation; the reason is not evidence of
safe rollback or permission to retry.

Native copper readback now cross-checks each Pour's beta
getCopperRegion() association with the separately enumerated
PCB_PrimitivePoured.getAll() source/primitive IDs and exact fill geometry
signature. Missing associations, stale beta objects, differing fills or failed
read APIs cannot be interpreted as a valid post-rebuild inventory.
This check is read-only and does not authorize any new PCB mutation.

The isolated EasyEDA Pro 3.2.209 disposable Z480 PCB was reopened and the
existing POUR2 source e336 independently matched Poured e336 with 74
fill records and an exact 31,093-character fill-geometry signature match
between the two independent API read paths. This verifies baseline source-to-derived association only;
SYS_Storage cannot be read from the standalone CDP context, so the native
pending-fence state remained **unknown** in this read-only observation.
No create, rebuild, delete or save was executed and its database SHA was
unchanged. The official beta rebuildCopperRegion() documentation warns
that API-created Pour rebuilds may error internally; no blind retry or
claim of successful native filled-zone creation is permitted.

The test-only native zone adapter also enforces factory-issued provenance for
its injected host lock. A browser Web Lock, an arbitrary callback coordinator,
or a forged plain object cannot reserve the native pending fence even if it
implements an `exclusive()` function. A real loopback WebSocket integration
test verifies the host RPC precedes a **simulated** storage-marker write and
that the host lease survives disconnect. That simulation is not proof of a
real editor cold reopen or PCB write, so public apply remains disabled.

The extension packaging size ratchet was intentionally measured after adding
the local private reservation protocol: .eext 221,604 → 222,372 bytes
(+768 compressed bytes); loader index.js 354,124 → 357,046 bytes
(+2,922 bytes); dispatcher.js remains 291,600 bytes. The ratchet
tracks the complete non-minified testable loader; no size checker or
production package-ceiling enforcement was disabled.

## Bridge version drift

When the active EasyEDA extension and MCP server report different versions,
the local bridge refuses design modifications, arbitrary EasyEDA API execution,
project/export artifact writes, and unknown methods **before sending a request**.
Explicitly allowlisted diagnostic commands and project read queries remain
available. A real method-registry hash mismatch is stricter and permits only
the already documented diagnostic or development-recovery commands.

Extension import does not hot-replace an already running EasyEDA loader.
Restart EasyEDA after installing a new extension and verify the active build
fingerprint, version parity, and MCP health before resuming writes. This
does not weaken any existing user confirmation or Remote Relay approval gate.

## 1. Tool Classifications

Our tools are categorized into three risk tiers based on their potential impact on project data and external services:

| Risk level | Effect class                                | Description                                                                                                                                                                              | Local confirmation                                                                |
| :--------- | :------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| **Low**    | `read-only`                                 | Queries project metadata, diagnostics status, layers, stackups, BOM, and canvas captures. A canvas capture/locate call can move the visible viewport but does not persist project state. | **No**                                                                            |
| **Medium** | `design-mutation` / `local-state-write`     | Mutates schematic state, runs compound write workflows, or updates trusted local cache state.                                                                                            | **Yes (`confirmWrite=true`)** when the definition is project/local-state mutating |
| **Medium** | `artifact-write`                            | Creates Gerber, pick-and-place, PDF, or netlist files inside `ARTIFACT_DIR` without changing the EasyEDA design.                                                                         | **No local design confirmation**; Remote Relay still requires export approval     |
| **High**   | `design-mutation` / controlled API mutation | Mutates PCB layouts or invokes a high-risk documented EasyEDA API method.                                                                                                                | **Yes (`confirmWrite=true`)**                                                     |

---

### 1.1 Compound workflow tools (`easyeda_workflow_*`)

The `easyeda_workflow_power_rail`, `easyeda_workflow_decouple_ic`, `easyeda_workflow_place_block`, and
`easyeda_workflow_connector_breakout` tools collapse several schematic primitive operations (place,
wire, net-port) into one atomic call, each with its own `mode: 'preview' | 'apply'` field (distinct
from the generic `writeMode` transaction envelope) so a caller can inspect the exact, deterministic
operation list before applying.

- **Determinism:** the same input always produces the same transaction id and operation list — no
  hidden device search or fuzzy part selection happens inside these tools. Callers must supply
  already-resolved `deviceItem` (`libraryUuid`/`uuid`) values, typically obtained from
  `easyeda_schematic_search_device` or a verified catalog entry.
- **Rollback on partial failure:** if any operation in the sequence fails, every primitive newly
  created _in that same transaction_ (placed components and net ports) is deleted via
  `schematic.deletePrimitive`. This is best-effort — if the rollback call itself fails, the tool
  reports `rolled_back: false` and the affected primitives must be reviewed manually.
- **Known rollback limitation:** pin-to-net connections applied to a _pre-existing_ component
  (`existingComponents`, used by `easyeda_workflow_place_block` and the decoupling workflow's target
  IC) cannot be undone automatically — the bridge protocol has no disconnect-pin primitive. Every
  plan/apply response's `rollback_notes` field states explicitly whether this applies to that call.

---

### 1.2 Layout autonomy and autorouting (`easyeda_pcb_floorplan`, `easyeda_pcb_autoroute`, `easyeda_pcb_export_route_context`)

- `easyeda_pcb_floorplan` (profile `full`) is the same preview/apply/rollback-via-project-constraints
  pattern as `easyeda_pcb_place_component_group`, driven from CircuitIR physical constraints instead
  of a hand-built grid. See `docs/high-level-pcb-layout.md` for what it can and cannot infer.
- `easyeda_pcb_autoroute` (profile `pro`) calls EasyEDA Pro's native autorouter through the existing
  documented `api.call` path (`PCB_Document.autoRouting`) — a `@beta` API per `@jlceda/pro-api-types`,
  so unavailability on a given EasyEDA Pro version is reported as `not_available: true`, never a
  silent success. It always runs a pre-flight constraint check (caller `boardData` merged over the
  board evidence read from the bridge; any error blocks before the autorouter is called; unknown
  checks block in the default `gateMode: 'block'` and are reported without blocking in `'warn'`)
  and a mandatory post-route DRC + constraint report, folded into `overall_verdict`.
- `easyeda_pcb_export_route_context` (profile `pro`, read-only, no `confirmWrite`) exports a Specctra
  DSN file for external, vendor-neutral autorouters — it does not mutate the project and does not
  re-import a routed result; that re-import happens in EasyEDA Pro itself.

---

### 1.3 Offline SPICE verification (`easyeda_simulate_operating_point`, `easyeda_simulate_transient`)

These tools (profile `pro`, read-only, no `confirmWrite`) spawn a local `ngspice` binary — the one
place in this codebase besides `easyeda_execute` that runs an external program based on tool input.
Unlike `easyeda_execute`, there is no raw-code/raw-deck input path: every SPICE deck is generated by
`buildSpiceDeck()` (`src/simulation/netlist.ts`) from typed, schema-validated component data, and
every net/reference name is restricted to a safe identifier pattern before being embedded in deck
text — this specifically blocks ngspice's `.control` `shell` command (which can run arbitrary OS
commands) from ever reaching the deck. The binary is invoked with `execFile` (never a shell), inside
a dedicated temp directory removed after every run, with an enforced timeout. See `docs/simulation.md`
for the model library's scope and limits, and for why ngspice's absence is treated as a normal,
expected outcome (`available: false`) rather than a tool failure.

---

### 1.3a Unattended design cycle (`easyeda_document_activate`, `easyeda_project_create`, `easyeda_pcb_import_from_schematic`)

- `easyeda_document_activate` (profile `core`, no `confirmWrite`, `local-state-write`) only changes UI
  focus: it opens and activates one schematic page or PCB of the **active** project and reports success
  only after reading the focused document back. It refuses documents of other projects and panels.
- `easyeda_project_create` (profile `core`, `confirmWrite`) creates a project and, by default, opens it.
  Opening switches projects, so it applies the same rule as `easyeda_project_open`: it is refused while
  any user document tab is open, because unsaved edits cannot be proven absent.
- `easyeda_pcb_import_from_schematic` (profile `pro`, `confirmWrite`, risk `high`, `design-mutation`)
  calls `PCB_Document.importChanges(schematicUuid, true)` on the focused PCB of the active project. The
  `force` flag skips EasyEDA's confirmation dialog, so the MCP-level `confirmWrite` is the only approval:
  remote callers get the destructive risk class. It refuses when the PCB is not focused or the board has
  no schematic, and reports `native_import_failed` when EasyEDA does not acknowledge the import. Imported
  nets arrive unrouted; run DRC afterwards.

---

### 1.4 Artifact exports

`easyeda_export_gerbers`, `easyeda_export_pick_place`, `easyeda_export_pdf`,
`easyeda_export_netlist`, and `easyeda_export_3d` are explicitly classified as `artifact-write`. They call the bridge to
produce export data and write the resulting payload only inside `ARTIFACT_DIR`; they do not alter
schematic or PCB state and therefore do not require the local design-mutation parameter
`confirmWrite=true`.

This does not make remote exports silent. Remote Relay maps `artifact-write` to the `export` risk
class, requires the `easyeda.export` scope, and binds a human approval to the identity, session, tool,
input hash, and expiry before dispatch. Reviewed local artifact exports may then reuse
a short-lived, same-client/same-native-project session grant for up to 30 minutes; external
and destructive operations retain per-action approval. Read-only report generators that happen to be organized in
the export group are classified `read-only` and do not inherit export risk merely from that group.

---

## 2. The `confirmWrite` Safety Parameter

To prevent AI models from executing destructive or project-mutating operations accidentally, tool definitions marked as design mutations enforce a mandatory parameter:

```typescript
confirmWrite: z.literal(true);
```

### How it Works:

- The Zod validation schema requires `confirmWrite` to be explicitly set to `true`.
- If an LLM attempts to call a write tool (e.g. `easyeda_pcb_add_track` or `easyeda_schematic_delete_primitive`) without this parameter, the request is rejected at the schema validation boundary.
- For `easyeda_api_call`, if the target path is detected to be a mutating method (e.g. ending in `.create`, `.delete`, `.modify`, `.save`, etc.), the handler will return an explicit error unless `confirmWrite` is set to `true`.

---

## 3. Data Privacy and Telemetry

We believe in **strict local-first data privacy**. None of your schematic designs, board layouts, or component placement data is sent to our servers.

### What Leaves Your Machine:

Only explicitly initiated queries to third-party suppliers are sent over the network:

1. **LCSC**: Queries component details, pricing, and availability when calling `easyeda_bom_validate` or `easyeda_bom_sourcing` (uses public endpoints).
2. **JLCPCB**: Validates ordering pricing when `easyeda_bom_sourcing` is called with JLCPCB enabled.
3. **Mouser / DigiKey**: Retrieves market pricing and stock data if Mouser/DigiKey credentials are provided in `.env`.

_No design geometry or netlist data is ever uploaded to these suppliers._

Canvas captures (`easyeda_canvas_capture*`) are returned directly as MCP image content in
the tool response — they are not written to `ARTIFACT_DIR` or persisted anywhere on the
server by default. The image only goes as far as the MCP client that requested it.

Verified devices cached by `easyeda_catalog_verify_device` (`easyeda_catalog_list` reads
them back) are stored only in the local SQLite database (`SQLITE_PATH`) — never
committed to the repository or uploaded anywhere, per `docs/vendor-terms.md`. See
`docs/catalog-ingestion.md` for exactly what that pipeline can and cannot verify —
notably, it cannot fetch or check pin/pad geometry for an arbitrary part.

---

## 4. Secrets Redaction

All API keys, OAuth secrets, session tokens, and passwords are redacted from log outputs and diagnostics tools.

- `easyeda_get_server_config` filters out credentials, returning only safe configuration variables (e.g. port, transport, environment).
- The internal logger automatically redacts credentials matching key patterns before writing them to the console or logs.
