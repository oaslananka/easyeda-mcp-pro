# MCP Tools Reference

This page details all available Model Context Protocol (MCP) tools exposed by `easyeda-mcp-pro`.
These tools are profile-gated. Set the `TOOL_PROFILE` environment variable to enable them.

## Summary of Tools

| Tool Name                               | Profile | Risk     | Description                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `easyeda_api_call`                      | `full`  | `high`   | Controlled call to a documented EasyEDA class method by path, for example SCH_PrimitiveWire.getAll. This is not raw JavaScript execution.                                                                                                                                                                                        |
| `easyeda_api_inventory`                 | `core`  | `low`    | Inspect the live EasyEDA extension runtime and list available documented API classes, runtime paths, and methods.                                                                                                                                                                                                                |
| `easyeda_board_dimensions`              | `core`  | `low`    | Get the PCB board outline dimensions, shape, and mounting hole information.                                                                                                                                                                                                                                                      |
| `easyeda_board_features`                | `core`  | `low`    | Get counts of board features including vias, tracks, copper zones, and pads.                                                                                                                                                                                                                                                     |
| `easyeda_board_layers`                  | `core`  | `low`    | List all layers in the PCB design including signal, power, plane, and mechanical layers.                                                                                                                                                                                                                                         |
| `easyeda_board_stackup`                 | `core`  | `low`    | Get the PCB layer stackup including thickness, material, and dielectric constants.                                                                                                                                                                                                                                               |
| `easyeda_bom_export`                    | `core`  | `low`    | Export the bill of materials to a file on disk in the specified format.                                                                                                                                                                                                                                                          |
| `easyeda_bom_generate`                  | `core`  | `low`    | Generate a bill of materials for the project with grouping and formatting options.                                                                                                                                                                                                                                               |
| `easyeda_bom_quality_report`            | `core`  | `medium` | Generate a BOM quality report that identifies unavailable, single-source, missing-MPN, missing-footprint, and low-stock items across configured suppliers.                                                                                                                                                                       |
| `easyeda_bom_sourcing`                  | `core`  | `medium` | Retrieve pricing and availability information for all parts in the project BOM from specified suppliers.                                                                                                                                                                                                                         |
| `easyeda_bom_validate`                  | `core`  | `medium` | Validate the project BOM against LCSC inventory to identify missing, obsolete, or alternate parts.                                                                                                                                                                                                                               |
| `easyeda_bridge_probe_methods`          | `dev`   | `medium` | Query the EasyEDA Pro bridge for available API methods. Requires bridge connection. (dev/pro only)                                                                                                                                                                                                                               |
| `easyeda_bridge_status`                 | `core`  | `low`    | Check EasyEDA Pro bridge connection status, version, and capabilities.                                                                                                                                                                                                                                                           |
| `easyeda_canvas_capture`                | `core`  | `low`    | Capture the currently visible EasyEDA schematic/PCB canvas as a PNG image, so the caller can visually verify the result of a draw/place/route action. Captures the given tab (or the last-focused one) as-is; use easyeda_canvas_capture_region first to frame a specific area.                                                  |
| `easyeda_canvas_capture_region`         | `core`  | `low`    | Zoom the EasyEDA canvas to a rectangular region (document/canvas coordinates) and capture it as a PNG, so the caller can visually verify a specific area. This moves the user's visible viewport — EasyEDA Pro has no offscreen rendering API.                                                                                   |
| `easyeda_canvas_locate`                 | `core`  | `low`    | Zoom the EasyEDA canvas to a coordinate/scale (document/canvas coordinates), returning the resulting viewport rectangle. Useful to frame a location before calling easyeda_canvas_capture, or standalone to navigate the user's view to a point of interest.                                                                     |
| `easyeda_catalog_list`                  | `pro`   | `low`    | List devices cached by easyeda_catalog_verify_device, with their validation status and provenance. Optionally filter by status (resolved/partial/unresolved). This is a local cache only — never redistributed.                                                                                                                  |
| `easyeda_catalog_verify_device`         | `pro`   | `medium` | Resolve an LCSC part number into a catalog device entry (keyless LCSC metadata plus an EasyEDA symbol/footprint reference, if already known locally), validate it, and write it to the local device cache (confirmWrite required). Does NOT verify pin/pad geometry — see docs/catalog-ingestion.md.                             |
| `easyeda_component_probe`               | `dev`   | `low`    | Inspect live schematic component objects, including available methods and state getter values, to validate EasyEDA runtime mappings.                                                                                                                                                                                             |
| `easyeda_design_rules_lookup`           | `core`  | `low`    | Look up generic engineering reference guidance: IPC-2221 trace-width/current-capacity, clearance bands, protocol routing data (USB/RS-485/I2C/SPI/UART/Ethernet), decoupling recipes and bulk capacitance sizing, and a static DFM checklist. Every result cites a source and caveat: these are estimates, not certified values. |
| `easyeda_drc_run`                       | `core`  | `medium` | Run the native design rule check (DRC): same as clicking "Check DRC" in EasyEDA Pro, so the bottom DRC panel opens/refreshes in the user's window as a visible side effect. Returns coarse per-severity counts only — which specific wire/net/component is affected is shown only in EasyEDA Pro's own DRC panel.                |
| `easyeda_erc_run`                       | `core`  | `medium` | Run the native electrical rule check (ERC): same as clicking "Check DRC" in EasyEDA Pro, so the bottom DRC panel opens/refreshes as a visible side effect. Returns coarse per-severity counts only — which wire/net/component is affected is shown only in EasyEDA Pro's own DRC panel.                                          |
| `easyeda_export_gerbers`                | `core`  | `medium` | Export PCB design to Gerber files for PCB fabrication.                                                                                                                                                                                                                                                                           |
| `easyeda_export_netlist`                | `pro`   | `low`    | Export the schematic netlist in a specified EDA tool format (PADS, Allegro, or Altium).                                                                                                                                                                                                                                          |
| `easyeda_export_pdf`                    | `pro`   | `low`    | Export the schematic and/or board layout to PDF.                                                                                                                                                                                                                                                                                 |
| `easyeda_export_pick_place`             | `pro`   | `low`    | Export pick-and-place (centroid) file for PCB assembly. Contains component reference, position, rotation, and layer.                                                                                                                                                                                                             |
| `easyeda_get_capabilities`              | `core`  | `low`    | Return server capabilities, including available profiles, enabled feature flags, and supported operations.                                                                                                                                                                                                                       |
| `easyeda_get_feature_flags`             | `core`  | `low`    | Return current feature flag values.                                                                                                                                                                                                                                                                                              |
| `easyeda_get_server_config`             | `core`  | `low`    | Return safe (redacted) server configuration. Secrets are never exposed.                                                                                                                                                                                                                                                          |
| `easyeda_get_tool_profiles`             | `core`  | `low`    | List available tool profiles and their descriptions.                                                                                                                                                                                                                                                                             |
| `easyeda_health_check`                  | `core`  | `low`    | Return server health status in one call: runtime version, active profile, bridge state, EasyEDA version, keyless sourcing state, and starter catalog size. Intended as the single actionable status check after first connecting the bridge extension.                                                                           |
| `easyeda_jlcpcb_quote_workflow`         | `pro`   | `medium` | Prepare a non-binding JLCPCB quote workflow snapshot with explicit human-review gates and audit evidence. This tool never places orders or performs paid operations.                                                                                                                                                             |
| `easyeda_live_smoke_report`             | `dev`   | `low`    | Run a read-only live smoke report against the connected EasyEDA bridge and return status, API inventory, components, wires, and schematic nets in one response.                                                                                                                                                                  |
| `easyeda_observability_report`          | `core`  | `low`    | Return latency budgets, runtime metrics, cache/vendor timing snapshot, and storage retention policy for performance diagnostics.                                                                                                                                                                                                 |
| `easyeda_pcb_add_track`                 | `full`  | `high`   | Draw a copper track/trace on the PCB board. A multi-point path is written as one line segment per consecutive point pair (all sharing netName, so they form one electrical track — same coordinate/name merge model as schematic wires).                                                                                         |
| `easyeda_pcb_add_via`                   | `full`  | `high`   | Place a via to connect different copper layers on the PCB board. outerDiameter/holeSize are passed through to the native API unconverted (same native unit as x/y) — their real-world scale was not independently verified against a known physical dimension, so confirm the resulting via size visually before trusting it.    |
| `easyeda_pcb_add_zone`                  | `full`  | `high`   | Create a copper pour zone on a layer with clearance settings. CAUTION: the native create() call needs 9 args but this tool sends only 4 (points, layer, netName, clearance) — live-confirmed mismatch, not yet resolved. Verify visually before trusting it.                                                                     |
| `easyeda_pcb_autoroute`                 | `pro`   | `high`   | Drive EasyEDA Pro's native autorouter (PCB_Document.autoRouting, a @beta API) after a pre-flight constraint check, then run DRC and a constraint report before reporting success. Never reports success without that evidence attached (confirmWrite required).                                                                  |
| `easyeda_pcb_components`                | `core`  | `low`    | List components placed on the active PCB layout: primitiveId, designator, footprint identity, position/rotation/layer. Requires a focused PCB tab in EasyEDA Pro — returns an empty list (not an error) if none is active.                                                                                                       |
| `easyeda_pcb_constraint_check`          | `core`  | `low`    | Run PCB constraint validation against the board design. Checks board outline, layer stackup, net classes, clearance rules, keepout areas, placement zones, mounting holes, fiducials, and manufacturing constraints.                                                                                                             |
| `easyeda_pcb_constraint_report`         | `core`  | `low`    | Generate a human-readable report explaining which PCB constraints were applied and which require manual review.                                                                                                                                                                                                                  |
| `easyeda_pcb_delete_component`          | `full`  | `high`   | Delete components, tracks, vias, or other PCB primitives by ID. Checks each id against every deletable PCB class instead of assuming component, since PCB_PrimitiveComponent.delete() reports success for ids it does not own without deleting them.                                                                             |
| `easyeda_pcb_export_route_context`      | `pro`   | `low`    | Export the board as a Specctra DSN file (PCB_ManufactureData.getDsnFile) — an open, vendor-neutral format supported by external autorouters such as FreeRouting. Re-import the routed result through EasyEDA Pro's own SES/DSN import, not through this server.                                                                  |
| `easyeda_pcb_floorplan`                 | `full`  | `high`   | Translate CircuitIR physical constraints (keepouts, top/bottom side, connector-edge, thermal spacing) into a component group placement plan, then optionally apply it. CircuitIR devices carry no physical dimensions, so widths/heights must be supplied per device (confirmWrite required).                                    |
| `easyeda_pcb_modify_component`          | `full`  | `high`   | Modify component properties in the PCB layout.                                                                                                                                                                                                                                                                                   |
| `easyeda_pcb_place_component`           | `full`  | `high`   | Place a component footprint on the active PCB layout. CAUTION: the native create() call needs 6 args but this tool sends only 5 (footprint, x, y, rotation, layer) — live-confirmed mismatch, not yet resolved. Verify placement visually before trusting it.                                                                    |
| `easyeda_pcb_place_component_group`     | `full`  | `high`   | Create a high-level, constraint-checked placement plan for a group of components and optionally apply it after explicit confirmation.                                                                                                                                                                                            |
| `easyeda_pcb_production_review`         | `core`  | `medium` | Run fabrication, assembly, and testability production review rules for PCB handoff. Reports severity-ranked DFM/DFA/DFT findings with actionable remediation before Gerber export or manufacturing submission.                                                                                                                   |
| `easyeda_pcb_route_path_plan`           | `full`  | `high`   | Create a high-level, constraint-checked route path plan for one net and optionally apply it after explicit confirmation.                                                                                                                                                                                                         |
| `easyeda_pcb_tracks`                    | `core`  | `low`    | List copper track segments on the active PCB layout: primitiveId, net, layer, start/end coordinates, width. A multi-point track drawn by add_track appears as several consecutive segments sharing one net. Returns an empty list (not an error) if no PCB tab is focused.                                                       |
| `easyeda_pcb_vias`                      | `core`  | `low`    | List vias on the active PCB layout: primitiveId, net, position, hole/outer diameter (native unit, same scale as x/y — not independently verified against a known physical dimension). Requires a focused PCB tab — returns an empty list (not an error) if none is active.                                                       |
| `easyeda_power_tree_analyze`            | `core`  | `medium` | Analyze supply sources, regulators, loads, protection, bulk capacitance, current budget, dropout, and regulator thermal risk. Returns machine-readable issues and a human-readable summary.                                                                                                                                      |
| `easyeda_production_qa_artifacts`       | `pro`   | `low`    | Generate testpoint checklist, assembly notes, bring-up plan, production QA checklist, and machine-readable QA manifest for board handoff.                                                                                                                                                                                        |
| `easyeda_project_save`                  | `core`  | `medium` | Explicitly save the current EasyEDA Pro project. This ensures all netlist changes, net flags, pin connections, and other mutations are persisted to the project file. Save is never implicit — the caller must explicitly request it. Requires confirmWrite.                                                                     |
| `easyeda_rule_check_summary`            | `core`  | `low`    | Get a summary of all design and electrical rule check results for the project.                                                                                                                                                                                                                                                   |
| `easyeda_run_self_test`                 | `core`  | `low`    | Run internal self-test to verify server integrity, config, and bridge connectivity.                                                                                                                                                                                                                                              |
| `easyeda_schematic_add_wire`            | `core`  | `medium` | Add a wire connecting schematic coordinates/pins — real native connectivity. Same `netName` connects pins globally: separate stubs sharing one name merge into one net (no label needed). NET_COLLISION guards touching another net's wire, but checks only wires — crossing a pin/flag coordinate still shorts it.              |
| `easyeda_schematic_component_pins`      | `core`  | `low`    | Get exact pin numbers, names, and coordinates for a schematic component by its primitive ID.                                                                                                                                                                                                                                     |
| `easyeda_schematic_components`          | `core`  | `low`    | List schematic components: primitiveId, reference, value, footprint, x/y/rotation, and device identity for cloning — deviceUuid+deviceLibraryUuid (a place_component deviceItem in this project), deviceName, symbolName, lcsc, manufacturerId.                                                                                  |
| `easyeda_schematic_connect_pin_to_net`  | `core`  | `medium` | Create real EasyEDA connectivity for a pin: draws a short wire stub from its exact coordinate, tagged with netName. Same-netName wires merge globally, so this joins the pin to everything else on that net — visible to ERC, ratsnest, and autorouting.                                                                         |
| `easyeda_schematic_connect_pins_by_net` | `core`  | `medium` | Bulk variant of connect_pin_to_net: draws a real wire stub from each pin, tagged with netName, so all listed pins (and anything else already on that net) merge into one net. Visible to ERC, ratsnest, and autorouting. A pin that fails (e.g. collision) is reported in failures rather than aborting the batch.               |
| `easyeda_schematic_create_net_flag`     | `core`  | `medium` | Create a named net flag/label. With `identification` (Power/Ground/AnalogGround/ProtectGround) it places a power-flag symbol binding to a coincident pin (use for VCC/GND). Without it, a generic net label — cosmetic only; connect pins with add_wire stubs sharing one netName.                                               |
| `easyeda_schematic_create_net_port`     | `core`  | `medium` | Place a hierarchical net port (off-sheet connector) on the schematic. Net ports create named connections that span multiple schematic sheets, appearing as real SCH_Net entries in the netlist.                                                                                                                                  |
| `easyeda_schematic_delete_primitive`    | `core`  | `medium` | Delete components, wires, or other drawing objects from the schematic by their primitive UUIDs.                                                                                                                                                                                                                                  |
| `easyeda_schematic_modify_primitive`    | `core`  | `medium` | Modify a schematic component/object: only fields in property change; others are read back and preserved, so partial updates never wipe unrelated data. Also moves net flags/ports — pass x/y, rotation 0/90/180/270, or mirror to shift a VCC/GND flag label off a crowded pin, keeping it over its wire.                        |
| `easyeda_schematic_net_detail`          | `core`  | `low`    | Get full details for a specific net in the schematic including all connected pins and components.                                                                                                                                                                                                                                |
| `easyeda_schematic_nets`                | `core`  | `low`    | List all nets in the schematic with their node connections.                                                                                                                                                                                                                                                                      |
| `easyeda_schematic_place_component`     | `core`  | `medium` | Place a library component/device on the active schematic sheet. The bridge auto-assigns the next free designator ("R?" → "R1", "R2", …); check the returned designator. If annotation fails, fix the placeholder via modify_primitive — the netlist keys nodes by designator, so duplicate "R?" merge into one node.             |
| `easyeda_schematic_search_device`       | `core`  | `low`    | Search for schematic symbols/devices in the EasyEDA library by keywords.                                                                                                                                                                                                                                                         |
| `easyeda_schematic_sheet_info`          | `core`  | `low`    | Return read-only active schematic sheet metadata including page size, frame, origin, and grid hints for safer component placement.                                                                                                                                                                                               |
| `easyeda_schematic_validate_netlist`    | `core`  | `low`    | Validate the schematic netlist: inferred nets, connected refs/pins, floating pins, plus a cross-check with native ERC (native_erc). `valid` needs BOTH the inference clean AND native ERC 0 errors — inference alone false-positives when pins overlap without a wire.                                                           |
| `easyeda_schematic_verify_write`        | `core`  | `low`    | Read back schematic state after an agent-authored write. Returns component-count delta evidence and optional netlist validation so agents can confirm a placement or connection before continuing.                                                                                                                               |
| `easyeda_schematic_wires`               | `core`  | `low`    | List wire segments: primitiveId, line coordinates, net name, color, style. Page with offset (check total) past the 50-wire-per-call cap. primitiveId is required by delete_primitive/modify_primitive — schematic_nets alone cannot resolve a wire ID.                                                                           |
| `easyeda_semantic_erc_validate`         | `core`  | `medium` | Run semantic electrical-rule validation over a netlist with pin electrical types to detect output contention, floating inputs, power conflicts, missing power pins, missing decoupling, and voltage-domain mismatches.                                                                                                           |
| `easyeda_simulate_operating_point`      | `pro`   | `low`    | Translate a typed circuit description into a SPICE deck and run an offline ngspice operating-point (.op) simulation, optionally checking rail node voltages against a spec. Read-only, local-only. Reports a capability gap rather than failing when ngspice is absent.                                                          |
| `easyeda_simulate_transient`            | `pro`   | `low`    | Translate a typed circuit description into a SPICE deck and run an offline ngspice transient (.tran) simulation, optionally checking the final rail voltage against a spec. Read-only, local-only. Reports a capability gap rather than failing when ngspice is absent.                                                          |
| `easyeda_wire_probe`                    | `dev`   | `low`    | Inspect live schematic wire objects, including line coordinates, net names, methods, and state getter values, to validate EasyEDA runtime mappings.                                                                                                                                                                              |
| `easyeda_workflow_connector_breakout`   | `pro`   | `medium` | Place a connector, wire each declared pin to its net, and create a net port for each net so the breakout is accessible off-sheet — all as a single atomic transaction (confirmWrite required).                                                                                                                                   |
| `easyeda_workflow_decouple_ic`          | `pro`   | `medium` | Place one decoupling capacitor per declared IC power pin and wire each to the pin's net and ground, in a single atomic transaction. Cites design-rules decoupling guidance (rule-of-thumb, not datasheet-specific) alongside the plan (confirmWrite required).                                                                   |
| `easyeda_workflow_place_block`          | `pro`   | `medium` | Place a group of components, wire their pin-to-net connections (new and/or pre-existing components), and create net ports for block-external nets — all as a single atomic transaction with rollback on partial failure (confirmWrite required).                                                                                 |
| `easyeda_workflow_power_rail`           | `pro`   | `medium` | Place a regulator and its supporting passives and wire them to input/output/ground nets in a single atomic transaction, instead of one primitive call per component. Caller supplies already-resolved device items and pin connections; this tool does not select parts (confirmWrite required).                                 |

---

## `easyeda_api_call`

**Profile:** `full` | **Risk Level:** `high`

> Controlled call to a documented EasyEDA class method by path, for example SCH_PrimitiveWire.getAll. This is not raw JavaScript execution.

### Input Parameters

| Parameter      | Type      | Required | Description |
| -------------- | --------- | -------- | ----------- |
| `path`         | `string`  | Yes      |             |
| `args`         | `any[]`   | Yes      |             |
| `confirmWrite` | `boolean` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  ok: boolean;
  path: string;
  resolvedPath: string(optional);
  result: any(optional);
  error: string(optional);
  requires_confirmation: boolean(optional);
}
```

---

## `easyeda_api_inventory`

**Profile:** `core` | **Risk Level:** `low`

> Inspect the live EasyEDA extension runtime and list available documented API classes, runtime paths, and methods.

### Input Parameters

| Parameter | Type                | Required | Description |
| --------- | ------------------- | -------- | ----------- |
| `filter`  | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  classes: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_board_dimensions`

**Profile:** `core` | **Risk Level:** `low`

> Get the PCB board outline dimensions, shape, and mounting hole information.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  width_mm: number(optional);
  height_mm: number(optional);
  shape: string(optional);
  mounting_hole_count: number;
  area_mm2: number(optional);
  not_available: boolean(optional);
}
```

---

## `easyeda_board_features`

**Profile:** `core` | **Risk Level:** `low`

> Get counts of board features including vias, tracks, copper zones, and pads.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  vias: number;
  tracks: number;
  zones: number;
  pads: number;
  components: number(optional);
  not_available: boolean(optional);
}
```

---

## `easyeda_board_layers`

**Profile:** `core` | **Risk Level:** `low`

> List all layers in the PCB design including signal, power, plane, and mechanical layers.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  layers: object[];
  total: number;
  not_available: boolean (optional);
}
```

---

## `easyeda_board_stackup`

**Profile:** `core` | **Risk Level:** `low`

> Get the PCB layer stackup including thickness, material, and dielectric constants.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  total_layers: number;
  board_thickness_mm: number (optional);
  layers: object[];
  not_available: boolean (optional);
}
```

---

## `easyeda_bom_export`

**Profile:** `core` | **Risk Level:** `low`

> Export the bill of materials to a file on disk in the specified format.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `format`    | `'csv'   | 'json'   | 'xlsx'`     | Yes |     |
| `filePath`  | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  format: string;
  file_path: string;
  exported: boolean;
  entry_count: number(optional);
  not_available: boolean(optional);
}
```

---

## `easyeda_bom_generate`

**Profile:** `core` | **Risk Level:** `low`

> Generate a bill of materials for the project with grouping and formatting options.

### Input Parameters

| Parameter   | Type     | Required | Description  |
| ----------- | -------- | -------- | ------------ |
| `projectId` | `string` | Yes      |              |
| `format`    | `'csv'   | 'json'   | 'xlsx'`      | Yes |     |
| `groupBy`   | `'value' | 'lcsc'   | 'footprint'` | Yes |     |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  format: string;
  group_by: string;
  entries: object[];
  total_entries: number;
  not_available: boolean (optional);
}
```

---

## `easyeda_bom_quality_report`

**Profile:** `core` | **Risk Level:** `medium`

> Generate a BOM quality report that identifies unavailable, single-source, missing-MPN, missing-footprint, and low-stock items across configured suppliers.

### Input Parameters

| Parameter                   | Type                 | Required | Description |
| --------------------------- | -------------------- | -------- | ----------- |
| `projectId`                 | `string`             | Yes      |             |
| `low_stock_threshold`       | `number (optional)`  | No       |             |
| `require_mpn`               | `boolean (optional)` | No       |             |
| `require_footprint`         | `boolean (optional)` | No       |             |
| `stale_vendor_data_seconds` | `number (optional)`  | No       |             |
| `minimum_quality_score`     | `number (optional)`  | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  bom_id: string;
  generated_at: string;
  total_entries: number;
  summary: object;
  entries: object[];
  has_supplier_errors: boolean;
  not_available: boolean (optional);
}
```

---

## `easyeda_bom_sourcing`

**Profile:** `core` | **Risk Level:** `medium`

> Retrieve pricing and availability information for all parts in the project BOM from specified suppliers.

### Input Parameters

| Parameter   | Type                  | Required | Description |
| ----------- | --------------------- | -------- | ----------- |
| `projectId` | `string`              | Yes      |             |
| `suppliers` | `string[] (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  parts: object[];
  total_parts: number;
  keyless_sourcing_enabled: boolean (optional);
  not_available: boolean (optional);
}
```

---

## `easyeda_bom_validate`

**Profile:** `core` | **Risk Level:** `medium`

> Validate the project BOM against LCSC inventory to identify missing, obsolete, or alternate parts.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  total_parts: number;
  missing_lcsc: string[];
  invalid_lcsc: string[];
  obsolete: string[];
  valid_count: number;
  validated: boolean;
  not_available: boolean (optional);
}
```

---

## `easyeda_bridge_probe_methods`

**Profile:** `dev` | **Risk Level:** `medium`

> Query the EasyEDA Pro bridge for available API methods. Requires bridge connection. (dev/pro only)

### Input Parameters

| Parameter | Type                | Required | Description |
| --------- | ------------------- | -------- | ----------- |
| `filter`  | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  methods: object[];
  total: number;
  source: 'loader_status' | 'server_registry' (optional);
  dispatcher_build_id: string (optional);
}
```

---

## `easyeda_bridge_status`

**Profile:** `core` | **Risk Level:** `low`

> Check EasyEDA Pro bridge connection status, version, and capabilities.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  connected: boolean;
  bridge_version: string (optional);
  easyeda_version: string (optional);
  capabilities: string[] (optional);
  dev_mode: boolean (optional);
  last_heartbeat_ms: number (optional);
  uptime_ms: number (optional);
  status_error: string (optional);
  diagnostics: object (optional);
}
```

---

## `easyeda_canvas_capture`

**Profile:** `core` | **Risk Level:** `low`

> Capture the currently visible EasyEDA schematic/PCB canvas as a PNG image, so the caller can visually verify the result of a draw/place/route action. Captures the given tab (or the last-focused one) as-is; use easyeda_canvas_capture_region first to frame a specific area.

### Input Parameters

| Parameter | Type                | Required | Description |
| --------- | ------------------- | -------- | ----------- |
| `tabId`   | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  captured: boolean;
  mime_type: string(optional);
  file_name: string(optional);
  byte_length: number(optional);
  image_base64: string(optional);
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_canvas_capture_region`

**Profile:** `core` | **Risk Level:** `low`

> Zoom the EasyEDA canvas to a rectangular region (document/canvas coordinates) and capture it as a PNG, so the caller can visually verify a specific area. This moves the user's visible viewport — EasyEDA Pro has no offscreen rendering API.

### Input Parameters

| Parameter | Type                | Required | Description |
| --------- | ------------------- | -------- | ----------- |
| `left`    | `number`            | Yes      |             |
| `right`   | `number`            | Yes      |             |
| `top`     | `number`            | Yes      |             |
| `bottom`  | `number`            | Yes      |             |
| `tabId`   | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  captured: boolean;
  mime_type: string(optional);
  file_name: string(optional);
  byte_length: number(optional);
  image_base64: string(optional);
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_canvas_locate`

**Profile:** `core` | **Risk Level:** `low`

> Zoom the EasyEDA canvas to a coordinate/scale (document/canvas coordinates), returning the resulting viewport rectangle. Useful to frame a location before calling easyeda_canvas_capture, or standalone to navigate the user's view to a point of interest.

### Input Parameters

| Parameter    | Type                | Required | Description |
| ------------ | ------------------- | -------- | ----------- |
| `x`          | `number (optional)` | No       |             |
| `y`          | `number (optional)` | No       |             |
| `scaleRatio` | `number (optional)` | No       |             |
| `tabId`      | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  located: boolean;
  left: number(optional);
  right: number(optional);
  top: number(optional);
  bottom: number(optional);
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_catalog_list`

**Profile:** `pro` | **Risk Level:** `low`

> List devices cached by easyeda_catalog_verify_device, with their validation status and provenance. Optionally filter by status (resolved/partial/unresolved). This is a local cache only — never redistributed.

### Input Parameters

| Parameter | Type        | Required  | Description              |
| --------- | ----------- | --------- | ------------------------ |
| `status`  | `'resolved' | 'partial' | 'unresolved' (optional)` | No  |     |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  devices: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_catalog_verify_device`

**Profile:** `pro` | **Risk Level:** `medium`

> Resolve an LCSC part number into a catalog device entry (keyless LCSC metadata plus an EasyEDA symbol/footprint reference, if already known locally), validate it, and write it to the local device cache (confirmWrite required). Does NOT verify pin/pad geometry — see docs/catalog-ingestion.md.

### Input Parameters

| Parameter      | Type      | Required | Description |
| -------------- | --------- | -------- | ----------- |
| `lcscId`       | `string`  | Yes      |             |
| `confirmWrite` | `boolean` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  lcsc_id: string;
  status: 'resolved' | 'partial' | 'unresolved';
  valid: boolean;
  errors: object[];
  warnings: object[];
  provenance: object;
  entry: object;
  cached: boolean;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_component_probe`

**Profile:** `dev` | **Risk Level:** `low`

> Inspect live schematic component objects, including available methods and state getter values, to validate EasyEDA runtime mappings.

### Input Parameters

| Parameter | Type     | Required | Description |
| --------- | -------- | -------- | ----------- |
| `limit`   | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  total: number;
  samples: any[];
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_design_rules_lookup`

**Profile:** `core` | **Risk Level:** `low`

> Look up generic engineering reference guidance: IPC-2221 trace-width/current-capacity, clearance bands, protocol routing data (USB/RS-485/I2C/SPI/UART/Ethernet), decoupling recipes and bulk capacitance sizing, and a static DFM checklist. Every result cites a source and caveat: these are estimates, not certified values.

### Input Parameters

This tool accepts one of several shapes, selected by the `topic` field:

**When `topic` is 'trace-width':**

| Parameter          | Type            | Required    | Description |
| ------------------ | --------------- | ----------- | ----------- |
| `topic`            | `'trace-width'` | Yes         |             |
| `currentA`         | `number`        | Yes         |             |
| `temperatureRiseC` | `number`        | Yes         |             |
| `layer`            | `'external'     | 'internal'` | Yes         |     |
| `copperWeightOz`   | `number`        | Yes         |             |

**When `topic` is 'max-current':**

| Parameter          | Type            | Required    | Description |
| ------------------ | --------------- | ----------- | ----------- |
| `topic`            | `'max-current'` | Yes         |             |
| `traceWidthMils`   | `number`        | Yes         |             |
| `temperatureRiseC` | `number`        | Yes         |             |
| `layer`            | `'external'     | 'internal'` | Yes         |     |
| `copperWeightOz`   | `number`        | Yes         |             |

**When `topic` is 'clearance':**

| Parameter  | Type          | Required    | Description |
| ---------- | ------------- | ----------- | ----------- |
| `topic`    | `'clearance'` | Yes         |             |
| `voltageV` | `number`      | Yes         |             |
| `location` | `'external'   | 'internal'` | Yes         |     |

**When `topic` is 'protocol-routing':**

| Parameter  | Type                 | Required | Description |
| ---------- | -------------------- | -------- | ----------- |
| `topic`    | `'protocol-routing'` | Yes      |             |
| `protocol` | `'usb2'              | 'usb3'   | 'rs485'     | 'i2c' | 'spi' | 'uart' | 'ethernet-10-100' | 'ethernet-1000' (optional)` | No  |     |

**When `topic` is 'decoupling':**

| Parameter  | Type             | Required | Description |
| ---------- | ---------------- | -------- | ----------- |
| `topic`    | `'decoupling'`   | Yes      |             |
| `category` | `'digital-logic' | 'mcu'    | 'analog'    | 'rf' | 'crystal-oscillator' | 'power-regulator' (optional)` | No  |     |

**When `topic` is 'bulk-capacitance':**

| Parameter                  | Type                 | Required | Description |
| -------------------------- | -------------------- | -------- | ----------- |
| `topic`                    | `'bulk-capacitance'` | Yes      |             |
| `loadA`                    | `number`             | Yes      |             |
| `minBulkCapacitanceUfPerA` | `number (optional)`  | No       |             |
| `minBulkCapacitanceUf`     | `number (optional)`  | No       |             |

**When `topic` is 'dfm-checklist':**

| Parameter  | Type                | Required   | Description |
| ---------- | ------------------- | ---------- | ----------- |
| `topic`    | `'dfm-checklist'`   | Yes        |             |
| `category` | `'clearance'        | 'drilling' | 'copper'    | 'solder-mask' | 'silkscreen' | 'panelization' | 'assembly' (optional)` | No  |     |
| `id`       | `string (optional)` | No         |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  topic: string;
  traceWidth: object (optional);
  maxCurrent: object (optional);
  clearance: object (optional);
  protocolRouting: object (optional);
  protocolRoutingList: object[] (optional);
  decoupling: object (optional);
  decouplingList: object[] (optional);
  bulkCapacitance: object (optional);
  dfmChecklist: object[] (optional);
  dfmChecklistItem: object (optional);
  error: string (optional);
}
```

---

## `easyeda_drc_run`

**Profile:** `core` | **Risk Level:** `medium`

> Run the native design rule check (DRC): same as clicking "Check DRC" in EasyEDA Pro, so the bottom DRC panel opens/refreshes in the user's window as a visible side effect. Returns coarse per-severity counts only — which specific wire/net/component is affected is shown only in EasyEDA Pro's own DRC panel.

### Input Parameters

| Parameter   | Type                  | Required | Description |
| ----------- | --------------------- | -------- | ----------- |
| `projectId` | `string`              | Yes      |             |
| `rules`     | `string[] (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  violations: object[];
  total_violations: number;
  error_count: number;
  warning_count: number;
  passed: boolean;
  not_available: boolean (optional);
}
```

---

## `easyeda_erc_run`

**Profile:** `core` | **Risk Level:** `medium`

> Run the native electrical rule check (ERC): same as clicking "Check DRC" in EasyEDA Pro, so the bottom DRC panel opens/refreshes as a visible side effect. Returns coarse per-severity counts only — which wire/net/component is affected is shown only in EasyEDA Pro's own DRC panel.

### Input Parameters

| Parameter   | Type                  | Required | Description |
| ----------- | --------------------- | -------- | ----------- |
| `projectId` | `string`              | Yes      |             |
| `checks`    | `string[] (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  violations: object[];
  total_violations: number;
  error_count: number;
  warning_count: number;
  passed: boolean;
  not_available: boolean (optional);
}
```

---

## `easyeda_export_gerbers`

**Profile:** `core` | **Risk Level:** `medium`

> Export PCB design to Gerber files for PCB fabrication.

### Input Parameters

| Parameter          | Type                  | Required     | Description        |
| ------------------ | --------------------- | ------------ | ------------------ |
| `projectId`        | `string`              | Yes          |                    |
| `filePath`         | `string (optional)`   | No           |                    |
| `drillFormat`      | `'excellon'           | 'millimeter' | 'inch' (optional)` | No  |     |
| `excludeLayer`     | `string[] (optional)` | No           |                    |
| `ledPanel`         | `boolean (optional)`  | No           |                    |
| `productionReview` | `object (optional)`   | No           |                    |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  artifact_path: string(optional);
  byte_length: number(optional);
  file_count: number(optional);
  exported: boolean;
  blocked_by_production_review: boolean(optional);
  production_review: object(optional);
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_export_netlist`

**Profile:** `pro` | **Risk Level:** `low`

> Export the schematic netlist in a specified EDA tool format (PADS, Allegro, or Altium).

### Input Parameters

| Parameter   | Type                | Required  | Description |
| ----------- | ------------------- | --------- | ----------- |
| `projectId` | `string`            | Yes       |             |
| `format`    | `'pads'             | 'allegro' | 'altium'`   | Yes |     |
| `filePath`  | `string (optional)` | No        |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  format: string;
  file_path: string(optional);
  byte_length: number(optional);
  net_count: number(optional);
  exported: boolean;
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_export_pdf`

**Profile:** `pro` | **Risk Level:** `low`

> Export the schematic and/or board layout to PDF.

### Input Parameters

| Parameter     | Type                | Required     | Description |
| ------------- | ------------------- | ------------ | ----------- |
| `projectId`   | `string`            | Yes          |             |
| `scope`       | `'schematic'        | 'board'      | 'both'`     | Yes |     |
| `orientation` | `'portrait'         | 'landscape'` | Yes         |     |
| `filePath`    | `string (optional)` | No           |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  scope: string;
  orientation: string;
  file_path: string(optional);
  byte_length: number(optional);
  pages: number(optional);
  exported: boolean;
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_export_pick_place`

**Profile:** `pro` | **Risk Level:** `low`

> Export pick-and-place (centroid) file for PCB assembly. Contains component reference, position, rotation, and layer.

### Input Parameters

| Parameter   | Type                | Required | Description |
| ----------- | ------------------- | -------- | ----------- |
| `projectId` | `string`            | Yes      |             |
| `format`    | `'csv'              | 'txt'`   | Yes         |     |
| `filePath`  | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  format: string;
  file_path: string(optional);
  byte_length: number(optional);
  component_count: number(optional);
  exported: boolean;
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_get_capabilities`

**Profile:** `core` | **Risk Level:** `low`

> Return server capabilities, including available profiles, enabled feature flags, and supported operations.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  server_name: string;
  server_version: string;
  protocol_version: string;
  profiles: object[];
  current_profile: string;
  feature_flags: Record<string, boolean>;
  transports: string[];
}
```

---

## `easyeda_get_feature_flags`

**Profile:** `core` | **Risk Level:** `low`

> Return current feature flag values.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  flags: Record<string, boolean>;
}
```

---

## `easyeda_get_server_config`

**Profile:** `core` | **Risk Level:** `low`

> Return safe (redacted) server configuration. Secrets are never exposed.

### Input Parameters

| Parameter       | Type      | Required | Description |
| --------------- | --------- | -------- | ----------- |
| `include_flags` | `boolean` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  node_env: string;
  log_level: string;
  profile: string;
  transport: string;
  bridge_host: string;
  bridge_port: number;
  mcp_protocol_version: string;
  flags: Record<string, boolean>(optional);
}
```

---

## `easyeda_get_tool_profiles`

**Profile:** `core` | **Risk Level:** `low`

> List available tool profiles and their descriptions.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  current: string;
  profiles: object[];
}
```

---

## `easyeda_health_check`

**Profile:** `core` | **Risk Level:** `low`

> Return server health status in one call: runtime version, active profile, bridge state, EasyEDA version, keyless sourcing state, and starter catalog size. Intended as the single actionable status check after first connecting the bridge extension.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  status: 'ok' | 'degraded' | 'unavailable';
  version: string;
  node_version: string;
  profile: string;
  transport: string;
  bridge_connected: boolean;
  easyeda_version: string(optional);
  extension_version: string(optional);
  extension_version_mismatch: boolean;
  registry_mismatch: boolean;
  keyless_sourcing_enabled: boolean;
  catalog_device_count: number;
  ups: number;
}
```

---

## `easyeda_jlcpcb_quote_workflow`

**Profile:** `pro` | **Risk Level:** `medium`

> Prepare a non-binding JLCPCB quote workflow snapshot with explicit human-review gates and audit evidence. This tool never places orders or performs paid operations.

### Input Parameters

| Parameter                | Type                 | Required       | Description    |
| ------------------------ | -------------------- | -------------- | -------------- |
| `provider`               | `'jlcpcb'            | 'custom'`      | Yes            |     |
| `action`                 | `'estimate'          | 'verify_quote' | 'place_order'` | Yes |     |
| `projectId`              | `string (optional)`  | No             |                |
| `board`                  | `object`             | Yes            |                |
| `quote`                  | `object (optional)`  | No             |                |
| `confirmation`           | `object (optional)`  | No             |                |
| `vendorTermsReviewed`    | `boolean (optional)` | No             |                |
| `productionFilesReady`   | `boolean (optional)` | No             |                |
| `exportManifestVerified` | `boolean (optional)` | No             |                |
| `productionReviewPassed` | `boolean (optional)` | No             |                |
| `allowedPaidOperations`  | `boolean (optional)` | No             |                |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  provider: string;
  action: string;
  project_id: string;
  status: string;
  allowed: boolean;
  quote: object;
  risk: object;
  issues: object[];
  audit: object;
  summary: string;
  unsupported_operations: string[];
}
```

---

## `easyeda_live_smoke_report`

**Profile:** `dev` | **Risk Level:** `low`

> Run a read-only live smoke report against the connected EasyEDA bridge and return status, API inventory, components, wires, and schematic nets in one response.

### Input Parameters

| Parameter    | Type      | Required | Description |
| ------------ | --------- | -------- | ----------- |
| `projectId`  | `string`  | Yes      |             |
| `limit`      | `number`  | Yes      |             |
| `includeRaw` | `boolean` | Yes      |             |
| `timeoutMs`  | `number`  | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  ok: boolean;
  project_id: string;
  generated_at: string;
  checks: object[];
  summary: object;
  raw: object (optional);
}
```

---

## `easyeda_observability_report`

**Profile:** `core` | **Risk Level:** `low`

> Return latency budgets, runtime metrics, cache/vendor timing snapshot, and storage retention policy for performance diagnostics.

### Input Parameters

| Parameter             | Type      | Required | Description |
| --------------------- | --------- | -------- | ----------- |
| `includeRecentEvents` | `boolean` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  generated_at: string;
  server_version: string;
  budgets: object[];
  metrics: object;
  retention: object;
  timeout_policy: object;
}
```

---

## `easyeda_pcb_add_track`

**Profile:** `full` | **Risk Level:** `high`

> Draw a copper track/trace on the PCB board. A multi-point path is written as one line segment per consecutive point pair (all sharing netName, so they form one electrical track — same coordinate/name merge model as schematic wires).

### Input Parameters

| Parameter      | Type                | Required | Description |
| -------------- | ------------------- | -------- | ----------- |
| `points`       | `object[]`          | Yes      |             |
| `layer`        | `number`            | Yes      |             |
| `width`        | `number`            | Yes      |             |
| `netName`      | `string (optional)` | No       |             |
| `confirmWrite` | `'true'`            | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  primitiveId: string (optional);
  primitiveIds: string[] (optional);
  error: string (optional);
}
```

---

## `easyeda_pcb_add_via`

**Profile:** `full` | **Risk Level:** `high`

> Place a via to connect different copper layers on the PCB board. outerDiameter/holeSize are passed through to the native API unconverted (same native unit as x/y) — their real-world scale was not independently verified against a known physical dimension, so confirm the resulting via size visually before trusting it.

### Input Parameters

| Parameter       | Type                | Required | Description |
| --------------- | ------------------- | -------- | ----------- |
| `x`             | `number`            | Yes      |             |
| `y`             | `number`            | Yes      |             |
| `outerDiameter` | `number`            | Yes      |             |
| `holeSize`      | `number`            | Yes      |             |
| `netName`       | `string (optional)` | No       |             |
| `confirmWrite`  | `'true'`            | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  primitiveId: string(optional);
  error: string(optional);
}
```

---

## `easyeda_pcb_add_zone`

**Profile:** `full` | **Risk Level:** `high`

> Create a copper pour zone on a layer with clearance settings. CAUTION: the native create() call needs 9 args but this tool sends only 4 (points, layer, netName, clearance) — live-confirmed mismatch, not yet resolved. Verify visually before trusting it.

### Input Parameters

| Parameter      | Type                | Required | Description |
| -------------- | ------------------- | -------- | ----------- |
| `points`       | `object[]`          | Yes      |             |
| `layer`        | `number`            | Yes      |             |
| `netName`      | `string (optional)` | No       |             |
| `clearance`    | `number (optional)` | No       |             |
| `confirmWrite` | `'true'`            | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  primitiveId: string(optional);
  error: string(optional);
}
```

---

## `easyeda_pcb_autoroute`

**Profile:** `pro` | **Risk Level:** `high`

> Drive EasyEDA Pro's native autorouter (PCB_Document.autoRouting, a @beta API) after a pre-flight constraint check, then run DRC and a constraint report before reporting success. Never reports success without that evidence attached (confirmWrite required).

### Input Parameters

| Parameter               | Type                  | Required             | Description          |
| ----------------------- | --------------------- | -------------------- | -------------------- |
| `projectId`             | `string`              | Yes                  |                      |
| `routingNets`           | `'selected'           | 'selectedComponents' | string[] (optional)` | No  |     |
| `cornerStyle`           | `'45'                 | '90' (optional)`     | No                   |     |
| `existingPrimitiveMode` | `'keep'               | 'remove' (optional)` | No                   |     |
| `optimization`          | `'completion'         | 'faster' (optional)` | No                   |     |
| `layers`                | `number[] (optional)` | No                   |                      |
| `ignoreNets`            | `string[] (optional)` | No                   |                      |
| `boardData`             | `object (optional)`   | No                   |                      |
| `confirmWrite`          | `boolean (optional)`  | No                   |                      |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  overall_verdict: 'success' | 'partial' | 'blocked' | 'failed';
  blocked_by_preflight: boolean;
  preflight: object(optional);
  autoroute_result: object(optional);
  post_route_drc: object(optional);
  post_route_constraint_report: object(optional);
  summary: string;
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_pcb_components`

**Profile:** `core` | **Risk Level:** `low`

> List components placed on the active PCB layout: primitiveId, designator, footprint identity, position/rotation/layer. Requires a focused PCB tab in EasyEDA Pro — returns an empty list (not an error) if none is active.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `limit`     | `number` | Yes      |             |
| `offset`    | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  components: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_pcb_constraint_check`

**Profile:** `core` | **Risk Level:** `low`

> Run PCB constraint validation against the board design. Checks board outline, layer stackup, net classes, clearance rules, keepout areas, placement zones, mounting holes, fiducials, and manufacturing constraints.

### Input Parameters

| Parameter   | Type                | Required | Description |
| ----------- | ------------------- | -------- | ----------- |
| `projectId` | `string`            | Yes      |             |
| `boardData` | `object (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  valid: boolean;
  errors: object[];
  warnings: object[];
  summary: object;
  not_available: boolean (optional);
}
```

---

## `easyeda_pcb_constraint_report`

**Profile:** `core` | **Risk Level:** `low`

> Generate a human-readable report explaining which PCB constraints were applied and which require manual review.

### Input Parameters

| Parameter   | Type                | Required | Description |
| ----------- | ------------------- | -------- | ----------- |
| `projectId` | `string`            | Yes      |             |
| `boardData` | `object (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  verdict: string;
  checked: object[];
  manualReviewRequired: object[];
  not_available: boolean (optional);
}
```

---

## `easyeda_pcb_delete_component`

**Profile:** `full` | **Risk Level:** `high`

> Delete components, tracks, vias, or other PCB primitives by ID. Checks each id against every deletable PCB class instead of assuming component, since PCB_PrimitiveComponent.delete() reports success for ids it does not own without deleting them.

### Input Parameters

| Parameter      | Type       | Required | Description |
| -------------- | ---------- | -------- | ----------- |
| `primitiveIds` | `string[]` | Yes      |             |
| `confirmWrite` | `'true'`   | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  deletedCount: number (optional);
  deleted: string[] (optional);
  notFound: string[] (optional);
  error: string (optional);
}
```

---

## `easyeda_pcb_export_route_context`

**Profile:** `pro` | **Risk Level:** `low`

> Export the board as a Specctra DSN file (PCB_ManufactureData.getDsnFile) — an open, vendor-neutral format supported by external autorouters such as FreeRouting. Re-import the routed result through EasyEDA Pro's own SES/DSN import, not through this server.

### Input Parameters

| Parameter   | Type                | Required | Description |
| ----------- | ------------------- | -------- | ----------- |
| `projectId` | `string`            | Yes      |             |
| `filePath`  | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  artifact_path: string(optional);
  byte_length: number(optional);
  exported: boolean;
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_pcb_floorplan`

**Profile:** `full` | **Risk Level:** `high`

> Translate CircuitIR physical constraints (keepouts, top/bottom side, connector-edge, thermal spacing) into a component group placement plan, then optionally apply it. CircuitIR devices carry no physical dimensions, so widths/heights must be supplied per device (confirmWrite required).

### Input Parameters

| Parameter                          | Type                 | Required | Description |
| ---------------------------------- | -------------------- | -------- | ----------- |
| `circuitIR`                        | `any`                | Yes      |             |
| `devices`                          | `object[]`           | Yes      |             |
| `projectId`                        | `string (optional)`  | No       |             |
| `mode`                             | `'preview'           | 'apply'` | Yes         |                     |
| `board`                            | `object`             | Yes      |             |
| `anchor`                           | `object`             | Yes      |             |
| `columns`                          | `number (optional)`  | No       |             |
| `spacingMm`                        | `number (optional)`  | No       |             |
| `minSpacingMm`                     | `number (optional)`  | No       |             |
| `topLayer`                         | `number (optional)`  | No       |             |
| `bottomLayer`                      | `number (optional)`  | No       |             |
| `connectorEdge`                    | `'top'               | 'bottom' | 'left'      | 'right' (optional)` | No  |     |
| `connectorEdgeMarginMm`            | `number (optional)`  | No       |             |
| `thermalSpacingBoostMm`            | `number (optional)`  | No       |             |
| `thermalDissipationThresholdWatts` | `number (optional)`  | No       |             |
| `confirmWrite`                     | `boolean (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  placements: object[];
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  floorplan_notes: string[];
  summary: string;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_pcb_modify_component`

**Profile:** `full` | **Risk Level:** `high`

> Modify component properties in the PCB layout.

### Input Parameters

| Parameter      | Type                  | Required | Description |
| -------------- | --------------------- | -------- | ----------- |
| `primitiveId`  | `string`              | Yes      |             |
| `property`     | `Record<string, any>` | Yes      |             |
| `confirmWrite` | `'true'`              | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  error: string(optional);
}
```

---

## `easyeda_pcb_place_component`

**Profile:** `full` | **Risk Level:** `high`

> Place a component footprint on the active PCB layout. CAUTION: the native create() call needs 6 args but this tool sends only 5 (footprint, x, y, rotation, layer) — live-confirmed mismatch, not yet resolved. Verify placement visually before trusting it.

### Input Parameters

| Parameter      | Type     | Required | Description |
| -------------- | -------- | -------- | ----------- |
| `footprint`    | `string` | Yes      |             |
| `x`            | `number` | Yes      |             |
| `y`            | `number` | Yes      |             |
| `rotation`     | `number` | Yes      |             |
| `layer`        | `number` | Yes      |             |
| `confirmWrite` | `'true'` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  primitiveId: string(optional);
  error: string(optional);
}
```

---

## `easyeda_pcb_place_component_group`

**Profile:** `full` | **Risk Level:** `high`

> Create a high-level, constraint-checked placement plan for a group of components and optionally apply it after explicit confirmation.

### Input Parameters

| Parameter      | Type                  | Required | Description |
| -------------- | --------------------- | -------- | ----------- |
| `projectId`    | `string (optional)`   | No       |             |
| `mode`         | `'preview'            | 'apply'` | Yes         |     |
| `board`        | `object`              | Yes      |             |
| `anchor`       | `object`              | Yes      |             |
| `columns`      | `number (optional)`   | No       |             |
| `spacingMm`    | `number (optional)`   | No       |             |
| `layer`        | `number`              | Yes      |             |
| `minSpacingMm` | `number (optional)`   | No       |             |
| `components`   | `object[]`            | Yes      |             |
| `keepouts`     | `object[] (optional)` | No       |             |
| `confirmWrite` | `boolean (optional)`  | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  placements: object[];
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  summary: string;
  error: string (optional);
}
```

---

## `easyeda_pcb_production_review`

**Profile:** `core` | **Risk Level:** `medium`

> Run fabrication, assembly, and testability production review rules for PCB handoff. Reports severity-ranked DFM/DFA/DFT findings with actionable remediation before Gerber export or manufacturing submission.

### Input Parameters

| Parameter   | Type                | Required | Description |
| ----------- | ------------------- | -------- | ----------- |
| `projectId` | `string`            | Yes      |             |
| `boardData` | `object (optional)` | No       |             |
| `gateMode`  | `'warn'             | 'block'  | 'off'`      | Yes |     |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  passed: boolean;
  blocked: boolean;
  gate_mode: string;
  severity_counts: object;
  errors: object[];
  warnings: object[];
  summary: object;
  not_available: boolean (optional);
}
```

---

## `easyeda_pcb_route_path_plan`

**Profile:** `full` | **Risk Level:** `high`

> Create a high-level, constraint-checked route path plan for one net and optionally apply it after explicit confirmation.

### Input Parameters

| Parameter      | Type                  | Required | Description |
| -------------- | --------------------- | -------- | ----------- |
| `projectId`    | `string (optional)`   | No       |             |
| `mode`         | `'preview'            | 'apply'` | Yes         |     |
| `board`        | `object (optional)`   | No       |             |
| `netName`      | `string`              | Yes      |             |
| `layer`        | `number`              | Yes      |             |
| `widthMm`      | `number`              | Yes      |             |
| `waypoints`    | `object[]`            | Yes      |             |
| `keepouts`     | `object[] (optional)` | No       |             |
| `maxLengthMm`  | `number (optional)`   | No       |             |
| `minWidthMm`   | `number (optional)`   | No       |             |
| `confirmWrite` | `boolean (optional)`  | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  net_name: string;
  layer: number;
  width_mm: number;
  path_length_mm: number;
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  summary: string;
  error: string (optional);
}
```

---

## `easyeda_pcb_tracks`

**Profile:** `core` | **Risk Level:** `low`

> List copper track segments on the active PCB layout: primitiveId, net, layer, start/end coordinates, width. A multi-point track drawn by add_track appears as several consecutive segments sharing one net. Returns an empty list (not an error) if no PCB tab is focused.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `limit`     | `number` | Yes      |             |
| `offset`    | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  tracks: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_pcb_vias`

**Profile:** `core` | **Risk Level:** `low`

> List vias on the active PCB layout: primitiveId, net, position, hole/outer diameter (native unit, same scale as x/y — not independently verified against a known physical dimension). Requires a focused PCB tab — returns an empty list (not an error) if none is active.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `limit`     | `number` | Yes      |             |
| `offset`    | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  vias: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_power_tree_analyze`

**Profile:** `core` | **Risk Level:** `medium`

> Analyze supply sources, regulators, loads, protection, bulk capacitance, current budget, dropout, and regulator thermal risk. Returns machine-readable issues and a human-readable summary.

### Input Parameters

| Parameter     | Type                  | Required | Description |
| ------------- | --------------------- | -------- | ----------- |
| `projectId`   | `string (optional)`   | No       |             |
| `rails`       | `object[]`            | Yes      |             |
| `sources`     | `object[] (optional)` | No       |             |
| `regulators`  | `object[] (optional)` | No       |             |
| `loads`       | `object[] (optional)` | No       |             |
| `protections` | `object[] (optional)` | No       |             |
| `capacitors`  | `object[] (optional)` | No       |             |
| `limits`      | `object (optional)`   | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  passed: boolean;
  rails: object[];
  regulators: object[];
  issues: object[];
  summary: object;
}
```

---

## `easyeda_production_qa_artifacts`

**Profile:** `pro` | **Risk Level:** `low`

> Generate testpoint checklist, assembly notes, bring-up plan, production QA checklist, and machine-readable QA manifest for board handoff.

### Input Parameters

| Parameter                | Type                  | Required | Description |
| ------------------------ | --------------------- | -------- | ----------- |
| `projectId`              | `string (optional)`   | No       |             |
| `projectName`            | `string (optional)`   | No       |             |
| `revision`               | `string (optional)`   | No       |             |
| `criticalNets`           | `object[] (optional)` | No       |             |
| `components`             | `object[] (optional)` | No       |             |
| `requiresProgramming`    | `boolean (optional)`  | No       |             |
| `programmingInterfaces`  | `string[] (optional)` | No       |             |
| `hasProgrammingAccess`   | `boolean (optional)`  | No       |             |
| `hasBattery`             | `boolean (optional)`  | No       |             |
| `requiresFunctionalTest` | `boolean (optional)`  | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  project_name: string (optional);
  revision: string (optional);
  passed: boolean;
  issues: object[];
  checklist: object[];
  artifacts: object[];
  summary: object;
}
```

---

## `easyeda_project_save`

**Profile:** `core` | **Risk Level:** `medium`

> Explicitly save the current EasyEDA Pro project. This ensures all netlist changes, net flags, pin connections, and other mutations are persisted to the project file. Save is never implicit — the caller must explicitly request it. Requires confirmWrite.

### Input Parameters

| Parameter      | Type     | Required | Description                      |
| -------------- | -------- | -------- | -------------------------------- |
| `projectId`    | `string` | Yes      | The project/schematic ID to save |
| `confirmWrite` | `'true'` | Yes      |                                  |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  saved_at: string(optional);
  error: string(optional);
}
```

---

## `easyeda_rule_check_summary`

**Profile:** `core` | **Risk Level:** `low`

> Get a summary of all design and electrical rule check results for the project.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  drc: object;
  erc: object;
  overall_passed: boolean;
  not_available: boolean(optional);
}
```

---

## `easyeda_run_self_test`

**Profile:** `core` | **Risk Level:** `low`

> Run internal self-test to verify server integrity, config, and bridge connectivity.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  passed: boolean;
  checks: object[];
}
```

---

## `easyeda_schematic_add_wire`

**Profile:** `core` | **Risk Level:** `medium`

> Add a wire connecting schematic coordinates/pins — real native connectivity. Same `netName` connects pins globally: separate stubs sharing one name merge into one net (no label needed). NET_COLLISION guards touching another net's wire, but checks only wires — crossing a pin/flag coordinate still shorts it.

### Input Parameters

| Parameter      | Type                | Required | Description |
| -------------- | ------------------- | -------- | ----------- |
| `points`       | `object[]`          | Yes      |             |
| `netName`      | `string (optional)` | No       |             |
| `color`        | `string (optional)` | No       |             |
| `lineWidth`    | `number (optional)` | No       |             |
| `lineType`     | `string (optional)` | No       |             |
| `confirmWrite` | `'true'`            | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  wire: any(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_component_pins`

**Profile:** `core` | **Risk Level:** `low`

> Get exact pin numbers, names, and coordinates for a schematic component by its primitive ID.

### Input Parameters

| Parameter     | Type     | Required | Description |
| ------------- | -------- | -------- | ----------- |
| `primitiveId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  primitiveId: string;
  pins: object[];
  success: boolean;
  error: string (optional);
}
```

---

## `easyeda_schematic_components`

**Profile:** `core` | **Risk Level:** `low`

> List schematic components: primitiveId, reference, value, footprint, x/y/rotation, and device identity for cloning — deviceUuid+deviceLibraryUuid (a place_component deviceItem in this project), deviceName, symbolName, lcsc, manufacturerId.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `limit`     | `number` | Yes      |             |
| `offset`    | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  components: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_schematic_connect_pin_to_net`

**Profile:** `core` | **Risk Level:** `medium`

> Create real EasyEDA connectivity for a pin: draws a short wire stub from its exact coordinate, tagged with netName. Same-netName wires merge globally, so this joins the pin to everything else on that net — visible to ERC, ratsnest, and autorouting.

### Input Parameters

| Parameter      | Type                | Required | Description                                                          |
| -------------- | ------------------- | -------- | -------------------------------------------------------------------- |
| `projectId`    | `string`            | Yes      | The project/schematic ID                                             |
| `primitiveId`  | `string`            | Yes      | The primitive ID of the component                                    |
| `pinNumber`    | `string`            | Yes      | The pin number or pin name on the component (e.g. "1", "VCC", "GND") |
| `netName`      | `string`            | Yes      | The net name to connect the pin to (e.g. VCC, GND, DATA0)            |
| `stubLength`   | `number (optional)` | No       | Length of the wire stub drawn outward from the pin. Defaults to 10.  |
| `confirmWrite` | `'true'`            | Yes      |                                                                      |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  real: boolean(optional);
  created_primitive_id: string(optional);
  endpoint: object(optional);
  connection: object(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_connect_pins_by_net`

**Profile:** `core` | **Risk Level:** `medium`

> Bulk variant of connect_pin_to_net: draws a real wire stub from each pin, tagged with netName, so all listed pins (and anything else already on that net) merge into one net. Visible to ERC, ratsnest, and autorouting. A pin that fails (e.g. collision) is reported in failures rather than aborting the batch.

### Input Parameters

| Parameter      | Type                | Required | Description                                                          |
| -------------- | ------------------- | -------- | -------------------------------------------------------------------- |
| `projectId`    | `string`            | Yes      | The project/schematic ID                                             |
| `netName`      | `string`            | Yes      | The net name to assign pins to                                       |
| `pins`         | `object[]`          | Yes      | List of component pins to connect to the net                         |
| `stubLength`   | `number (optional)` | No       | Length of the wire stub drawn outward from each pin. Defaults to 10. |
| `confirmWrite` | `'true'`            | Yes      |                                                                      |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  real: boolean (optional);
  created_primitive_ids: string[] (optional);
  failures: object[] (optional);
  connections: object[] (optional);
  count: number;
  error: string (optional);
}
```

---

## `easyeda_schematic_create_net_flag`

**Profile:** `core` | **Risk Level:** `medium`

> Create a named net flag/label. With `identification` (Power/Ground/AnalogGround/ProtectGround) it places a power-flag symbol binding to a coincident pin (use for VCC/GND). Without it, a generic net label — cosmetic only; connect pins with add_wire stubs sharing one netName.

### Input Parameters

| Parameter        | Type                | Required | Description                                      |
| ---------------- | ------------------- | -------- | ------------------------------------------------ |
| `projectId`      | `string`            | Yes      | The project/schematic ID                         |
| `netName`        | `string`            | Yes      | The net name to assign (e.g. VCC, GND, TEST_NET) |
| `x`              | `number`            | Yes      | X coordinate on the schematic canvas             |
| `y`              | `number`            | Yes      | Y coordinate on the schematic canvas             |
| `rotation`       | `number (optional)` | No       | Rotation in degrees (0, 90, 180, 270)            |
| `identification` | `'Power'            | 'Ground' | 'AnalogGround'                                   | 'ProtectGround' (optional)` | No  | Power-flag identification. When set, places an EasyEDA power/ground flag symbol of this type. When omitted, places a generic named net label instead. |
| `confirmWrite`   | `'true'`            | Yes      |                                                  |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  netFlag: object(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_create_net_port`

**Profile:** `core` | **Risk Level:** `medium`

> Place a hierarchical net port (off-sheet connector) on the schematic. Net ports create named connections that span multiple schematic sheets, appearing as real SCH_Net entries in the netlist.

### Input Parameters

| Parameter      | Type                | Required | Description                                         |
| -------------- | ------------------- | -------- | --------------------------------------------------- |
| `projectId`    | `string`            | Yes      | The project/schematic ID                            |
| `netName`      | `string`            | Yes      | The net name for the port (e.g. VCC, GND, DATA_BUS) |
| `x`            | `number`            | Yes      | X coordinate on the schematic canvas                |
| `y`            | `number`            | Yes      | Y coordinate on the schematic canvas                |
| `portType`     | `'input'            | 'output' | 'bidirectional'                                     | 'triState' | 'passive' (optional)` | No  | Electrical type of the port |
| `rotation`     | `number (optional)` | No       | Rotation in degrees (0, 90, 180, 270)               |
| `confirmWrite` | `'true'`            | Yes      |                                                     |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  netPort: object(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_delete_primitive`

**Profile:** `core` | **Risk Level:** `medium`

> Delete components, wires, or other drawing objects from the schematic by their primitive UUIDs.

### Input Parameters

| Parameter      | Type       | Required | Description |
| -------------- | ---------- | -------- | ----------- |
| `primitiveIds` | `string[]` | Yes      |             |
| `confirmWrite` | `'true'`   | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  error: string(optional);
}
```

---

## `easyeda_schematic_modify_primitive`

**Profile:** `core` | **Risk Level:** `medium`

> Modify a schematic component/object: only fields in property change; others are read back and preserved, so partial updates never wipe unrelated data. Also moves net flags/ports — pass x/y, rotation 0/90/180/270, or mirror to shift a VCC/GND flag label off a crowded pin, keeping it over its wire.

### Input Parameters

| Parameter      | Type                  | Required | Description |
| -------------- | --------------------- | -------- | ----------- |
| `primitiveId`  | `string`              | Yes      |             |
| `property`     | `Record<string, any>` | Yes      |             |
| `confirmWrite` | `'true'`              | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  result: any(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_net_detail`

**Profile:** `core` | **Risk Level:** `low`

> Get full details for a specific net in the schematic including all connected pins and components.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `netName`   | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  net_name: string;
  node_count: number;
  nodes: object[];
  not_available: boolean (optional);
}
```

---

## `easyeda_schematic_nets`

**Profile:** `core` | **Risk Level:** `low`

> List all nets in the schematic with their node connections.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  nets: object[];
  total: number;
  not_available: boolean (optional);
}
```

---

## `easyeda_schematic_place_component`

**Profile:** `core` | **Risk Level:** `medium`

> Place a library component/device on the active schematic sheet. The bridge auto-assigns the next free designator ("R?" → "R1", "R2", …); check the returned designator. If annotation fails, fix the placeholder via modify_primitive — the netlist keys nodes by designator, so duplicate "R?" merge into one node.

### Input Parameters

| Parameter                 | Type                 | Required | Description |
| ------------------------- | -------------------- | -------- | ----------- |
| `deviceItem`              | `object`             | Yes      |             |
| `x`                       | `number`             | Yes      |             |
| `y`                       | `number`             | Yes      |             |
| `subPartName`             | `string (optional)`  | No       |             |
| `rotation`                | `number (optional)`  | No       |             |
| `mirror`                  | `boolean (optional)` | No       |             |
| `addIntoBom`              | `boolean (optional)` | No       |             |
| `addIntoPcb`              | `boolean (optional)` | No       |             |
| `dryRun`                  | `boolean (optional)` | No       |             |
| `verifyAfterWrite`        | `boolean (optional)` | No       |             |
| `checkPlacementCollision` | `boolean (optional)` | No       |             |
| `collisionRadius`         | `number (optional)`  | No       |             |
| `confirmWrite`            | `'true'`             | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  component: any(optional);
  dry_run: boolean(optional);
  placement_guard: any(optional);
  verification: any(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_search_device`

**Profile:** `core` | **Risk Level:** `low`

> Search for schematic symbols/devices in the EasyEDA library by keywords.

### Input Parameters

| Parameter        | Type                | Required             | Description |
| ---------------- | ------------------- | -------------------- | ----------- |
| `key`            | `string`            | Yes                  |             |
| `libraryUuid`    | `string (optional)` | No                   |             |
| `classification` | `string             | string[] (optional)` | No          |     |
| `symbolType`     | `string (optional)` | No                   |             |
| `itemsOfPage`    | `number`            | Yes                  |             |
| `page`           | `number`            | Yes                  |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  devices: object[];
  total: number;
  provider_tier: 'local_library' (optional);
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_schematic_sheet_info`

**Profile:** `core` | **Risk Level:** `low`

> Return read-only active schematic sheet metadata including page size, frame, origin, and grid hints for safer component placement.

### Input Parameters

| Parameter   | Type                | Required | Description |
| ----------- | ------------------- | -------- | ----------- |
| `projectId` | `string (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string(optional);
  sheet: any(optional);
  page_size: object(optional);
  frame: any(optional);
  origin: any(optional);
  grid: any(optional);
  raw: any(optional);
  not_available: boolean(optional);
  error: string(optional);
}
```

---

## `easyeda_schematic_validate_netlist`

**Profile:** `core` | **Risk Level:** `low`

> Validate the schematic netlist: inferred nets, connected refs/pins, floating pins, plus a cross-check with native ERC (native_erc). `valid` needs BOTH the inference clean AND native ERC 0 errors — inference alone false-positives when pins overlap without a wire.

### Input Parameters

| Parameter          | Type      | Required | Description                                                            |
| ------------------ | --------- | -------- | ---------------------------------------------------------------------- |
| `projectId`        | `string`  | Yes      | The project/schematic ID                                               |
| `includeWireCheck` | `boolean` | Yes      | When true, also check for graphical wires without netlist connectivity |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  netlist: object[];
  total_nets: number;
  floating_pins: object[];
  wires_without_netlist: object[] (optional);
  native_erc: object (optional);
  valid: boolean;
  warnings: string[];
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_schematic_verify_write`

**Profile:** `core` | **Risk Level:** `low`

> Read back schematic state after an agent-authored write. Returns component-count delta evidence and optional netlist validation so agents can confirm a placement or connection before continuing.

### Input Parameters

| Parameter                     | Type                 | Required | Description |
| ----------------------------- | -------------------- | -------- | ----------- |
| `projectId`                   | `string (optional)`  | No       |             |
| `netName`                     | `string (optional)`  | No       |             |
| `beforeComponentCount`        | `number (optional)`  | No       |             |
| `expectedComponentCountDelta` | `number (optional)`  | No       |             |
| `includeWireCheck`            | `boolean (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string (optional);
  net_name: string (optional);
  components_available: boolean;
  component_count: number (optional);
  component_count_delta: number (optional);
  component_delta_matches: boolean (optional);
  netlist_available: boolean;
  netlist_validation: any (optional);
  warnings: string[];
  error: string (optional);
}
```

---

## `easyeda_schematic_wires`

**Profile:** `core` | **Risk Level:** `low`

> List wire segments: primitiveId, line coordinates, net name, color, style. Page with offset (check total) past the 50-wire-per-call cap. primitiveId is required by delete_primitive/modify_primitive — schematic_nets alone cannot resolve a wire ID.

### Input Parameters

| Parameter   | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| `projectId` | `string` | Yes      |             |
| `limit`     | `number` | Yes      |             |
| `offset`    | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  wires: object[];
  total: number;
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_semantic_erc_validate`

**Profile:** `core` | **Risk Level:** `medium`

> Run semantic electrical-rule validation over a netlist with pin electrical types to detect output contention, floating inputs, power conflicts, missing power pins, missing decoupling, and voltage-domain mismatches.

### Input Parameters

| Parameter    | Type                  | Required | Description |
| ------------ | --------------------- | -------- | ----------- |
| `projectId`  | `string (optional)`   | No       |             |
| `nets`       | `object[]`            | Yes      |             |
| `devices`    | `object[] (optional)` | No       |             |
| `interfaces` | `object[] (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: string;
  passed: boolean;
  error_count: number;
  warning_count: number;
  total_issues: number;
  errors: object[];
  warnings: object[];
}
```

---

## `easyeda_simulate_operating_point`

**Profile:** `pro` | **Risk Level:** `low`

> Translate a typed circuit description into a SPICE deck and run an offline ngspice operating-point (.op) simulation, optionally checking rail node voltages against a spec. Read-only, local-only. Reports a capability gap rather than failing when ngspice is absent.

### Input Parameters

| Parameter   | Type                  | Required | Description |
| ----------- | --------------------- | -------- | ----------- |
| `circuit`   | `object`              | Yes      |             |
| `railSpecs` | `object[] (optional)` | No       |             |
| `timeoutMs` | `number (optional)`   | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  available: boolean;
  ngspice_version: string (optional);
  node_voltages: Record<string, number> (optional);
  rail_verdicts: object[] (optional);
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_simulate_transient`

**Profile:** `pro` | **Risk Level:** `low`

> Translate a typed circuit description into a SPICE deck and run an offline ngspice transient (.tran) simulation, optionally checking the final rail voltage against a spec. Read-only, local-only. Reports a capability gap rather than failing when ngspice is absent.

### Input Parameters

| Parameter         | Type                  | Required | Description |
| ----------------- | --------------------- | -------- | ----------- |
| `circuit`         | `object`              | Yes      |             |
| `stepSeconds`     | `number`              | Yes      |             |
| `stopTimeSeconds` | `number`              | Yes      |             |
| `railSpecs`       | `object[] (optional)` | No       |             |
| `timeoutMs`       | `number (optional)`   | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  available: boolean;
  ngspice_version: string (optional);
  samples: object[] (optional);
  truncated: boolean (optional);
  rail_verdicts: object[] (optional);
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_wire_probe`

**Profile:** `dev` | **Risk Level:** `low`

> Inspect live schematic wire objects, including line coordinates, net names, methods, and state getter values, to validate EasyEDA runtime mappings.

### Input Parameters

| Parameter | Type     | Required | Description |
| --------- | -------- | -------- | ----------- |
| `limit`   | `number` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  total: number;
  samples: any[];
  not_available: boolean (optional);
  error: string (optional);
}
```

---

## `easyeda_workflow_connector_breakout`

**Profile:** `pro` | **Risk Level:** `medium`

> Place a connector, wire each declared pin to its net, and create a net port for each net so the breakout is accessible off-sheet — all as a single atomic transaction (confirmWrite required).

### Input Parameters

| Parameter       | Type                 | Required | Description |
| --------------- | -------------------- | -------- | ----------- |
| `projectId`     | `string`             | Yes      |             |
| `mode`          | `'preview'           | 'apply'` | Yes         |     |
| `anchor`        | `object`             | Yes      |             |
| `netPortAnchor` | `object (optional)`  | No       |             |
| `connectorRef`  | `string`             | Yes      |             |
| `connector`     | `object`             | Yes      |             |
| `rotation`      | `number (optional)`  | No       |             |
| `mirror`        | `boolean (optional)` | No       |             |
| `subPartName`   | `string (optional)`  | No       |             |
| `pins`          | `object[]`           | Yes      |             |
| `confirmWrite`  | `boolean (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  rolled_back: boolean;
  placements: object[];
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  summary: string;
  rollback_notes: string[];
  error: string (optional);
}
```

---

## `easyeda_workflow_decouple_ic`

**Profile:** `pro` | **Risk Level:** `medium`

> Place one decoupling capacitor per declared IC power pin and wire each to the pin's net and ground, in a single atomic transaction. Cites design-rules decoupling guidance (rule-of-thumb, not datasheet-specific) alongside the plan (confirmWrite required).

### Input Parameters

| Parameter            | Type                 | Required | Description |
| -------------------- | -------------------- | -------- | ----------- |
| `projectId`          | `string`             | Yes      |             |
| `mode`               | `'preview'           | 'apply'` | Yes         |      |
| `anchor`             | `object`             | Yes      |             |
| `spacing`            | `number (optional)`  | No       |             |
| `groundNetName`      | `string`             | Yes      |             |
| `icPowerPins`        | `object[]`           | Yes      |             |
| `capacitor`          | `object`             | Yes      |             |
| `capacitorPins`      | `object`             | Yes      |             |
| `decouplingCategory` | `'digital-logic'     | 'mcu'    | 'analog'    | 'rf' | 'crystal-oscillator' | 'power-regulator'` | Yes |     |
| `confirmWrite`       | `boolean (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  rolled_back: boolean;
  placements: object[];
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  summary: string;
  rollback_notes: string[];
  error: string (optional);
  decoupling_guidance: object (optional);
}
```

---

## `easyeda_workflow_place_block`

**Profile:** `pro` | **Risk Level:** `medium`

> Place a group of components, wire their pin-to-net connections (new and/or pre-existing components), and create net ports for block-external nets — all as a single atomic transaction with rollback on partial failure (confirmWrite required).

### Input Parameters

| Parameter            | Type                 | Required | Description |
| -------------------- | -------------------- | -------- | ----------- |
| `projectId`          | `string`             | Yes      |             |
| `mode`               | `'preview'           | 'apply'` | Yes         |     |
| `anchor`             | `object`             | Yes      |             |
| `spacing`            | `number (optional)`  | No       |             |
| `blockName`          | `string (optional)`  | No       |             |
| `components`         | `object[]`           | Yes      |             |
| `existingComponents` | `object[]`           | Yes      |             |
| `netPorts`           | `object[]`           | Yes      |             |
| `netPortAnchor`      | `object (optional)`  | No       |             |
| `confirmWrite`       | `boolean (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  rolled_back: boolean;
  placements: object[];
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  summary: string;
  rollback_notes: string[];
  error: string (optional);
}
```

---

## `easyeda_workflow_power_rail`

**Profile:** `pro` | **Risk Level:** `medium`

> Place a regulator and its supporting passives and wire them to input/output/ground nets in a single atomic transaction, instead of one primitive call per component. Caller supplies already-resolved device items and pin connections; this tool does not select parts (confirmWrite required).

### Input Parameters

| Parameter       | Type                 | Required | Description |
| --------------- | -------------------- | -------- | ----------- |
| `projectId`     | `string`             | Yes      |             |
| `mode`          | `'preview'           | 'apply'` | Yes         |     |
| `anchor`        | `object`             | Yes      |             |
| `spacing`       | `number (optional)`  | No       |             |
| `groundNetName` | `string`             | Yes      |             |
| `inputNetName`  | `string`             | Yes      |             |
| `outputNetName` | `string`             | Yes      |             |
| `components`    | `object[]`           | Yes      |             |
| `verifyRail`    | `object (optional)`  | No       |             |
| `confirmWrite`  | `boolean (optional)` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: boolean;
  project_id: string;
  transaction_id: string;
  mode: string;
  applied: boolean;
  blocked: boolean;
  rolled_back: boolean;
  placements: object[];
  operations: object[];
  apply_results: object[] (optional);
  issues: object[];
  summary: string;
  rollback_notes: string[];
  error: string (optional);
  verification: object (optional);
}
```

---
