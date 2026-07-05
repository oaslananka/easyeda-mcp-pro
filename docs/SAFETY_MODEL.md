# Safety Model

This document explains the security posture, permission checks, data privacy controls, and risk levels associated with the MCP tools in `easyeda-mcp-pro`.

---

## 1. Tool Classifications

Our tools are categorized into three risk tiers based on their potential impact on project data and external services:

| Risk Level | Tool Type                              | Description                                                                                                                                                                                                                                                                                                                  | Confirmation Required         |
| :--------- | :------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------- |
| **Low**    | `Read-only` / `Diagnostics` / `Visual` | Queries project metadata, diagnostics status, layers, stackups, BOM, and canvas captures (`easyeda_canvas_capture`, `easyeda_canvas_capture_region`, `easyeda_canvas_locate`). Cannot mutate project state, though a capture/locate call does move the user's visible viewport (EasyEDA Pro has no offscreen rendering API). | **No**                        |
| **Medium** | `Schematic Write`                      | Mutates schematic sheets (placing components, drawing wires, deleting or modifying primitives).                                                                                                                                                                                                                              | **Yes (`confirmWrite=true`)** |
| **High**   | `PCB Write` / `Exports` / `API Call`   | Mutates PCB layouts (tracks, vias, zones, components), exports fabrication files, or makes direct class-method calls.                                                                                                                                                                                                        | **Yes (`confirmWrite=true`)** |

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

---

## 4. Secrets Redaction

All API keys, OAuth secrets, session tokens, and passwords are redacted from log outputs and diagnostics tools.

- `easyeda_get_server_config` filters out credentials, returning only safe configuration variables (e.g. port, transport, environment).
- The internal logger automatically redacts credentials matching key patterns before writing them to the console or logs.
