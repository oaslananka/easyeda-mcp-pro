# easyeda-mcp-pro

**Production-grade MCP server for EasyEDA Pro: safe PCB design inspection, BOM sourcing, manufacturing export, and AI-assisted hardware review.**

[![CI](https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/easyeda-mcp-pro.svg)](https://www.npmjs.com/package/easyeda-mcp-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13406/badge)](https://www.bestpractices.dev/projects/13406)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/oaslananka/easyeda-mcp-pro)

Compliance docs: [Third-Party Notices](THIRD_PARTY_NOTICES.md) · [Vendor Terms and Unsupported Workflows](docs/vendor-terms.md)

<p align="center">
  <a href="https://www.buymeacoffee.com/oaslananka">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=oaslananka&button_colour=FFDD00&font_colour=000000&font_family=Arial&outline_colour=000000&coffee_colour=ffffff" alt="Buy me a coffee" />
  </a>
</p>

---

## Quick Start

The fastest way to install and configure `easyeda-mcp-pro` for your favorite AI assistant or IDE:

1. **Auto-configure your MCP client:**

   ```bash
   npx easyeda-mcp-pro setup all
   ```

   _This detects and configures Claude Desktop, Cursor, VS Code, Windsurf, Cline, Gemini, Zed, etc. to run the MCP server automatically._
   _(Or run for a specific client, e.g., `npx easyeda-mcp-pro setup claude`)_

2. **Locate and install the EasyEDA Pro bridge extension:**

   ```bash
   npx easyeda-mcp-pro extension --open
   ```

   _This opens the folder containing the extension package `easyeda-bridge-extension.eext`. Import it via **EasyEDA Pro → Settings → Extensions → Extension Manager**._

3. **Connect the bridge:**
   In EasyEDA Pro, click **MCP Bridge → Connect** in the menu bar.

For advanced configurations, manual instructions, and specific clients, see [Installation & Client Configuration](#installation--client-configuration).

---

## Overview

easyeda-mcp-pro is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that bridges AI assistants with hardware design workflows in EasyEDA Pro. It exposes up to 60 profile-gated MCP tools for schematic inspection and editing, controlled EasyEDA Pro API calls, BOM management, design rule checks, PCB board analysis, fabrication exports, and supplier integration.

The server connects to EasyEDA Pro via a WebSocket bridge extension, enabling real-time access to open project data. It integrates with JLCPCB, LCSC, Mouser, and DigiKey for BOM sourcing and pricing.

### Key Capabilities

| Area            | What you can do                                                       |
| --------------- | --------------------------------------------------------------------- |
| **Schematic**   | List nets/components, search and place devices, edit wires/primitives |
| **BOM**         | Generate, validate, export, and source bill of materials              |
| **DRC/ERC**     | Run design rule and electrical rule checks                            |
| **Board**       | Inspect layers, stackup, dimensions, features                         |
| **Export**      | Export Gerbers, pick-and-place, PDF, netlist                          |
| **Diagnostics** | Health check, bridge status, API inventory, capabilities, self-test   |

---

## Prerequisites

- **Node.js** >=24 <27 (required for the latest JavaScript features)
- **pnpm** >=11 (for local development; the npm package is self-contained)
- **EasyEDA Pro** with the bundled bridge extension installed and running
- For supplier integration: API credentials from JLCPCB, LCSC, Mouser, or DigiKey

---

## Installation & Client Configuration

You can configure `easyeda-mcp-pro` automatically or manually.

### 1. Automatic Configuration (CLI)

The CLI setup automates editing the configuration files for your client:

```bash
# Configure all detected clients automatically
npx easyeda-mcp-pro setup all

# Or configure a specific client
npx easyeda-mcp-pro setup <client>
```

#### Supported Client Keys:

- `claude` (Claude Desktop)
- `cursor` (Cursor IDE)
- `vscode` (VS Code Copilot)
- `windsurf` (Windsurf)
- `cline` (Cline)
- `gemini` (Gemini CLI / Antigravity)
- `zed` (Zed Editor)
- `amazonq` (Amazon Q Developer)
- `continue` (Continue.dev)

#### Options:

- `--profile <name>`: Specify the tool profile. Options: `core` (default), `pro`, `full`, `dev`.
  Example: `npx easyeda-mcp-pro setup cursor --profile full`

### 2. Extension Installation

To bridge the MCP server with EasyEDA Pro:

```bash
# Open the directory containing the .eext extension package in your file manager
npx easyeda-mcp-pro extension --open

# Or copy it to a specific directory
npx easyeda-mcp-pro extension --copy /path/to/destination
```

**Installation steps in EasyEDA Pro:**

1. Open **EasyEDA Pro**.
2. Go to **Settings** → **Extensions** → **Extension Manager**.
3. Click **Import Extension** and select the `easyeda-bridge-extension.eext` file.
4. Ensure **Allow External Interaction** is enabled for the extension.
5. Click **MCP Bridge** → **Connect** in the menu bar.

---

### 3. Manual Client Configurations

If you prefer to configure your clients manually, add the following configuration to the respective settings files:

<details>
<summary>🟣 Claude Desktop</summary>

**Config Path:**

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "core"
      }
    }
  }
}
```

</details>

<details>
<summary>🔵 Cursor IDE</summary>

**Config Path:** Project-specific `.cursor/mcp.json` or global `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

</details>

<details>
<summary>🟢 VS Code (GitHub Copilot)</summary>

**Config Path:** `%APPDATA%\Code\User\mcp.json` (Windows), `~/Library/Application Support/Code/User/mcp.json` (macOS), or `~/.config/Code/User/mcp.json` (Linux)

```json
{
  "servers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

</details>

<details>
<summary>🏄 Windsurf (Codeium)</summary>

**Config Path:** `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

</details>

<details>
<summary>🤖 Cline</summary>

**Config Path:** Cline VS Code extension global storage (`cline_mcp_settings.json`)

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

</details>

<details>
<summary>✨ Gemini CLI / Antigravity</summary>

**Config Path:** `~/.gemini/settings.json` or `~/.gemini/config/mcp_config.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

</details>

<details>
<summary>⚡ Zed Editor</summary>

**Config Path:** `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "easyeda-mcp-pro": {
      "command": {
        "path": "npx",
        "args": ["-y", "easyeda-mcp-pro@latest"]
      },
      "settings": {}
    }
  }
}
```

</details>

<details>
<summary>🔄 Continue.dev</summary>

**Config Path:** `~/.continue/config.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

</details>

<details>
<summary>👑 Amazon Q Developer</summary>

**Config Path:** `~/.aws/amazonq/mcp.json`

```json
{
  "mcpServers": {
    "easyeda-mcp-pro": {
      "command": "npx",
      "args": ["-y", "easyeda-mcp-pro@latest"],
      "env": {
        "TOOL_PROFILE": "pro"
      }
    }
  }
}
```

</details>

---

### 4. Running from Source (Development)

If you are developing or running a modified local build:

```bash
git clone https://github.com/oaslananka/easyeda-mcp-pro.git
cd easyeda-mcp-pro
cp .env.example .env
pnpm install

# Build the server and the bridge extension package
pnpm build
pnpm build:extension
```

To configure your clients to use the local development build:

```bash
# Print instructions and local config block pointing to dist/index.js
node dist/index.js --setup-local
```

### Local Diagnostics & Health Check

You can diagnose your environment and bridge connectivity at any time:

```bash
pnpm doctor
```

This checks:

1. Node.js version compatibility.
2. Existence of build files and the `.eext` extension package.
3. Bridge port availability. _Note: The bridge status will show as offline until an MCP client starts the server and connects to the EasyEDA Pro extension._

---

## Configuration

Copy `.env.example` to `.env` and edit. All variables have safe defaults — only configure what you need.

### Essential

| Variable               | Default       | Description                                                                  |
| ---------------------- | ------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`             | `development` | Set to `production` in production                                            |
| `LOG_LEVEL`            | `info`        | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `TOOL_PROFILE`         | `core`        | Tool set: `core`, `pro`, `full`, `dev`, `experimental`                       |
| `TOOL_SCOPES`          | empty         | Optional capability allowlist such as `schematic:read,bom:read`              |
| `MCP_PROTOCOL_VERSION` | `2025-11-25`  | MCP protocol version string                                                  |
| `TRANSPORT`            | `stdio`       | Server transport: `stdio` (default) or `http`                                |

### Bridge (EasyEDA Pro connection)

| Variable                        | Default       | Description                                                              |
| ------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `BRIDGE_HOST`                   | `127.0.0.1`   | Bridge WebSocket host                                                    |
| `BRIDGE_PORT`                   | `49620`       | Primary bridge port                                                      |
| `BRIDGE_PORT_SCAN`              | `49620-49629` | Port scan spec (comma/range)                                             |
| `BRIDGE_TIMEOUT_MS`             | `15000`       | Bridge call timeout (ms)                                                 |
| `BRIDGE_HEARTBEAT_MS`           | `10000`       | Heartbeat interval (ms)                                                  |
| `BRIDGE_RECONNECT_MAX_ATTEMPTS` | `0`           | Max reconnect attempts (`0` = infinite)                                  |
| `BRIDGE_WAIT_FOR_EDA_MS`        | `30000`       | Wait for EasyEDA Pro on startup (ms)                                     |
| `BRIDGE_MAX_PAYLOAD_SIZE`       | `1048576`     | Max bridge payload (bytes, default 1 MiB)                                |
| `BRIDGE_TOKEN`                  | `''`          | Session token for extension auth                                         |
| `BRIDGE_RAW_EXEC_ENABLED`       | `false`       | First explicit gate for raw EasyEDA runtime JavaScript execution         |
| `MCP_RAW_EXEC_EXPERIMENTAL`     | `false`       | Second experimental gate required before `easyeda_execute` is registered |

### Storage

| Variable       | Default                                   | Description                                 |
| -------------- | ----------------------------------------- | ------------------------------------------- |
| `DATA_DIR`     | `.easyeda-mcp-pro`                        | Data directory (cache, database, artifacts) |
| `SQLITE_PATH`  | `.easyeda-mcp-pro/easyeda-mcp-pro.sqlite` | SQLite database path                        |
| `ARTIFACT_DIR` | `.easyeda-mcp-pro/artifacts`              | Artifact export directory                   |
| `CACHE_DIR`    | `.easyeda-mcp-pro/cache`                  | Cache directory                             |

### Supplier integration

Enable suppliers by setting their credentials. All suppliers are disabled by default.

- **JLCPCB**: `JLCPCB_MODE=approved_api` + client ID/secret
- **LCSC**: `JLCSEARCH_ENABLED=true` (default, no key required for basic search)
- **Mouser**: `MOUSER_ENABLED=true` + API key
- **DigiKey**: `DIGIKEY_ENABLED=true` + OAuth2 client ID/secret

### AI Assistance (experimental)

Configure an AI provider for LLM-assisted design review:

| Variable                    | Default | Description                                     |
| --------------------------- | ------- | ----------------------------------------------- |
| `AI_PROVIDER`               | `none`  | `anthropic`, `openai`, `openrouter`, or `local` |
| `AI_MODEL`                  | `''`    | Model name (e.g., `claude-sonnet-4-20250514`)   |
| `AI_API_KEY`                | `''`    | AI provider API key                             |
| `AI_MAX_TOKENS`             | `8000`  | Max tokens per AI response                      |
| `AI_TIMEOUT_MS`             | `60000` | AI request timeout in ms                        |
| `AI_ALLOW_DESIGN_MUTATIONS` | `false` | Allow AI to modify schematic/board designs      |

### HTTP transport

When using `TRANSPORT=http`:

| Variable              | Default     | Description                                        |
| --------------------- | ----------- | -------------------------------------------------- |
| `HTTP_HOST`           | `127.0.0.1` | Bind address (use `0.0.0.0` with caution)          |
| `HTTP_PORT`           | `3000`      | Port                                               |
| `HTTP_AUTH_DISABLED`  | `false`     | Disable HTTP auth for non-production loopback only |
| `HTTP_RATE_LIMIT_MAX` | `100`       | Max requests per minute per IP                     |
| `CORS_ORIGIN`         | `''`        | Allowed CORS origin                                |

#### Production HTTP Security

For remote HTTP deployments, OAuth 2.0 / OpenID Connect is strongly recommended:

| Variable                | Default           | Description                                  |
| ----------------------- | ----------------- | -------------------------------------------- |
| `OAUTH_ENABLED`         | `false`           | Enable Bearer token validation               |
| `OAUTH_ISSUER`          | `''`              | Expected token issuer (`iss` claim)          |
| `OAUTH_AUDIENCE`        | `easyeda-mcp-pro` | Expected token audience (`aud` claim)        |
| `OAUTH_JWKS_URI`        | `''`              | JWKS endpoint for token signature validation |
| `OAUTH_REQUIRED_SCOPES` | `easyeda:read`    | Required token scope                         |

When `OAUTH_ENABLED=true`, every request to `/mcp` must include an `Authorization: Bearer <token>` header unless `HTTP_AUTH_DISABLED=true` is explicitly set for non-production loopback development. Tokens are verified against `OAUTH_JWKS_URI`, `iss`/`aud` claims are validated, and `OAUTH_REQUIRED_SCOPES` is enforced against `scope`, `scp`, `permissions`, or `roles` claims.

The server enforces startup safety checks: **non-loopback `HTTP_HOST` without OAuth is rejected**, and `HTTP_AUTH_DISABLED=true` is rejected outside non-production loopback deployments.

### Docker defaults

The Docker image starts in HTTP mode with `HTTP_HOST=127.0.0.1` so the default container boot path is safe and passes the same startup safety checks as local HTTP mode. For an externally reachable container, override the bind address and configure OAuth plus an explicit origin allowlist:

```bash
docker run --rm \
  -e HTTP_HOST=0.0.0.0 \
  -e ALLOWED_ORIGINS=https://your-client.example.com \
  -e OAUTH_ENABLED=true \
  -e OAUTH_ISSUER=https://issuer.example.com/ \
  -e OAUTH_JWKS_URI=https://issuer.example.com/.well-known/jwks.json \
  -e OAUTH_AUDIENCE=easyeda-mcp-pro \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/oaslananka/easyeda-mcp-pro:latest
```

Do not expose non-loopback HTTP without OAuth. Use a reverse proxy or platform gateway for TLS termination and external access.

#### HTTP Security Features

- **Rate limiting**: Per-IP sliding window (configurable via `HTTP_RATE_LIMIT_MAX`), returns `429 Too Many Requests` with retry-after header
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`
- **Health endpoints**: `/healthz` (liveness) and `/readyz` (readiness) return JSON status

See `.env.example` for the complete list of configuration variables.

---

## MCP Tools

The server currently registers 50 default profile-gated tools. Tools are filtered by the active `TOOL_PROFILE`: `core` exposes the normal workflow tools, `pro` adds manufacturing exports, `full` adds controlled documented EasyEDA API calls, and `dev` adds runtime probes for debugging.

Capability scopes add a second authorization layer when `TOOL_SCOPES` is set. Leave it empty for the default local all-capabilities mode, or restrict it with comma/space separated scopes such as `diagnostics:read`, `schematic:read`, `schematic:write`, `bom:read`, `bom:source`, `checks:read`, `pcb:read`, `pcb:write`, `export:write`, `api:read`, `api:write`, and `bridge:execute`.

Raw JavaScript execution is intentionally not part of the default dev tool set. `easyeda_execute` is registered only when both `BRIDGE_RAW_EXEC_ENABLED=true` and `MCP_RAW_EXEC_EXPERIMENTAL=true` are set; when `TOOL_SCOPES` is set it also requires `bridge:execute`.

### L0 — Diagnostics (core)

| Tool                        | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `easyeda_health_check`      | Server health, runtime version, profile, bridge state |
| `easyeda_bridge_status`     | Bridge connection status, version, capabilities       |
| `easyeda_get_capabilities`  | Available profiles, features, supported operations    |
| `easyeda_get_server_config` | Safe/redacted server configuration                    |
| `easyeda_get_tool_profiles` | Available tool profiles                               |
| `easyeda_get_feature_flags` | Current feature flags                                 |
| `easyeda_run_self_test`     | Internal self-test                                    |
| `easyeda_api_inventory`     | Live EasyEDA API classes, runtime paths, and methods  |

### L0 — Full-control and dev probes

| Tool                           | Profile | Description                                                        |
| ------------------------------ | ------- | ------------------------------------------------------------------ |
| `easyeda_api_call`             | full    | Call a documented EasyEDA `Class.method` path through the bridge   |
| `easyeda_bridge_probe_methods` | dev     | Probe bridge method availability                                   |
| `easyeda_component_probe`      | dev     | Inspect live schematic component runtime objects and state getters |

`easyeda_api_call` is intentionally not raw JavaScript execution. It only accepts documented EasyEDA Pro API class prefixes (`DMT_`, `SCH_`, `PCB_`, `LIB_`) and a direct method name such as `SCH_PrimitiveWire.getAll`. Methods that can mutate project state, such as `create`, `delete`, `modify`, `openProject`, `save`, `import`, or `export`, require `confirmWrite=true`.

To enable the controlled full-control API tool in your MCP client, set:

```bash
TOOL_PROFILE=full
```

### L1 — Schematic (core)

| Tool                                 | Description                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| `easyeda_schematic_nets`             | List all nets with node connections                         |
| `easyeda_schematic_components`       | List components with ref, value, footprint, LCSC, datasheet |
| `easyeda_schematic_net_detail`       | Full detail for a specific net                              |
| `easyeda_schematic_search_device`    | Search EasyEDA library devices                              |
| `easyeda_schematic_place_component`  | Place a library component on the active schematic sheet     |
| `easyeda_schematic_add_wire`         | Add a schematic wire segment                                |
| `easyeda_schematic_delete_primitive` | Delete schematic components or wires by primitive ID        |
| `easyeda_schematic_modify_primitive` | Modify schematic component or wire properties               |

The schematic write APIs use EasyEDA Pro extension APIs that EasyEDA currently marks as beta. The bridge checks for the documented API class names at runtime and returns an explicit error when the installed EasyEDA Pro build does not expose a required method.

### L1 — BOM (core)

| Tool                   | Description                             |
| ---------------------- | --------------------------------------- |
| `easyeda_bom_generate` | Generate bill of materials              |
| `easyeda_bom_validate` | Validate BOM against LCSC inventory     |
| `easyeda_bom_export`   | Export BOM to file                      |
| `easyeda_bom_sourcing` | Pricing and availability from suppliers |

### L1 — DRC/ERC (core)

| Tool                         | Description                         |
| ---------------------------- | ----------------------------------- |
| `easyeda_drc_run`            | Design rule check for PCB           |
| `easyeda_erc_run`            | Electrical rule check for schematic |
| `easyeda_rule_check_summary` | Combined DRC + ERC summary          |

### L1 — Board (core)

| Tool                       | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `easyeda_board_layers`     | List PCB layers with type, color, visibility    |
| `easyeda_board_stackup`    | Layer stackup with thickness, material          |
| `easyeda_board_dimensions` | Board outline, shape, mounting holes            |
| `easyeda_board_features`   | Counts of vias, tracks, zones, pads, components |

### L1 — Export (core/pro)

| Tool                        | Profile | Description                         |
| --------------------------- | ------- | ----------------------------------- |
| `easyeda_export_gerbers`    | core    | Export Gerber files for fabrication |
| `easyeda_export_pick_place` | pro     | Export pick-and-place centroid file |
| `easyeda_export_pdf`        | pro     | Export schematic/board to PDF       |
| `easyeda_export_netlist`    | pro     | Export netlist                      |

---

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────────┐
│   AI Assistant   │ ◄──── MCP ──────► │  easyeda-mcp-pro    │
│  (Claude, etc.)  │     Protocol      │  (MCP Server)       │
└─────────────────┘                    │                     │
                                       │  ┌───────────────┐  │
┌─────────────────┐     WebSocket      │  │  BridgeManager │──┼──► EasyEDA Pro
│  EasyEDA Pro     │ ◄── Bridge ──────►│  │  (WS Client)   │  │   (Plugin)
│  (via Plugin)    │     Protocol      │  └───────────────┘  │
└─────────────────┘                    │  ┌───────────────┐  │
                                       │  │  ToolRegistry  │  │
                                       │  │ (up to 60)    │  │
                                       │  └───────────────┘  │
                                       │  ┌───────────────┐  │
                                       │  │    Storage     │──┼──► SQLite
                                       │  │  (Cache/DB)   │  │
                                       │  └───────────────┘  │
                                       │  ┌───────────────┐  │
                                       │  │   Vendors     │──┼──► JLCPCB/LCSC/
                                       │  │ (API Clients) │  │    Mouser/DigiKey
                                       │  └───────────────┘  │
                                       └─────────────────────┘
```

### Transports

- **stdio** (default): Standard MCP transport — works with Claude Desktop, Cursor, and most MCP clients
- **HTTP**: Streamable HTTP transport with `/healthz`, `/readyz`, `/mcp` endpoints, CORS, and optional OAuth — suitable for remote deployments

### Bridge extension

```bash
pnpm build:extension
pnpm verify:extension
```

The extension build writes `easyeda-bridge-extension.eext` at the repository root.
It contains `extension.json`, the bundled browser script, and the image assets
required by EasyEDA Pro.

Installation: Open EasyEDA Pro → **Settings** → **Extensions** → **Extension Manager...** → **Import Extension**, then select the `.eext` file. Make sure **Allow External Interaction** is enabled for the extension.

---

## Development

### Prerequisites

- **Node.js** >=24 <27
- **pnpm** >=11
- **Go Task** (optional, for Taskfile commands)

### Quick Start

```bash
# Setup
pnpm install
cp .env.example .env

# All quality gates (lint + format + typecheck + test + build)
task verify

# Or use pnpm directly:
pnpm format:check          # Prettier
pnpm typecheck             # TypeScript
pnpm lint                  # ESLint

# Test
pnpm test                  # Vitest (497 tests across 32 files)
pnpm test:coverage         # With coverage report

# Golden E2E fixture smoke tests are included in `pnpm test`
# See docs/golden-fixtures.md for fixture architecture

# Build & run
pnpm build                 # tsc -> dist/
pnpm build:extension       # Bundle EasyEDA Pro extension
pnpm verify:extension      # Verify extension package contents
pnpm dev                   # Hot-reload dev mode
pnpm start                 # Run compiled build

# MCP Inspector (debug UI)
pnpm inspector
```

### Available Taskfile Commands

This project includes a `Taskfile.yml` with the following commands:

| Command          | Description                     |
| ---------------- | ------------------------------- |
| `task install`   | Install dependencies            |
| `task lint`      | Run ESLint                      |
| `task format`    | Check formatting with Prettier  |
| `task typecheck` | Run TypeScript type checking    |
| `task test`      | Run tests                       |
| `task build`     | Build the project               |
| `task verify`    | Run all quality gates (CI gate) |

Install [Go Task](https://taskfile.dev/installation/) to use these commands.

### Project structure

```
src/
├── index.ts                 # Entry point (stdio or HTTP)
├── bridge/                  # EasyEDA Pro WebSocket bridge protocol
│   ├── manager.ts, protocol.ts, types.ts
├── config/                  # Environment configuration
│   ├── env.ts, profiles.ts, feature-flags.ts
├── schemas/                 # Shared Zod schemas
├── server/                  # MCP server core
│   ├── factory.ts, errors.ts
│   └── transports/
│       └── http.ts          # HTTP/Streamable HTTP transport
├── storage/                 # Node.js sqlite storage (cache, artifacts)
├── tools/                   # 50 default MCP tool definitions (6 groups)
│   ├── register.ts, registry.ts, types.ts
│   ├── L0_diagnostics.ts, L1_schematic.ts, L1_bom.ts
│   ├── L1_drc_erc.ts, L1_board.ts, L1_export.ts
└── vendors/                 # Supplier API clients
    ├── lcsc/, jlcpcb/, mouser/, digikey/

easyeda-bridge-extension/    # EasyEDA Pro bridge extension workspace package
```

---

## Security

See [Security Architecture & Threat Model](docs/security-architecture.md) for the complete security reference, including deployment modes, authentication, tool safety controls, secrets management, safe defaults, supplier API security, threat scenarios, and deployment checklists.

- **Production safety**: Validates config at startup — rejects non-loopback HTTP without OAuth, blocks dangerous features in production
- **OAuth/JWKS**: Bearer token validation via JWKS endpoint for HTTP transport (see [OAuth section](docs/security-architecture.md#21-oauth-20--openid-connect-http-transport))
- **Rate limiting**: Per-IP sliding window rate limiter on HTTP transport (default 100 req/min)
- **Path traversal protection**: All file export paths validated against `ARTIFACT_DIR`
- **Secret redaction**: API keys, tokens, passwords are redacted from logs and diagnostic output
- **Branch protection**: Governance policy requires code reviews and status checks on the `main` branch (see [Repository Governance](docs/REPOSITORY_GOVERNANCE.md))
- **Code scanning**: CodeQL analysis runs on every push and PR (security-extended + security-and-quality queries)
- **Dependency management**: Renovate automatically updates dependencies with security patches
- **Supply-chain hygiene**: pnpm workspace build, pinned GitHub Actions, and no native SQLite addon dependency
- **Reporting**: See [SECURITY.md](SECURITY.md) for vulnerability disclosure

---

## Release & Dependency Automation

This repository uses automated workflows to manage dependencies and releases:

- **Renovate**: Automatically scans and updates dependencies based on rules configured in [.github/renovate.json](.github/renovate.json). For details on PR policies and automerging, see [Repository Governance](docs/REPOSITORY_GOVERNANCE.md).
- **Release Please**: Automatically bumps package versions, updates files (like `package.json`, `server.json`, `extension.json`), and generates `CHANGELOG.md` upon merging Release PRs. For the full release procedure and Conventional Commit conventions, see [Release Process](docs/RELEASE_PROCESS.md).
- **Secure Publishing**: The release workflow builds all assets (including `easyeda-bridge-extension.eext`), publishes to the NPM registry with cryptographic provenance, and uploads assets directly to the GitHub release.

---

## License

[MIT](LICENSE)

---

## Related

- [Model Context Protocol](https://modelcontextprotocol.io) — Standard protocol for AI tool integration
- [EasyEDA Pro](https://pro.easyeda.com) — Professional PCB design tool
