<div align="center">

# easyeda-mcp-pro

<p>
  Production-grade MCP server for EasyEDA Pro: safe PCB design inspection, BOM sourcing, manufacturing export, and AI-assisted hardware review.
</p>

<p>
  <a href="https://www.npmjs.com/package/easyeda-mcp-pro">
    <img src="https://img.shields.io/npm/v/easyeda-mcp-pro.svg?logo=npm" alt="npm version" />
  </a>
  <a href="https://www.npmjs.com/package/easyeda-mcp-pro">
    <img src="https://img.shields.io/npm/dt/easyeda-mcp-pro?logo=npm&label=total%20downloads" alt="npm total downloads" />
  </a>
  <a href="https://www.npmjs.com/package/easyeda-mcp-pro">
    <img src="https://img.shields.io/node/v/easyeda-mcp-pro" alt="supported Node.js version" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/npm/l/easyeda-mcp-pro.svg" alt="license" />
  </a>
  <a href="https://pnpm.io/">
    <img src="https://img.shields.io/badge/pnpm-11.5.1-blue.svg" alt="pnpm" />
  </a>
</p>

<p>
  <a href="https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml">
    <img src="https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml/badge.svg" alt="CI status" />
  </a>
  <a href="https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/deploy-docs.yml">
    <img src="https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/deploy-docs.yml/badge.svg" alt="Docs status" />
  </a>
  <a href="https://github.com/oaslananka/easyeda-mcp-pro/security/policy">
    <img src="https://img.shields.io/badge/security-policy-blue" alt="Security policy" />
  </a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/oaslananka/easyeda-mcp-pro">
    <img src="https://api.scorecard.dev/projects/github.com/oaslananka/easyeda-mcp-pro/badge" alt="OpenSSF Scorecard" />
  </a>
    <a href="https://www.bestpractices.dev/projects/13406">
    <img src="https://www.bestpractices.dev/projects/13406/badge" alt="OpenSSF Best Practices" />
  </a>
</p>

<p>
  <a href="https://deepwiki.com/oaslananka/easyeda-mcp-pro">Ask DeepWiki</a> ·
  <a href="docs/ROADMAP.md">Roadmap</a> ·
  <a href="docs/OPENSSF_BEST_PRACTICES.md">OpenSSF evidence</a> ·
  <a href="docs/SECURITY_ASSURANCE_CASE.md">Security assurance case</a>
</p>

<p>
  <strong>Compliance docs:</strong>
  <a href="THIRD_PARTY_NOTICES.md">Third-Party Notices</a>
  ·
  <a href="docs/vendor-terms.md">Vendor Terms and Unsupported Workflows</a>
  ·
  <a href="docs/REMOTE_MCP_MODES.md">Remote MCP Modes</a>
</p>

<p>
  <a href="https://www.buymeacoffee.com/oaslananka">
    <img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=oaslananka&button_colour=FFDD00&font_colour=000000&font_family=Inter&outline_colour=000000&coffee_colour=ffffff" height="28" alt="Buy me a coffee" />
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/oaslananka/easyeda-mcp-pro">
    <img src="https://img.shields.io/github/stars/oaslananka/easyeda-mcp-pro?style=for-the-badge&logo=github&label=Star%20on%20GitHub&color=FFA500&labelColor=181717" alt="Star on GitHub" />
  </a>
</p>

</div>

---

## Trust and Supply Chain

easyeda-mcp-pro keeps its public OpenSSF Best Practices evidence in [`docs/OPENSSF_BEST_PRACTICES.md`](docs/OPENSSF_BEST_PRACTICES.md) and its security assurance case in [`docs/SECURITY_ASSURANCE_CASE.md`](docs/SECURITY_ASSURANCE_CASE.md). The header badges link to workflow-backed signals only: CI, generated docs deployment, the project security policy, OpenSSF Best Practices self-certification, and the OpenSSF Scorecard. Release integrity evidence (npm provenance, signed-release status) is tracked in [`docs/RELEASE_VERIFICATION.md`](docs/RELEASE_VERIFICATION.md).

**Current OpenSSF Best Practices status:** Passing (100%) — see [live badge](https://www.bestpractices.dev/projects/13406) and [Silver evidence map](docs/OPENSSF_BEST_PRACTICES.md#silver-evidence) for in-progress Silver criteria.

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

easyeda-mcp-pro is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that bridges AI assistants with hardware design workflows in EasyEDA Pro. It exposes up to 60 profile-gated MCP tools for schematic inspection and editing, controlled EasyEDA Pro API calls, BOM management, design rule checks, PCB board analysis, fabrication exports, diagnostics, and supplier integration.

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

The server currently registers up to 77 profile-gated tools. Tools are filtered by the active `TOOL_PROFILE`:

- `core`: 48 tools
- `pro`: 63 tools
- `full`: 73 tools
- `dev`: 77 tools

`core` exposes the standard workflow tools, `pro` adds manufacturing exports, `full` adds controlled documented EasyEDA API calls, and `dev` adds runtime probes for debugging.

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
                                       │  │ (up to 60 tools) │ │
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

### Deployment modes

Beyond local stdio/HTTP, the server supports a hosted remote runtime (gateway, session router, and approval-scoped relay under `src/remote/`) for managed connector deployments such as Claude Web or ChatGPT app integrations, plus a self-hosted remote mode for user-managed endpoints. See [Remote MCP Modes](docs/REMOTE_MCP_MODES.md) for the full mode matrix and network/security boundaries of each.

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

## Agent plugin and skills

This repository owns the product-level agent plugin and EasyEDA-specific skills for
EasyEDA MCP Pro. The central [`agent-tools`](https://github.com/oaslananka/agent-tools)
repository should catalog this plugin, but the manifest and workflow instructions live
here so they stay synchronized with the actual MCP server, bridge extension, tool
profiles, and EasyEDA runtime behavior.

| File                                                                     | Purpose                                                                                         |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)               | Claude Code-valid plugin manifest for compatible agent runtimes and marketplace catalogs.       |
| [`.mcp.json`](.mcp.json)                                                 | Project-local Claude Code MCP server configuration.                                             |
| [`.codex/config.example.toml`](.codex/config.example.toml)               | Codex CLI MCP configuration example.                                                            |
| [`.vscode/mcp.example.json`](.vscode/mcp.example.json)                   | VS Code / GitHub Copilot workspace MCP configuration example.                                   |
| [`opencode.example.jsonc`](opencode.example.jsonc)                       | OpenCode project MCP configuration example.                                                     |
| [`.opencode/skills/`](.opencode/skills)                                  | OpenCode-native mirrored skill definitions.                                                     |
| [`docs/agent-runtime-config.md`](docs/agent-runtime-config.md)           | Agent runtime setup and validation matrix.                                                      |
| [`skills/easyeda-workflow/SKILL.md`](skills/easyeda-workflow/SKILL.md)   | End-to-end EasyEDA setup, inspection, controlled write, export, and reporting workflow.         |
| [`skills/component-search/SKILL.md`](skills/component-search/SKILL.md)   | Component search, BOM review, sourcing, pricing, availability, and part-risk workflow.          |
| [`skills/design-validation/SKILL.md`](skills/design-validation/SKILL.md) | DRC/ERC, semantic ERC, PCB constraints, production QA, export, and release-validation workflow. |

### Agent setup

EasyEDA MCP Pro can be launched with the published npm package or from a source checkout:

```bash
npx easyeda-mcp-pro
TRANSPORT=http HTTP_HOST=127.0.0.1 HTTP_PORT=3000 npx easyeda-mcp-pro
pnpm build && node dist/index.js
```

For live EasyEDA Pro workflows, install the EasyEDA bridge extension and confirm the
bridge is reachable with `easyeda_health_check` and `easyeda_bridge_status`. Tool
availability depends on `TOOL_PROFILE` and optional `TOOL_SCOPES` restrictions.

For source checkouts, run the normal validation path before publishing plugin changes:

```bash
python3 -m json.tool .claude-plugin/plugin.json >/dev/null
claude plugin validate .
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm check:metadata
```

### Validation workflow

Before listing this plugin as active from `agent-tools`, verify at least one compatible
agent runtime can:

1. Discover `.claude-plugin/plugin.json`.
2. Launch or connect to `easyeda-mcp-pro` over `stdio` or HTTP.
3. Call `easyeda_health_check`, `easyeda_bridge_status`, or `easyeda_get_capabilities`.
4. Load a skill from `skills/` and follow the workflow without referencing missing tools.
5. Report bridge state, tool profile, ERC, DRC, BOM, export artifacts, assumptions, and
   human-review requirements separately.

EasyEDA MCP Pro is an engineering assistant, not an autonomous manufacturing sign-off
authority. Generated designs, component selections, and fabrication outputs require
qualified human review before purchase, fabrication, or assembly.

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
pnpm verify

# Or, if you use Go Task:
task verify

# Use focused checks while iterating:
pnpm format:check          # Prettier
pnpm typecheck             # TypeScript
pnpm lint                  # ESLint

# Test
pnpm test                  # Vitest (812 tests across 67 files)
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

| Command          | Description                        |
| ---------------- | ---------------------------------- |
| `task install`   | Install dependencies               |
| `task lint`      | Run ESLint                         |
| `task format`    | Check formatting with Prettier     |
| `task typecheck` | Run TypeScript type checking       |
| `task test`      | Run tests                          |
| `task build`     | Build the project                  |
| `task verify`    | Run all quality gates via Taskfile |

The package also exposes `pnpm verify`, which runs the same CI-equivalent local gate without requiring Go Task.

Install [Go Task](https://taskfile.dev/installation/) to use these commands.

### Project structure

```
src/
├── index.ts                 # Entry point (stdio or HTTP)
├── bridge/                  # EasyEDA Pro WebSocket bridge protocol
│   ├── manager.ts, protocol.ts, types.ts
├── cli/                     # Client auto-setup (setup/extension CLI commands)
├── config/                  # Environment, tool profiles, feature flags
│   ├── env.ts, profiles.ts, feature-flags.ts, version.ts
├── remote/                  # Hosted/self-hosted remote MCP gateway, session router, scopes
├── schemas/                 # Shared Zod schemas
├── server/                  # MCP server core
│   ├── factory.ts, resources-prompts.ts
│   └── transports/
│       ├── http.ts                    # HTTP/Streamable HTTP transport
│       └── oauth-resource-metadata.ts
├── storage/                 # Node.js sqlite storage (cache, artifacts)
├── tools/                   # Up to 60 profile-gated MCP tool definitions
│   ├── register.ts, registry.ts, types.ts, transaction.ts
│   ├── L0_diagnostics_core.ts, L0_diagnostics_api.ts
│   ├── L1_schematic_read.ts, L1_schematic_write.ts
│   ├── L1_bom_core.ts, L1_bom_sourcing.ts
│   └── L1_drc_erc.ts, L1_board.ts, L1_export.ts, L1_pcb_constraints.ts, L1_pcb_write.ts
├── vendors/                 # Supplier API clients (lcsc/, jlcpcb/, mouser/, digikey/)
└── ...                      # circuit, pcb-layout, net-validation, power-tree, production-qa,
                              # quote-gating, safety, observability, catalog, bom-quality,
                              # export-manifest, live, easyeda-runtime

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

## Support the project

If this project helps you save time while working with EasyEDA Pro, BOM workflows, or MCP integrations, you can support ongoing development via the **Buy me a coffee** button at the top of this README.

---

## License

[MIT](LICENSE)

---

## Related

- [Model Context Protocol](https://modelcontextprotocol.io) — Standard protocol for AI tool integration
- [EasyEDA Pro](https://pro.easyeda.com) — Professional PCB design tool
