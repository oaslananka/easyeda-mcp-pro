# Bridge Handshake Contract

The EasyEDA bridge extension and MCP server use a versioned WebSocket handshake contract. This contract is intentionally small and deterministic so compatibility can be verified before any EasyEDA API calls are sent.

## Constants

| Field             | Current value            | Owner                |
| ----------------- | ------------------------ | -------------------- |
| `protocol`        | `easyeda-mcp-pro.bridge` | Server and extension |
| `clientName`      | `easyeda-mcp-pro`        | Extension            |
| `contractVersion` | `1`                      | Server and extension |
| `protocolVersion` | `1.0.0`                  | Server and extension |

The server keeps the supported protocol list in `SUPPORTED_PROTOCOL_VERSIONS`. Unsupported protocol versions are rejected during handshake schema validation.

## Client handshake

The extension sends:

```json
{
  "type": "handshake",
  "protocol": "easyeda-mcp-pro.bridge",
  "protocolVersion": "1.0.0",
  "contractVersion": 1,
  "clientName": "easyeda-mcp-pro",
  "extensionVersion": "<extension package version>",
  "easyedaVersion": "<runtime version>",
  "devMode": false
}
```

If `BRIDGE_TOKEN` is configured, the extension must include `sessionToken` after completing any pairing challenge required by the deployment mode.

## Server hello

After accepting the handshake, the server replies:

```json
{
  "type": "hello",
  "bridgeVersion": "<server package version>",
  "contractVersion": 1,
  "supportedProtocolVersions": ["1.0.0"],
  "easyedaVersion": "<runtime version>",
  "capabilities": ["schematic.listNets"],
  "methodRegistryHash": "<16-char sha256 prefix>",
  "devMode": false,
  "maxPayloadSize": 1048576
}
```

`methodRegistryHash` is computed from the sorted bridge method registry. A changed hash means the server and extension should be rechecked against the live compatibility smoke harness.

`maxPayloadSize` mirrors the server's configured `BRIDGE_MAX_PAYLOAD_SIZE` (bytes). The
extension uses it to self-limit binary (Blob/File) results — e.g. `canvas.capture` and
the `export.*` methods — before sending, since a response frame that exceeds this limit
closes the whole WS connection (code 4009), not just the offending call.

## Compatibility rules

- Reject wrong `protocol` or `clientName`.
- Reject unsupported `protocolVersion` at schema boundary.
- Preserve `contractVersion` in both handshake and hello.
- Warn when extension and server package versions differ.
- Include `methodRegistryHash` in every hello.
- Extension logs a warning when the hello contract version differs or does not list its protocol version.
- Extension self-limits binary (Blob/File) results to a safety margin under `maxPayloadSize`
  before sending, returning a structured `PAYLOAD_TOO_LARGE` error instead of an oversized frame.

## Release checklist

Before marking a release compatible with a live EasyEDA Pro version:

1. Confirm `package.json`, `server.json`, `src/config/version.ts`, and extension metadata are in sync.
2. Confirm bridge protocol tests pass.
3. Run `pnpm smoke:easyeda` against a disposable project with `EASYEDA_LIVE_TESTS=true`.
4. Record the EasyEDA Pro version, extension version, server version, and method registry hash in the compatibility report.
