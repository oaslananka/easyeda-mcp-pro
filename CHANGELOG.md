# Changelog

## [0.6.3](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.6.2...easyeda-mcp-pro-v0.6.3) (2026-06-30)


### Bug Fixes

* support EasyEDA v3 bridge handshake fallback ([deb86d9](https://github.com/oaslananka/easyeda-mcp-pro/commit/deb86d9055a967225bf16fa0896870d021f1587f))

## [0.6.2](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.6.1...easyeda-mcp-pro-v0.6.2) (2026-06-30)


### Bug Fixes

* make Docker pnpm prune non-interactive ([cb68b3d](https://github.com/oaslananka/easyeda-mcp-pro/commit/cb68b3d9ef7121b871c41bdbd8c28c86a15deb40))
* make Docker pnpm prune non-interactive ([6c13148](https://github.com/oaslananka/easyeda-mcp-pro/commit/6c13148b23d15d12e7b4cdadad596441715bf64e))

## [0.6.1](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.6.0...easyeda-mcp-pro-v0.6.1) (2026-06-30)


### Bug Fixes

* repair Docker and MCP registry publishing ([3309e2a](https://github.com/oaslananka/easyeda-mcp-pro/commit/3309e2af6b13a30118a4c225f40a0be3a2c0ff13))
* repair Docker and MCP registry publishing ([4c76d5b](https://github.com/oaslananka/easyeda-mcp-pro/commit/4c76d5b4bc5124a24c493188dc64c6e6d731c26d))

## [0.6.0](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.5.3...easyeda-mcp-pro-v0.6.0) (2026-06-30)


### Features

* add live EasyEDA smoke harness ([ac01112](https://github.com/oaslananka/easyeda-mcp-pro/commit/ac01112e1c87e21cb36ad9f4759dd3e2329a6db4))
* add project resources and review prompts ([4895c8c](https://github.com/oaslananka/easyeda-mcp-pro/commit/4895c8c46acea91f19e9d0706dc1e91d49c5bd78))
* add runtime inventory diff tooling ([9827694](https://github.com/oaslananka/easyeda-mcp-pro/commit/982769455ee7fe63985907576402d8062d9ef319))
* expand circuit ir domains and constraints ([301f3c8](https://github.com/oaslananka/easyeda-mcp-pro/commit/301f3c8890d3ea936b1b6002f13669998511beef))
* expose bridge telemetry diagnostics ([1836ed4](https://github.com/oaslananka/easyeda-mcp-pro/commit/1836ed4941e8b0ca6d7de4335e5c851a4d9ffc41))
* extend doctor command with environment metadata and tool profiles ([#39](https://github.com/oaslananka/easyeda-mcp-pro/issues/39)) ([291afb6](https://github.com/oaslananka/easyeda-mcp-pro/commit/291afb6b5fb51dcc1cade760bd55e9d4cf458717))
* synthesize circuit intent planning context ([1ff30ea](https://github.com/oaslananka/easyeda-mcp-pro/commit/1ff30eab030484783215e1e5608657e611deb949))


### Bug Fixes

* add capability-scoped tool authorization ([e9b0f80](https://github.com/oaslananka/easyeda-mcp-pro/commit/e9b0f80c796529d867d77d277855be876e467b82))
* add write transaction planning flow ([43b6735](https://github.com/oaslananka/easyeda-mcp-pro/commit/43b6735acb1a2c5edee7b1c6a74e7e5d712ca8d4))
* align release metadata and tool profiles ([6f58f8c](https://github.com/oaslananka/easyeda-mcp-pro/commit/6f58f8c36a9b98da0f11715887df29f6ac45edf5))
* **docker:** copy .npmrc into builder so confirmModulesPurge=false applies ([48d2890](https://github.com/oaslananka/easyeda-mcp-pro/commit/48d2890d0ce00deadf252614b7de3f01439d35e7))
* harden http transport origin checks ([7423f77](https://github.com/oaslananka/easyeda-mcp-pro/commit/7423f77ebc7c9b02a0cd064d081bcbf96cb65bc6))
* harden release gates and HTTP auth ([5ac4ecb](https://github.com/oaslananka/easyeda-mcp-pro/commit/5ac4ecb86ee54255ce95017c84977d83f3121f3d))
* harden release gates and HTTP auth ([9234b63](https://github.com/oaslananka/easyeda-mcp-pro/commit/9234b63f5ef509d069f4dadc2ad559d0a3e9fd40))
* quarantine raw execution tool ([1cd3f1b](https://github.com/oaslananka/easyeda-mcp-pro/commit/1cd3f1b0361761f9e980b50628d05dcc45d9037f))
* validate tool output schemas ([30c4e4f](https://github.com/oaslananka/easyeda-mcp-pro/commit/30c4e4f6c305c8c40a05be66f8fe8c032a2431cd))
* version bridge contract ([9ebdf47](https://github.com/oaslananka/easyeda-mcp-pro/commit/9ebdf47de07d419a2cebcd6e487a611c467f0a7f))

## [0.5.3](https://github.com/oaslananka/easyeda-mcp-pro/compare/easyeda-mcp-pro-v0.5.2...easyeda-mcp-pro-v0.5.3) (2026-06-14)


### Bug Fixes

* **ci:** permanently resolve recurring format and docker failures ([37a6463](https://github.com/oaslananka/easyeda-mcp-pro/commit/37a6463efcf111d444bc8e1c4d3f34b79d7565c6))
* **ci:** use standard approach for format and pnpm prod-install ([ac21e93](https://github.com/oaslananka/easyeda-mcp-pro/commit/ac21e93dc79c9d5e5399338b0da0cfea6172a2f1))

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
