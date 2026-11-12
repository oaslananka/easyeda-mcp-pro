# Safety Model

This document explains the security posture, permission checks, data privacy controls, and risk levels associated with the MCP tools in `easyeda-mcp-pro`.

---

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
  silent success. It always runs a pre-flight constraint check (blocking before any bridge call on
  error) and a mandatory post-route DRC + constraint report, folded into `overall_verdict`.
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

### 1.4 Artifact exports

`easyeda_export_gerbers`, `easyeda_export_pick_place`, `easyeda_export_pdf`, and
`easyeda_export_netlist` are explicitly classified as `artifact-write`. They call the bridge to
produce export data and write the resulting payload only inside `ARTIFACT_DIR`; they do not alter
schematic or PCB state and therefore do not require the local design-mutation parameter
`confirmWrite=true`.

This does not make remote exports silent. Remote Relay maps `artifact-write` to the `export` risk
class, requires the `easyeda.export` scope, and binds a human approval to the identity, session, tool,
input hash, and expiry before dispatch. Read-only report generators that happen to be organized in
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
