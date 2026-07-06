# Safety Model

This document explains the security posture, permission checks, data privacy controls, and risk levels associated with the MCP tools in `easyeda-mcp-pro`.

---

## 1. Tool Classifications

Our tools are categorized into three risk tiers based on their potential impact on project data and external services:

| Risk Level | Tool Type                                   | Description                                                                                                                                                                                                                                                                                                                                                                                      | Confirmation Required         |
| :--------- | :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------- |
| **Low**    | `Read-only` / `Diagnostics` / `Visual`      | Queries project metadata, diagnostics status, layers, stackups, BOM, and canvas captures (`easyeda_canvas_capture`, `easyeda_canvas_capture_region`, `easyeda_canvas_locate`). Cannot mutate project state, though a capture/locate call does move the user's visible viewport (EasyEDA Pro has no offscreen rendering API).                                                                     | **No**                        |
| **Medium** | `Schematic Write` / `Catalog` / `Workflows` | Mutates schematic sheets (placing components, drawing wires, deleting or modifying primitives), ingests/caches a device from an LCSC part number (`easyeda_catalog_verify_device`) — a local cache write, not a project mutation, but gated the same way since downstream planning may trust the result — or runs a compound multi-step schematic transaction (`easyeda_workflow_*`, see below). | **Yes (`confirmWrite=true`)** |
| **High**   | `PCB Write` / `Exports` / `API Call`        | Mutates PCB layouts (tracks, vias, zones, components), exports fabrication files, or makes direct class-method calls.                                                                                                                                                                                                                                                                            | **Yes (`confirmWrite=true`)** |

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

## 2. The `confirmWrite` Safety Parameter

To prevent AI models from executing destructive or mutating operations accidentally, all writing and mutating tools enforce a mandatory parameter:

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
