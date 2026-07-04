# MCP Tools Reference

This page details all available Model Context Protocol (MCP) tools exposed by `easyeda-mcp-pro`.
These tools are profile-gated. Set the `TOOL_PROFILE` environment variable to enable them.

## Summary of Tools

| Tool Name                               | Profile | Risk     | Description                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `easyeda_api_call`                      | `full`  | `high`   | Controlled call to a documented EasyEDA class method by path, for example SCH_PrimitiveWire.getAll. This is not raw JavaScript execution.                                                                                                                                                                     |
| `easyeda_api_inventory`                 | `core`  | `low`    | Inspect the live EasyEDA extension runtime and list available documented API classes, runtime paths, and methods.                                                                                                                                                                                             |
| `easyeda_board_dimensions`              | `core`  | `low`    | Get the PCB board outline dimensions, shape, and mounting hole information.                                                                                                                                                                                                                                   |
| `easyeda_board_features`                | `core`  | `low`    | Get counts of board features including vias, tracks, copper zones, and pads.                                                                                                                                                                                                                                  |
| `easyeda_board_layers`                  | `core`  | `low`    | List all layers in the PCB design including signal, power, plane, and mechanical layers.                                                                                                                                                                                                                      |
| `easyeda_board_stackup`                 | `core`  | `low`    | Get the PCB layer stackup including thickness, material, and dielectric constants.                                                                                                                                                                                                                            |
| `easyeda_bom_export`                    | `core`  | `low`    | Export the bill of materials to a file on disk in the specified format.                                                                                                                                                                                                                                       |
| `easyeda_bom_generate`                  | `core`  | `low`    | Generate a bill of materials for the project with grouping and formatting options.                                                                                                                                                                                                                            |
| `easyeda_bom_quality_report`            | `core`  | `medium` | Generate a BOM quality report that identifies unavailable, single-source, missing-MPN, missing-footprint, and low-stock items across configured suppliers.                                                                                                                                                    |
| `easyeda_bom_sourcing`                  | `core`  | `medium` | Retrieve pricing and availability information for all parts in the project BOM from specified suppliers.                                                                                                                                                                                                      |
| `easyeda_bom_validate`                  | `core`  | `medium` | Validate the project BOM against LCSC inventory to identify missing, obsolete, or alternate parts.                                                                                                                                                                                                            |
| `easyeda_bridge_probe_methods`          | `dev`   | `medium` | Query the EasyEDA Pro bridge for available API methods. Requires bridge connection. (dev/pro only)                                                                                                                                                                                                            |
| `easyeda_bridge_status`                 | `core`  | `low`    | Check EasyEDA Pro bridge connection status, version, and capabilities.                                                                                                                                                                                                                                        |
| `easyeda_component_probe`               | `dev`   | `low`    | Inspect live schematic component objects, including available methods and state getter values, to validate EasyEDA runtime mappings.                                                                                                                                                                          |
| `easyeda_drc_run`                       | `core`  | `medium` | Run design rule check (DRC) on the project to identify rule violations, clearance issues, and manufacturing constraints.                                                                                                                                                                                      |
| `easyeda_erc_run`                       | `core`  | `medium` | Run electrical rule check (ERC) on the schematic to detect unconnected nets, short circuits, and electrical conflicts.                                                                                                                                                                                        |
| `easyeda_export_gerbers`                | `core`  | `medium` | Export PCB design to Gerber files for PCB fabrication.                                                                                                                                                                                                                                                        |
| `easyeda_export_netlist`                | `pro`   | `low`    | Export the schematic netlist in a specified EDA tool format (PADS, Allegro, or Altium).                                                                                                                                                                                                                       |
| `easyeda_export_pdf`                    | `pro`   | `low`    | Export the schematic and/or board layout to PDF.                                                                                                                                                                                                                                                              |
| `easyeda_export_pick_place`             | `pro`   | `low`    | Export pick-and-place (centroid) file for PCB assembly. Contains component reference, position, rotation, and layer.                                                                                                                                                                                          |
| `easyeda_get_capabilities`              | `core`  | `low`    | Return server capabilities, including available profiles, enabled feature flags, and supported operations.                                                                                                                                                                                                    |
| `easyeda_get_feature_flags`             | `core`  | `low`    | Return current feature flag values.                                                                                                                                                                                                                                                                           |
| `easyeda_get_server_config`             | `core`  | `low`    | Return safe (redacted) server configuration. Secrets are never exposed.                                                                                                                                                                                                                                       |
| `easyeda_get_tool_profiles`             | `core`  | `low`    | List available tool profiles and their descriptions.                                                                                                                                                                                                                                                          |
| `easyeda_health_check`                  | `core`  | `low`    | Return server health status, including runtime version, active profile, bridge state, and config validity.                                                                                                                                                                                                    |
| `easyeda_jlcpcb_quote_workflow`         | `pro`   | `medium` | Prepare a non-binding JLCPCB quote workflow snapshot with explicit human-review gates and audit evidence. This tool never places orders or performs paid operations.                                                                                                                                          |
| `easyeda_live_smoke_report`             | `dev`   | `low`    | Run a read-only live smoke report against the connected EasyEDA bridge and return status, API inventory, components, wires, and schematic nets in one response.                                                                                                                                               |
| `easyeda_observability_report`          | `core`  | `low`    | Return latency budgets, runtime metrics, cache/vendor timing snapshot, and storage retention policy for performance diagnostics.                                                                                                                                                                              |
| `easyeda_pcb_add_track`                 | `full`  | `high`   | Draw a copper track/trace segment on the PCB board.                                                                                                                                                                                                                                                           |
| `easyeda_pcb_add_via`                   | `full`  | `high`   | Place a via to connect different copper layers on the PCB board.                                                                                                                                                                                                                                              |
| `easyeda_pcb_add_zone`                  | `full`  | `high`   | Create a copper pour zone on a specific layer with clearance settings.                                                                                                                                                                                                                                        |
| `easyeda_pcb_constraint_check`          | `core`  | `low`    | Run PCB constraint validation against the board design. Checks board outline, layer stackup, net classes, clearance rules, keepout areas, placement zones, mounting holes, fiducials, and manufacturing constraints.                                                                                          |
| `easyeda_pcb_constraint_report`         | `core`  | `low`    | Generate a human-readable report explaining which PCB constraints were applied and which require manual review.                                                                                                                                                                                               |
| `easyeda_pcb_delete_component`          | `full`  | `high`   | Delete components from the PCB layout by their primitive IDs.                                                                                                                                                                                                                                                 |
| `easyeda_pcb_modify_component`          | `full`  | `high`   | Modify component properties in the PCB layout.                                                                                                                                                                                                                                                                |
| `easyeda_pcb_place_component`           | `full`  | `high`   | Place a component footprint on the active PCB layout.                                                                                                                                                                                                                                                         |
| `easyeda_pcb_place_component_group`     | `full`  | `high`   | Create a high-level, constraint-checked placement plan for a group of components and optionally apply it after explicit confirmation.                                                                                                                                                                         |
| `easyeda_pcb_production_review`         | `core`  | `medium` | Run fabrication, assembly, and testability production review rules for PCB handoff. Reports severity-ranked DFM/DFA/DFT findings with actionable remediation before Gerber export or manufacturing submission.                                                                                                |
| `easyeda_pcb_route_path_plan`           | `full`  | `high`   | Create a high-level, constraint-checked route path plan for one net and optionally apply it after explicit confirmation.                                                                                                                                                                                      |
| `easyeda_power_tree_analyze`            | `core`  | `medium` | Analyze supply sources, regulators, loads, protection, bulk capacitance, current budget, dropout, and regulator thermal risk. Returns machine-readable issues and a human-readable summary.                                                                                                                   |
| `easyeda_production_qa_artifacts`       | `pro`   | `low`    | Generate testpoint checklist, assembly notes, bring-up plan, production QA checklist, and machine-readable QA manifest for board handoff.                                                                                                                                                                     |
| `easyeda_project_save`                  | `core`  | `medium` | Explicitly save the current EasyEDA Pro project. This ensures all netlist changes, net flags, pin connections, and other mutations are persisted to the project file. Save is never implicit — the caller must explicitly request it. Requires confirmWrite.                                                  |
| `easyeda_rule_check_summary`            | `core`  | `low`    | Get a summary of all design and electrical rule check results for the project.                                                                                                                                                                                                                                |
| `easyeda_run_self_test`                 | `core`  | `low`    | Run internal self-test to verify server integrity, config, and bridge connectivity.                                                                                                                                                                                                                           |
| `easyeda_schematic_add_wire`            | `core`  | `medium` | Add a wire segment connecting schematic coordinates/pins.                                                                                                                                                                                                                                                     |
| `easyeda_schematic_component_pins`      | `core`  | `low`    | Get exact pin numbers, names, and coordinates for a schematic component by its primitive ID.                                                                                                                                                                                                                  |
| `easyeda_schematic_components`          | `core`  | `low`    | List all components in the schematic with their properties including reference, value, footprint, LCSC part number, manufacturer, and datasheet.                                                                                                                                                              |
| `easyeda_schematic_connect_pin_to_net`  | `core`  | `medium` | Connect a specific component pin to a named net. This creates an actual SCH_Netlist entry associating the pin with the net. If the net does not exist yet, it is created on the fly. This is the core tool for populating the real EasyEDA netlist with pin-to-net connectivity.                              |
| `easyeda_schematic_connect_pins_by_net` | `core`  | `medium` | Connect multiple component pins to a named net in a single operation. All specified pins will be assigned to the same net, creating SCH_Netlist entries. If the net does not exist, it is created. This is the bulk equivalent of connect_pin_to_net.                                                         |
| `easyeda_schematic_create_net_flag`     | `core`  | `medium` | Create a named schematic net flag at specified coordinates. This controlled write declares real SCH_Net connectivity in the EasyEDA Pro netlist.                                                                                                                                                              |
| `easyeda_schematic_create_net_port`     | `core`  | `medium` | Place a hierarchical net port (off-sheet connector) on the schematic. Net ports create named connections that span multiple schematic sheets, appearing as real SCH_Net entries in the netlist.                                                                                                               |
| `easyeda_schematic_delete_primitive`    | `core`  | `medium` | Delete components, wires, or other drawing objects from the schematic by their primitive UUIDs.                                                                                                                                                                                                               |
| `easyeda_schematic_modify_primitive`    | `core`  | `medium` | Modify properties (value, reference, attributes, etc.) of a schematic component/object.                                                                                                                                                                                                                       |
| `easyeda_schematic_net_detail`          | `core`  | `low`    | Get full details for a specific net in the schematic including all connected pins and components.                                                                                                                                                                                                             |
| `easyeda_schematic_nets`                | `core`  | `low`    | List all nets in the schematic with their node connections.                                                                                                                                                                                                                                                   |
| `easyeda_schematic_place_component`     | `core`  | `medium` | Place a library component/device on the active schematic sheet.                                                                                                                                                                                                                                               |
| `easyeda_schematic_search_device`       | `core`  | `low`    | Search for schematic symbols/devices in the EasyEDA library by keywords.                                                                                                                                                                                                                                      |
| `easyeda_schematic_sheet_info`          | `core`  | `low`    | Return read-only active schematic sheet metadata including page size, frame, origin, and grid hints for safer component placement.                                                                                                                                                                            |
| `easyeda_schematic_validate_netlist`    | `core`  | `low`    | Validate the EasyEDA Pro schematic netlist for connectivity issues. Reports net names, connected component references and pins, floating pins, graphical wires without netlist connectivity, and mismatches between visual wires and actual SCH_Net/SCH_Netlist entries. This is a read-only diagnostic tool. |
| `easyeda_semantic_erc_validate`         | `core`  | `medium` | Run semantic electrical-rule validation over a netlist with pin electrical types to detect output contention, floating inputs, power conflicts, missing power pins, missing decoupling, and voltage-domain mismatches.                                                                                        |
| `easyeda_wire_probe`                    | `dev`   | `low`    | Inspect live schematic wire objects, including line coordinates, net names, methods, and state getter values, to validate EasyEDA runtime mappings.                                                                                                                                                           |

---

## `easyeda_api_call`

**Profile:** `full` | **Risk Level:** `high`

> Controlled call to a documented EasyEDA class method by path, for example SCH_PrimitiveWire.getAll. This is not raw JavaScript execution.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `path`         | `any` | Yes      |             |
| `args`         | `any` | Yes      |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  ok: any;
  path: any;
  resolvedPath: any;
  result: any;
  error: any;
  requires_confirmation: any;
}
```

---

## `easyeda_api_inventory`

**Profile:** `core` | **Risk Level:** `low`

> Inspect the live EasyEDA extension runtime and list available documented API classes, runtime paths, and methods.

### Input Parameters

| Parameter | Type  | Required | Description |
| --------- | ----- | -------- | ----------- |
| `filter`  | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  classes: any;
  total: any;
  not_available: any;
  error: any;
}
```

---

## `easyeda_board_dimensions`

**Profile:** `core` | **Risk Level:** `low`

> Get the PCB board outline dimensions, shape, and mounting hole information.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  width_mm: any;
  height_mm: any;
  shape: any;
  mounting_hole_count: any;
  area_mm2: any;
  not_available: any;
}
```

---

## `easyeda_board_features`

**Profile:** `core` | **Risk Level:** `low`

> Get counts of board features including vias, tracks, copper zones, and pads.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  vias: any;
  tracks: any;
  zones: any;
  pads: any;
  components: any;
  not_available: any;
}
```

---

## `easyeda_board_layers`

**Profile:** `core` | **Risk Level:** `low`

> List all layers in the PCB design including signal, power, plane, and mechanical layers.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  layers: any;
  total: any;
  not_available: any;
}
```

---

## `easyeda_board_stackup`

**Profile:** `core` | **Risk Level:** `low`

> Get the PCB layer stackup including thickness, material, and dielectric constants.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  total_layers: any;
  board_thickness_mm: any;
  layers: any;
  not_available: any;
}
```

---

## `easyeda_bom_export`

**Profile:** `core` | **Risk Level:** `low`

> Export the bill of materials to a file on disk in the specified format.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `format`    | `any` | Yes      |             |
| `filePath`  | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  format: any;
  file_path: any;
  exported: any;
  entry_count: any;
  not_available: any;
}
```

---

## `easyeda_bom_generate`

**Profile:** `core` | **Risk Level:** `low`

> Generate a bill of materials for the project with grouping and formatting options.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `format`    | `any` | Yes      |             |
| `groupBy`   | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  format: any;
  group_by: any;
  entries: any;
  total_entries: any;
  not_available: any;
}
```

---

## `easyeda_bom_quality_report`

**Profile:** `core` | **Risk Level:** `medium`

> Generate a BOM quality report that identifies unavailable, single-source, missing-MPN, missing-footprint, and low-stock items across configured suppliers.

### Input Parameters

| Parameter                   | Type  | Required | Description |
| --------------------------- | ----- | -------- | ----------- |
| `projectId`                 | `any` | Yes      |             |
| `low_stock_threshold`       | `any` | No       |             |
| `require_mpn`               | `any` | No       |             |
| `require_footprint`         | `any` | No       |             |
| `stale_vendor_data_seconds` | `any` | No       |             |
| `minimum_quality_score`     | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  bom_id: any;
  generated_at: any;
  total_entries: any;
  summary: any;
  entries: any;
  has_supplier_errors: any;
  not_available: any;
}
```

---

## `easyeda_bom_sourcing`

**Profile:** `core` | **Risk Level:** `medium`

> Retrieve pricing and availability information for all parts in the project BOM from specified suppliers.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `suppliers` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  parts: any;
  total_parts: any;
  not_available: any;
}
```

---

## `easyeda_bom_validate`

**Profile:** `core` | **Risk Level:** `medium`

> Validate the project BOM against LCSC inventory to identify missing, obsolete, or alternate parts.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  total_parts: any;
  missing_lcsc: any;
  invalid_lcsc: any;
  obsolete: any;
  valid_count: any;
  validated: any;
  not_available: any;
}
```

---

## `easyeda_bridge_probe_methods`

**Profile:** `dev` | **Risk Level:** `medium`

> Query the EasyEDA Pro bridge for available API methods. Requires bridge connection. (dev/pro only)

### Input Parameters

| Parameter | Type  | Required | Description |
| --------- | ----- | -------- | ----------- |
| `filter`  | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  methods: any;
  total: any;
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
  connected: any;
  bridge_version: any;
  easyeda_version: any;
  capabilities: any;
  dev_mode: any;
  last_heartbeat_ms: any;
  uptime_ms: any;
  status_error: any;
  diagnostics: any;
}
```

---

## `easyeda_component_probe`

**Profile:** `dev` | **Risk Level:** `low`

> Inspect live schematic component objects, including available methods and state getter values, to validate EasyEDA runtime mappings.

### Input Parameters

| Parameter | Type  | Required | Description |
| --------- | ----- | -------- | ----------- |
| `limit`   | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  total: any;
  samples: any;
  not_available: any;
  error: any;
}
```

---

## `easyeda_drc_run`

**Profile:** `core` | **Risk Level:** `medium`

> Run design rule check (DRC) on the project to identify rule violations, clearance issues, and manufacturing constraints.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `rules`     | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  violations: any;
  total_violations: any;
  error_count: any;
  warning_count: any;
  passed: any;
  not_available: any;
}
```

---

## `easyeda_erc_run`

**Profile:** `core` | **Risk Level:** `medium`

> Run electrical rule check (ERC) on the schematic to detect unconnected nets, short circuits, and electrical conflicts.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `checks`    | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  violations: any;
  total_violations: any;
  error_count: any;
  warning_count: any;
  passed: any;
  not_available: any;
}
```

---

## `easyeda_export_gerbers`

**Profile:** `core` | **Risk Level:** `medium`

> Export PCB design to Gerber files for PCB fabrication.

### Input Parameters

| Parameter          | Type  | Required | Description |
| ------------------ | ----- | -------- | ----------- |
| `projectId`        | `any` | Yes      |             |
| `drillFormat`      | `any` | No       |             |
| `excludeLayer`     | `any` | No       |             |
| `ledPanel`         | `any` | No       |             |
| `productionReview` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  artifact_path: any;
  file_count: any;
  exported: any;
  blocked_by_production_review: any;
  production_review: any;
  not_available: any;
}
```

---

## `easyeda_export_netlist`

**Profile:** `pro` | **Risk Level:** `low`

> Export the schematic netlist in a specified EDA tool format (PADS, Allegro, or Altium).

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `format`    | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  format: any;
  file_path: any;
  net_count: any;
  exported: any;
  not_available: any;
}
```

---

## `easyeda_export_pdf`

**Profile:** `pro` | **Risk Level:** `low`

> Export the schematic and/or board layout to PDF.

### Input Parameters

| Parameter     | Type  | Required | Description |
| ------------- | ----- | -------- | ----------- |
| `projectId`   | `any` | Yes      |             |
| `scope`       | `any` | Yes      |             |
| `orientation` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  scope: any;
  orientation: any;
  file_path: any;
  pages: any;
  exported: any;
  not_available: any;
}
```

---

## `easyeda_export_pick_place`

**Profile:** `pro` | **Risk Level:** `low`

> Export pick-and-place (centroid) file for PCB assembly. Contains component reference, position, rotation, and layer.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `format`    | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  format: any;
  file_path: any;
  component_count: any;
  exported: any;
  not_available: any;
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
  server_name: any;
  server_version: any;
  protocol_version: any;
  profiles: any;
  current_profile: any;
  feature_flags: any;
  transports: any;
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
  flags: any;
}
```

---

## `easyeda_get_server_config`

**Profile:** `core` | **Risk Level:** `low`

> Return safe (redacted) server configuration. Secrets are never exposed.

### Input Parameters

| Parameter       | Type  | Required | Description |
| --------------- | ----- | -------- | ----------- |
| `include_flags` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  node_env: any;
  log_level: any;
  profile: any;
  transport: any;
  bridge_host: any;
  bridge_port: any;
  mcp_protocol_version: any;
  flags: any;
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
  current: any;
  profiles: any;
}
```

---

## `easyeda_health_check`

**Profile:** `core` | **Risk Level:** `low`

> Return server health status, including runtime version, active profile, bridge state, and config validity.

### Input Parameters

No parameters required.

### Output Format

Returns a JSON object matching the schema:

```ts
{
  status: any;
  version: any;
  node_version: any;
  profile: any;
  transport: any;
  bridge_connected: any;
  ups: any;
}
```

---

## `easyeda_jlcpcb_quote_workflow`

**Profile:** `pro` | **Risk Level:** `medium`

> Prepare a non-binding JLCPCB quote workflow snapshot with explicit human-review gates and audit evidence. This tool never places orders or performs paid operations.

### Input Parameters

| Parameter                | Type  | Required | Description |
| ------------------------ | ----- | -------- | ----------- |
| `provider`               | `any` | Yes      |             |
| `action`                 | `any` | Yes      |             |
| `projectId`              | `any` | No       |             |
| `board`                  | `any` | Yes      |             |
| `quote`                  | `any` | No       |             |
| `confirmation`           | `any` | No       |             |
| `vendorTermsReviewed`    | `any` | No       |             |
| `productionFilesReady`   | `any` | No       |             |
| `exportManifestVerified` | `any` | No       |             |
| `productionReviewPassed` | `any` | No       |             |
| `allowedPaidOperations`  | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  provider: any;
  action: any;
  project_id: any;
  status: any;
  allowed: any;
  quote: any;
  risk: any;
  issues: any;
  audit: any;
  summary: any;
  unsupported_operations: any;
}
```

---

## `easyeda_live_smoke_report`

**Profile:** `dev` | **Risk Level:** `low`

> Run a read-only live smoke report against the connected EasyEDA bridge and return status, API inventory, components, wires, and schematic nets in one response.

### Input Parameters

| Parameter    | Type  | Required | Description |
| ------------ | ----- | -------- | ----------- |
| `projectId`  | `any` | Yes      |             |
| `limit`      | `any` | Yes      |             |
| `includeRaw` | `any` | Yes      |             |
| `timeoutMs`  | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  ok: any;
  project_id: any;
  generated_at: any;
  checks: any;
  summary: any;
  raw: any;
}
```

---

## `easyeda_observability_report`

**Profile:** `core` | **Risk Level:** `low`

> Return latency budgets, runtime metrics, cache/vendor timing snapshot, and storage retention policy for performance diagnostics.

### Input Parameters

| Parameter             | Type  | Required | Description |
| --------------------- | ----- | -------- | ----------- |
| `includeRecentEvents` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  generated_at: any;
  server_version: any;
  budgets: any;
  metrics: any;
  retention: any;
  timeout_policy: any;
}
```

---

## `easyeda_pcb_add_track`

**Profile:** `full` | **Risk Level:** `high`

> Draw a copper track/trace segment on the PCB board.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `points`       | `any` | Yes      |             |
| `layer`        | `any` | Yes      |             |
| `width`        | `any` | Yes      |             |
| `netName`      | `any` | No       |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  primitiveId: any;
  error: any;
}
```

---

## `easyeda_pcb_add_via`

**Profile:** `full` | **Risk Level:** `high`

> Place a via to connect different copper layers on the PCB board.

### Input Parameters

| Parameter       | Type  | Required | Description |
| --------------- | ----- | -------- | ----------- |
| `x`             | `any` | Yes      |             |
| `y`             | `any` | Yes      |             |
| `outerDiameter` | `any` | Yes      |             |
| `holeSize`      | `any` | Yes      |             |
| `netName`       | `any` | No       |             |
| `confirmWrite`  | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  primitiveId: any;
  error: any;
}
```

---

## `easyeda_pcb_add_zone`

**Profile:** `full` | **Risk Level:** `high`

> Create a copper pour zone on a specific layer with clearance settings.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `points`       | `any` | Yes      |             |
| `layer`        | `any` | Yes      |             |
| `netName`      | `any` | No       |             |
| `clearance`    | `any` | No       |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  primitiveId: any;
  error: any;
}
```

---

## `easyeda_pcb_constraint_check`

**Profile:** `core` | **Risk Level:** `low`

> Run PCB constraint validation against the board design. Checks board outline, layer stackup, net classes, clearance rules, keepout areas, placement zones, mounting holes, fiducials, and manufacturing constraints.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `boardData` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  valid: any;
  errors: any;
  warnings: any;
  summary: any;
  not_available: any;
}
```

---

## `easyeda_pcb_constraint_report`

**Profile:** `core` | **Risk Level:** `low`

> Generate a human-readable report explaining which PCB constraints were applied and which require manual review.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `boardData` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  verdict: any;
  checked: any;
  manualReviewRequired: any;
  not_available: any;
}
```

---

## `easyeda_pcb_delete_component`

**Profile:** `full` | **Risk Level:** `high`

> Delete components from the PCB layout by their primitive IDs.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `primitiveIds` | `any` | Yes      |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  deletedCount: any;
  error: any;
}
```

---

## `easyeda_pcb_modify_component`

**Profile:** `full` | **Risk Level:** `high`

> Modify component properties in the PCB layout.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `primitiveId`  | `any` | Yes      |             |
| `property`     | `any` | Yes      |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  error: any;
}
```

---

## `easyeda_pcb_place_component`

**Profile:** `full` | **Risk Level:** `high`

> Place a component footprint on the active PCB layout.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `footprint`    | `any` | Yes      |             |
| `x`            | `any` | Yes      |             |
| `y`            | `any` | Yes      |             |
| `rotation`     | `any` | Yes      |             |
| `layer`        | `any` | Yes      |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  primitiveId: any;
  error: any;
}
```

---

## `easyeda_pcb_place_component_group`

**Profile:** `full` | **Risk Level:** `high`

> Create a high-level, constraint-checked placement plan for a group of components and optionally apply it after explicit confirmation.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `projectId`    | `any` | No       |             |
| `mode`         | `any` | Yes      |             |
| `board`        | `any` | Yes      |             |
| `anchor`       | `any` | Yes      |             |
| `columns`      | `any` | No       |             |
| `spacingMm`    | `any` | No       |             |
| `layer`        | `any` | Yes      |             |
| `minSpacingMm` | `any` | No       |             |
| `components`   | `any` | Yes      |             |
| `keepouts`     | `any` | No       |             |
| `confirmWrite` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  project_id: any;
  transaction_id: any;
  mode: any;
  applied: any;
  blocked: any;
  placements: any;
  operations: any;
  apply_results: any;
  issues: any;
  summary: any;
  error: any;
}
```

---

## `easyeda_pcb_production_review`

**Profile:** `core` | **Risk Level:** `medium`

> Run fabrication, assembly, and testability production review rules for PCB handoff. Reports severity-ranked DFM/DFA/DFT findings with actionable remediation before Gerber export or manufacturing submission.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `boardData` | `any` | No       |             |
| `gateMode`  | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  passed: any;
  blocked: any;
  gate_mode: any;
  severity_counts: any;
  errors: any;
  warnings: any;
  summary: any;
  not_available: any;
}
```

---

## `easyeda_pcb_route_path_plan`

**Profile:** `full` | **Risk Level:** `high`

> Create a high-level, constraint-checked route path plan for one net and optionally apply it after explicit confirmation.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `projectId`    | `any` | No       |             |
| `mode`         | `any` | Yes      |             |
| `board`        | `any` | No       |             |
| `netName`      | `any` | Yes      |             |
| `layer`        | `any` | Yes      |             |
| `widthMm`      | `any` | Yes      |             |
| `waypoints`    | `any` | Yes      |             |
| `keepouts`     | `any` | No       |             |
| `maxLengthMm`  | `any` | No       |             |
| `minWidthMm`   | `any` | No       |             |
| `confirmWrite` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  project_id: any;
  transaction_id: any;
  mode: any;
  applied: any;
  blocked: any;
  net_name: any;
  layer: any;
  width_mm: any;
  path_length_mm: any;
  operations: any;
  apply_results: any;
  issues: any;
  summary: any;
  error: any;
}
```

---

## `easyeda_power_tree_analyze`

**Profile:** `core` | **Risk Level:** `medium`

> Analyze supply sources, regulators, loads, protection, bulk capacitance, current budget, dropout, and regulator thermal risk. Returns machine-readable issues and a human-readable summary.

### Input Parameters

| Parameter     | Type  | Required | Description |
| ------------- | ----- | -------- | ----------- |
| `projectId`   | `any` | No       |             |
| `rails`       | `any` | Yes      |             |
| `sources`     | `any` | No       |             |
| `regulators`  | `any` | No       |             |
| `loads`       | `any` | No       |             |
| `protections` | `any` | No       |             |
| `capacitors`  | `any` | No       |             |
| `limits`      | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  passed: any;
  rails: any;
  regulators: any;
  issues: any;
  summary: any;
}
```

---

## `easyeda_production_qa_artifacts`

**Profile:** `pro` | **Risk Level:** `low`

> Generate testpoint checklist, assembly notes, bring-up plan, production QA checklist, and machine-readable QA manifest for board handoff.

### Input Parameters

| Parameter                | Type  | Required | Description |
| ------------------------ | ----- | -------- | ----------- |
| `projectId`              | `any` | No       |             |
| `projectName`            | `any` | No       |             |
| `revision`               | `any` | No       |             |
| `criticalNets`           | `any` | No       |             |
| `components`             | `any` | No       |             |
| `requiresProgramming`    | `any` | No       |             |
| `programmingInterfaces`  | `any` | No       |             |
| `hasProgrammingAccess`   | `any` | No       |             |
| `hasBattery`             | `any` | No       |             |
| `requiresFunctionalTest` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  project_name: any;
  revision: any;
  passed: any;
  issues: any;
  checklist: any;
  artifacts: any;
  summary: any;
}
```

---

## `easyeda_project_save`

**Profile:** `core` | **Risk Level:** `medium`

> Explicitly save the current EasyEDA Pro project. This ensures all netlist changes, net flags, pin connections, and other mutations are persisted to the project file. Save is never implicit — the caller must explicitly request it. Requires confirmWrite.

### Input Parameters

| Parameter      | Type  | Required | Description                      |
| -------------- | ----- | -------- | -------------------------------- |
| `projectId`    | `any` | Yes      | The project/schematic ID to save |
| `confirmWrite` | `any` | Yes      |                                  |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  project_id: any;
  saved_at: any;
  error: any;
}
```

---

## `easyeda_rule_check_summary`

**Profile:** `core` | **Risk Level:** `low`

> Get a summary of all design and electrical rule check results for the project.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  drc: any;
  erc: any;
  overall_passed: any;
  not_available: any;
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
  passed: any;
  checks: any;
}
```

---

## `easyeda_schematic_add_wire`

**Profile:** `core` | **Risk Level:** `medium`

> Add a wire segment connecting schematic coordinates/pins.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `points`       | `any` | Yes      |             |
| `netName`      | `any` | No       |             |
| `color`        | `any` | No       |             |
| `lineWidth`    | `any` | No       |             |
| `lineType`     | `any` | No       |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  wire: any;
  error: any;
}
```

---

## `easyeda_schematic_component_pins`

**Profile:** `core` | **Risk Level:** `low`

> Get exact pin numbers, names, and coordinates for a schematic component by its primitive ID.

### Input Parameters

| Parameter     | Type  | Required | Description |
| ------------- | ----- | -------- | ----------- |
| `primitiveId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  primitiveId: any;
  pins: any;
  success: any;
  error: any;
}
```

---

## `easyeda_schematic_components`

**Profile:** `core` | **Risk Level:** `low`

> List all components in the schematic with their properties including reference, value, footprint, LCSC part number, manufacturer, and datasheet.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `limit`     | `any` | Yes      |             |
| `offset`    | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  components: any;
  total: any;
  not_available: any;
  error: any;
}
```

---

## `easyeda_schematic_connect_pin_to_net`

**Profile:** `core` | **Risk Level:** `medium`

> Connect a specific component pin to a named net. This creates an actual SCH_Netlist entry associating the pin with the net. If the net does not exist yet, it is created on the fly. This is the core tool for populating the real EasyEDA netlist with pin-to-net connectivity.

### Input Parameters

| Parameter      | Type  | Required | Description                                                          |
| -------------- | ----- | -------- | -------------------------------------------------------------------- |
| `projectId`    | `any` | Yes      | The project/schematic ID                                             |
| `primitiveId`  | `any` | Yes      | The primitive ID of the component                                    |
| `pinNumber`    | `any` | Yes      | The pin number or pin name on the component (e.g. "1", "VCC", "GND") |
| `netName`      | `any` | Yes      | The net name to connect the pin to (e.g. VCC, GND, DATA0)            |
| `confirmWrite` | `any` | Yes      |                                                                      |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  connection: any;
  error: any;
}
```

---

## `easyeda_schematic_connect_pins_by_net`

**Profile:** `core` | **Risk Level:** `medium`

> Connect multiple component pins to a named net in a single operation. All specified pins will be assigned to the same net, creating SCH_Netlist entries. If the net does not exist, it is created. This is the bulk equivalent of connect_pin_to_net.

### Input Parameters

| Parameter      | Type  | Required | Description                                  |
| -------------- | ----- | -------- | -------------------------------------------- |
| `projectId`    | `any` | Yes      | The project/schematic ID                     |
| `netName`      | `any` | Yes      | The net name to assign pins to               |
| `pins`         | `any` | Yes      | List of component pins to connect to the net |
| `confirmWrite` | `any` | Yes      |                                              |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  connections: any;
  count: any;
  error: any;
}
```

---

## `easyeda_schematic_create_net_flag`

**Profile:** `core` | **Risk Level:** `medium`

> Create a named schematic net flag at specified coordinates. This controlled write declares real SCH_Net connectivity in the EasyEDA Pro netlist.

### Input Parameters

| Parameter        | Type  | Required | Description                                                                                                                                           |
| ---------------- | ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`      | `any` | Yes      | The project/schematic ID                                                                                                                              |
| `netName`        | `any` | Yes      | The net name to assign (e.g. VCC, GND, TEST_NET)                                                                                                      |
| `x`              | `any` | Yes      | X coordinate on the schematic canvas                                                                                                                  |
| `y`              | `any` | Yes      | Y coordinate on the schematic canvas                                                                                                                  |
| `rotation`       | `any` | No       | Rotation in degrees (0, 90, 180, 270)                                                                                                                 |
| `identification` | `any` | No       | Power-flag identification. When set, places an EasyEDA power/ground flag symbol of this type. When omitted, places a generic named net label instead. |
| `confirmWrite`   | `any` | Yes      |                                                                                                                                                       |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  netFlag: any;
  error: any;
}
```

---

## `easyeda_schematic_create_net_port`

**Profile:** `core` | **Risk Level:** `medium`

> Place a hierarchical net port (off-sheet connector) on the schematic. Net ports create named connections that span multiple schematic sheets, appearing as real SCH_Net entries in the netlist.

### Input Parameters

| Parameter      | Type  | Required | Description                                         |
| -------------- | ----- | -------- | --------------------------------------------------- |
| `projectId`    | `any` | Yes      | The project/schematic ID                            |
| `netName`      | `any` | Yes      | The net name for the port (e.g. VCC, GND, DATA_BUS) |
| `x`            | `any` | Yes      | X coordinate on the schematic canvas                |
| `y`            | `any` | Yes      | Y coordinate on the schematic canvas                |
| `portType`     | `any` | No       | Electrical type of the port                         |
| `rotation`     | `any` | No       | Rotation in degrees (0, 90, 180, 270)               |
| `confirmWrite` | `any` | Yes      |                                                     |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  netPort: any;
  error: any;
}
```

---

## `easyeda_schematic_delete_primitive`

**Profile:** `core` | **Risk Level:** `medium`

> Delete components, wires, or other drawing objects from the schematic by their primitive UUIDs.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `primitiveIds` | `any` | Yes      |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  error: any;
}
```

---

## `easyeda_schematic_modify_primitive`

**Profile:** `core` | **Risk Level:** `medium`

> Modify properties (value, reference, attributes, etc.) of a schematic component/object.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `primitiveId`  | `any` | Yes      |             |
| `property`     | `any` | Yes      |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  result: any;
  error: any;
}
```

---

## `easyeda_schematic_net_detail`

**Profile:** `core` | **Risk Level:** `low`

> Get full details for a specific net in the schematic including all connected pins and components.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |
| `netName`   | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  net_name: any;
  node_count: any;
  nodes: any;
  not_available: any;
}
```

---

## `easyeda_schematic_nets`

**Profile:** `core` | **Risk Level:** `low`

> List all nets in the schematic with their node connections.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  nets: any;
  total: any;
  not_available: any;
}
```

---

## `easyeda_schematic_place_component`

**Profile:** `core` | **Risk Level:** `medium`

> Place a library component/device on the active schematic sheet.

### Input Parameters

| Parameter      | Type  | Required | Description |
| -------------- | ----- | -------- | ----------- |
| `deviceItem`   | `any` | Yes      |             |
| `x`            | `any` | Yes      |             |
| `y`            | `any` | Yes      |             |
| `subPartName`  | `any` | No       |             |
| `rotation`     | `any` | No       |             |
| `mirror`       | `any` | No       |             |
| `addIntoBom`   | `any` | No       |             |
| `addIntoPcb`   | `any` | No       |             |
| `confirmWrite` | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  success: any;
  component: any;
  error: any;
}
```

---

## `easyeda_schematic_search_device`

**Profile:** `core` | **Risk Level:** `low`

> Search for schematic symbols/devices in the EasyEDA library by keywords.

### Input Parameters

| Parameter        | Type  | Required | Description |
| ---------------- | ----- | -------- | ----------- |
| `key`            | `any` | Yes      |             |
| `libraryUuid`    | `any` | No       |             |
| `classification` | `any` | No       |             |
| `symbolType`     | `any` | No       |             |
| `itemsOfPage`    | `any` | Yes      |             |
| `page`           | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  devices: any;
  total: any;
  not_available: any;
  error: any;
}
```

---

## `easyeda_schematic_sheet_info`

**Profile:** `core` | **Risk Level:** `low`

> Return read-only active schematic sheet metadata including page size, frame, origin, and grid hints for safer component placement.

### Input Parameters

| Parameter   | Type  | Required | Description |
| ----------- | ----- | -------- | ----------- |
| `projectId` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  sheet: any;
  page_size: any;
  frame: any;
  origin: any;
  grid: any;
  raw: any;
  not_available: any;
  error: any;
}
```

---

## `easyeda_schematic_validate_netlist`

**Profile:** `core` | **Risk Level:** `low`

> Validate the EasyEDA Pro schematic netlist for connectivity issues. Reports net names, connected component references and pins, floating pins, graphical wires without netlist connectivity, and mismatches between visual wires and actual SCH_Net/SCH_Netlist entries. This is a read-only diagnostic tool.

### Input Parameters

| Parameter          | Type  | Required | Description                                                            |
| ------------------ | ----- | -------- | ---------------------------------------------------------------------- |
| `projectId`        | `any` | Yes      | The project/schematic ID                                               |
| `includeWireCheck` | `any` | Yes      | When true, also check for graphical wires without netlist connectivity |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  netlist: any;
  total_nets: any;
  floating_pins: any;
  wires_without_netlist: any;
  valid: any;
  warnings: any;
  not_available: any;
  error: any;
}
```

---

## `easyeda_semantic_erc_validate`

**Profile:** `core` | **Risk Level:** `medium`

> Run semantic electrical-rule validation over a netlist with pin electrical types to detect output contention, floating inputs, power conflicts, missing power pins, missing decoupling, and voltage-domain mismatches.

### Input Parameters

| Parameter    | Type  | Required | Description |
| ------------ | ----- | -------- | ----------- |
| `projectId`  | `any` | No       |             |
| `nets`       | `any` | Yes      |             |
| `devices`    | `any` | No       |             |
| `interfaces` | `any` | No       |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  project_id: any;
  passed: any;
  error_count: any;
  warning_count: any;
  total_issues: any;
  errors: any;
  warnings: any;
}
```

---

## `easyeda_wire_probe`

**Profile:** `dev` | **Risk Level:** `low`

> Inspect live schematic wire objects, including line coordinates, net names, methods, and state getter values, to validate EasyEDA runtime mappings.

### Input Parameters

| Parameter | Type  | Required | Description |
| --------- | ----- | -------- | ----------- |
| `limit`   | `any` | Yes      |             |

### Output Format

Returns a JSON object matching the schema:

```ts
{
  total: any;
  samples: any;
  not_available: any;
  error: any;
}
```

---
