# Changelog

## [0.5.2](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.5.1...easyeda-mcp-pro-v0.5.2) (2026-06-14)

### Bug Fixes

- **ci:** format release-please files and fix SBOM pnpm compatibility ([e366fec](https://github.com/oaslananka/easyeda-mcp-pro/commit/e366fec56ff79c576c1b6b4299a011bab95a85a2))

## [0.5.1](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.5.0...easyeda-mcp-pro-v0.5.1) (2026-06-14)

### Bug Fixes

- **server.json:** sync env var definitions with env.ts ([902fbe5](https://github.com/oaslananka/easyeda-mcp-pro/commit/902fbe5f4f110ac2db0d1d3908f884a0c9e81e54))

## [0.5.0](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.4.0...easyeda-mcp-pro-v0.5.0) (2026-06-13)

### Features

- initial commit - easyeda-mcp-pro MCP server ([c82ef0c](https://github.com/oaslananka/easyeda-mcp-pro/commit/c82ef0cefd1788229153497217b6341b2fce700d))

### Bug Fixes

- remove unused 'allRefs' variable in bridge extension ([34c511d](https://github.com/oaslananka/easyeda-mcp-pro/commit/34c511de46a2fe2a5c1030644225d9271d20e9ff))
- resolve CI failures - syntax error in \_e2e_http.mjs and Prettier formatting ([cd43b48](https://github.com/oaslananka/easyeda-mcp-pro/commit/cd43b48548ae34023e2213d0e9f7ce1145258646))
- resolve ESLint errors - remove unused imports and variables ([a5cd678](https://github.com/oaslananka/easyeda-mcp-pro/commit/a5cd6784752dcaf0b0006c88036b6ca3ef6edbf7))

## [0.4.0](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.3.2...easyeda-mcp-pro-v0.4.0) (2026-06-10)

### Features

- add documentation, schematic tools, profiles, and release automation workflows ([3f6ee0d](https://github.com/oaslananka/easyeda-mcp-pro/commit/3f6ee0dc8889f0b317da128118e731d73968cdb1))
- initialize VitePress documentation and add deployment workflow ([a2ffa04](https://github.com/oaslananka/easyeda-mcp-pro/commit/a2ffa04c4013d248844e9439849c7235275176f1))

### Bug Fixes

- **ci:** add manual workflow_dispatch trigger to deploy-docs ([4730eac](https://github.com/oaslananka/easyeda-mcp-pro/commit/4730eac2cd6ada2427c9f52ab56f6e71a7c1fd39))
- **ci:** fix release-please-action SHA pin and enable docs pages auto-creation ([5ef7ae3](https://github.com/oaslananka/easyeda-mcp-pro/commit/5ef7ae3e2c5c94d343cccdeebec6ff3e0cbe1644))
- **ci:** solve release-please token auth and escape vitepress template expressions ([ca90606](https://github.com/oaslananka/easyeda-mcp-pro/commit/ca906068ed96eceda4a278bb726843ef3abdc985))
- **ci:** use verified SHAs for Pages deployment actions ([353c2fc](https://github.com/oaslananka/easyeda-mcp-pro/commit/353c2fc4c2cfca5a19121e111b7129b1b3270461))

## v0.3.2 (2026-06-05)

### Fixed

- **BOM Sourcing & Validate**: Query LCSC client directly for stock, pricing, and obsolete parts.
- **Export tools**: Call specific bridge endpoints (`export.pickPlace`, `export.pdf`, `export.netlist`).
- **PCB Write tools**: Add 6 new tools in full profile (`place_component`, `add_track`, `add_via`, `add_zone`, `delete_component`, `modify_component`).
- **Schematic Net Detail**: Call `schematic.getNetDetail` for exact node connections.
- **Test Coverage**: Added 4 new test suites, raising test coverage to 111 tests.

## v0.3.1 (2026-06-05)

### Security

- **OAuth/JWKS validation**: HTTP transport now validates Bearer tokens against a configurable JWKS URI when `OAUTH_ENABLED=true`. Supports issuer, audience, and scope claims.
- **Rate limiting**: HTTP transport enforces configurable per-IP rate limits (`HTTP_RATE_LIMIT_MAX`, default 100 req/min) with `X-RateLimit-*` headers.
- **Security headers**: HTTP responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, and `Referrer-Policy` headers.
- **Path traversal protection**: `easyeda_bom_export` validates file paths against `ARTIFACT_DIR` to prevent directory traversal attacks.
- **Bridge port scanning**: `BRIDGE_PORT_SCAN` config (e.g. `"18601,49620-49629"`) parses comma-separated ports and dash ranges, trying each in sequence.

### Changed

- Use a single registry-based MCP server entry point for stdio and Streamable HTTP transports.
- Move storage from `better-sqlite3` to Node.js `node:sqlite`, removing the native addon dependency.
- Convert the EasyEDA bridge extension to the typed `handshake` / `request` / `response` protocol.
- Manage the EasyEDA bridge extension as a pnpm workspace package and build it in CI.
- Add `easyeda-mcp-pro --setup-local` and `--doctor` for no-terminal MCP client auto-start setup and local bridge diagnostics.
- Include the generated `easyeda-bridge-extension.eext` package in npm publish artifacts.
- **Tool profiles**: Replace inflated `approxToolCount` values (35-50, 80-120, 200+) with accurate counts (22 core, 25 pro, 26 full).
- **Bridge health**: `easyeda_health_check` now reflects real bridge connection state instead of hardcoded `false`.
- **Bridge status**: `easyeda_bridge_status` queries the extension for version and capability data when connected.
- **Schematic editing**: Add MCP tools for library device search, component placement, wire creation, and schematic primitive delete/modify.
- **EasyEDA API resolution**: Bridge extension now tries both documented uppercase API class names (`LIB_Device`, `SCH_PrimitiveWire`, etc.) and runtime lowercase variants.
- **EasyEDA full-control API bridge**: Add `easyeda_api_inventory` and `easyeda_api_call` so MCP clients can inspect the live EasyEDA Pro runtime and call documented `DMT_*`, `SCH_*`, `PCB_*`, and `LIB_*` class methods without raw JavaScript execution.
- **EasyEDA runtime probes**: Add `easyeda_component_probe` for validating live schematic component object shape, available methods, and state getter values during bridge debugging.
- **Board tools**: `easyeda_board_dimensions` and `easyeda_board_features` now use real bridge API calls instead of stub responses.
- **Bridge protocol**: Add `board.getDimensions`, `board.getFeatures`, `system.getStatus`, `system.apiInventory`, `system.inspectComponents`, and `api.call` to the supported API method registry.
- **Bridge manager**: Export `parsePortScanSpec()` utility; add `activePort` and `uptimeMs` accessors.
- **Bridge connection lifecycle**: Replace stale EasyEDA bridge clients after a validated handshake and ignore stale socket close events.
- **Bridge extension auto-connect**: Keep retrying auto-connect until the server is available unless the user explicitly disconnects.
- **Bridge extension package**: Bump the EasyEDA extension manifest to `0.3.1` and use the documented `./dist/index` entry path so EasyEDA imports the rebuilt package as a real update.

### Fixed

- Align runtime tool names with the documented `easyeda_*` MCP tool set.
- Remove stale generated/local-state files from the tracked project structure.
- Replace secret-shaped redaction test data with an explicit non-secret fixture.
- Stabilize EasyEDA extension connect/disconnect/status behavior with a single connection state machine and clearer user-facing status messages.
- Exclude ignored local `TEMP/` diagnostics from ESLint so ad-hoc local bridge scripts do not break project lint.

## v0.2.0 (2026-06-04)

### Features

- Upgrade dotenv to v17 and pnpm to v11 (#4, #13)
- Add comprehensive README with full documentation (#3, #19)
- Add issue templates (bug report, feature request) and expanded label taxonomy (#9, #17)
- Add release workflow for automated npm publishing (#6, #15)

### Security

- Enable branch protection on main branch (#1)
- Enable CodeQL scanning (security-extended + security-and-quality queries) (#2, #10)
- Replace Dependabot with Renovate per org policy (#18)
- Pin GitHub Actions to commit SHAs, upgrade CodeQL v3→v4 (#6, #15)

### Bug Fixes

- Update @types/node to match Node 24 engine requirement (#7, #14)
- Add 'silent' to LOG_LEVEL Zod enum to match pino level union (#9)
- Resolve all 8 eslint non-null-assertion warnings (#5, #16)

### Infrastructure

- Add pnpm-workspace.yaml with allowBuilds configuration (#4)
- Add server.json for MCP Registry publishing

## v0.1.0 (2026-05)

- Initial release
- Core MCP toolset for EasyEDA Pro
- Bridge protocol for EasyEDA Pro plugin communication
- Vendor integrations: JLCPCB, LCSC, Mouser, DigiKey
- SQLite storage with caching
- HTTP and stdio transports
