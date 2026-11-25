<div align="center">

# EasyEDA MCP Pro

**Inspect EasyEDA Pro circuits from an MCP assistant. Review native design evidence before making a change.**

[Documentation](https://oaslananka.github.io/easyeda-mcp-pro/) · [Connect in Cloud](https://easyeda-mcp-pro.oaslananka.dev/cloud) · [Local setup](https://oaslananka.github.io/easyeda-mcp-pro/guide/getting-started.html) · [Example Workflows](https://oaslananka.github.io/easyeda-mcp-pro/examples/cookbook.html) · [Tool Reference](https://oaslananka.github.io/easyeda-mcp-pro/reference/tools.html)

<p>
  <a href="https://www.npmjs.com/package/easyeda-mcp-pro"><img src="https://img.shields.io/npm/v/easyeda-mcp-pro.svg?logo=npm" alt="npm version" /></a>
  <a href="https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml"><img src="https://github.com/oaslananka/easyeda-mcp-pro/actions/workflows/ci.yml/badge.svg" alt="CI checks" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-275d50" alt="AGPL-3.0-only license" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/oaslananka/easyeda-mcp-pro"><img src="https://api.scorecard.dev/projects/github.com/oaslananka/easyeda-mcp-pro/badge" alt="OpenSSF Scorecard" /></a>
</p>
<p>
  <a href="https://www.npmjs.com/package/easyeda-mcp-pro"><img src="https://img.shields.io/npm/dt/easyeda-mcp-pro?label=downloads" alt="Total npm downloads" /></a>
  <a href="https://gitgem.org/github/oaslananka/easyeda-mcp-pro"><img src="https://gitgem.org/api/badge/github/oaslananka/easyeda-mcp-pro.svg" alt="GitGem" /></a>
</p>
<p>
  <a href="https://github.com/sponsors/oaslananka"><img src="https://img.shields.io/badge/GitHub-Sponsors-ea4aaa?logo=githubsponsors" alt="GitHub Sponsors" /></a>
  <a href="https://www.buymeacoffee.com/oaslananka"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Support-ffdd00?logo=buymeacoffee&amp;logoColor=black" alt="Buy Me a Coffee" /></a>
  <a href="https://github.com/oaslananka/easyeda-mcp-pro"><img src="https://img.shields.io/github/stars/oaslananka/easyeda-mcp-pro?label=Stars" alt="GitHub stars" /></a>
</p>

</div>

## Use with ChatGPT, Claude, Cursor or Codex

[Open the guided Cloud connection](https://easyeda-mcp-pro.oaslananka.dev/cloud), sign in, and choose your AI app. The Cloud workspace shows the connection details, bridge installation, device status, selected design and authorized clients in one place. Cursor has a one-click server install link; other clients can copy the URL or command.

The EasyEDA Pro bridge extension must be installed once. You still explicitly pair your device, select the open schematic or PCB, and authorize the AI client. **Read** is the initial OAuth selection; request **Write** or **Export** only if needed. Native changes and exports still require EasyEDA approval. No command-line setup or separate Cloud API key is required.

For an offline or account-free setup, use [Local MCP](https://oaslananka.github.io/easyeda-mcp-pro/guide/getting-started.html).

## Start with a circuit question

Open a project in EasyEDA Pro, then ask an MCP-capable assistant:

> Which components are connected to 3V3? Show the net connections and identify what I should verify before changing the power circuitry.

The assistant can read native net and component data from the focused schematic. Evaluate findings against the design, datasheets and physical layout. An automated review is **not** an electrical or manufacturing certification.

[Follow the schematic review example](https://oaslananka.github.io/easyeda-mcp-pro/examples/schematic-review.html) · [Check live-tested EasyEDA versions](https://oaslananka.github.io/easyeda-mcp-pro/reference/easyeda-compatibility.html)

## Connect in three steps

**Requirements:** Node.js 24.x and EasyEDA Pro. The source checkout pins Node.js 24.22.3 and pnpm 11.28.11; installing through `npx` does not require pnpm.

```bash
# Configure detected MCP clients.
npx easyeda-mcp-pro setup all

# Locate the bundled EasyEDA bridge extension.
npx easyeda-mcp-pro extension --open

# After importing the extension and opening EasyEDA Pro, inspect the connection.
npx easyeda-mcp-pro --doctor
```

In **EasyEDA Pro**, open **Advanced → Extensions Manager**, import `easyeda-bridge-extension.eext` and allow external interaction. Restart the editor, open your project and choose **MCP Bridge → Connect Local**. Restart the MCP client if its configuration changed. Local MCP does **not** require a Cloud account.

[First-connection guide](https://oaslananka.github.io/easyeda-mcp-pro/guide/getting-started.html) · [Troubleshooting](https://oaslananka.github.io/easyeda-mcp-pro/guide/troubleshooting.html)

## Choose a workflow

| Your goal                                          | Where to start                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Inspect nets, pins and schematic connections       | [Schematic review](https://oaslananka.github.io/easyeda-mcp-pro/examples/schematic-review.html)         |
| Audit a BOM without guessing stock                 | [BOM validation and sourcing](https://oaslananka.github.io/easyeda-mcp-pro/examples/bom-sourcing.html)  |
| Collect checks and exports before sending to a fab | [Manufacturing review](https://oaslananka.github.io/easyeda-mcp-pro/examples/manufacturing-review.html) |
| Find a tool, profile or risk level                 | [MCP tool reference](https://oaslananka.github.io/easyeda-mcp-pro/reference/tools.html)                 |

### Read, write and export are different permissions

- **Read:** The focused document, current project and active tool profile determine what native data is available. Unknown facts remain unknown.
- **Write:** Eligible mutations require a suitable tool profile, explicit `confirmWrite=true` and the correct project scope. Cloud operations have an additional owner approval boundary.
- **Save and export:** Save is explicit. ERC, DRC, BOM and fabrication files are evidence for human review, **not** proof of safety, electrical correctness or manufacturing readiness.

[Save, export and recovery contract](https://oaslananka.github.io/easyeda-mcp-pro/reference/save-export-rollback-safety.html) · [Security architecture](docs/security-architecture.md)

## Local and Cloud are separate paths

**Local is the default.** The MCP server and bridge communicate on the same computer without hosted sign-in.

**Cloud is opt-in.** The hosted service has separate account sign-in, device pairing, project selection and explicit operation permissions. Connecting a device does not silently authorize writes. Check [remote modes](https://oaslananka.github.io/easyeda-mcp-pro/REMOTE_MCP_MODES.html) and the [release policy](docs/RELEASE_POLICY.md) for support and availability boundaries.

An HTTPS MCP endpoint for assistants and a WSS relay endpoint for the EasyEDA extension are **different** connections. Do not paste one into the other.

## More detail when you need it

The [documentation site](https://oaslananka.github.io/easyeda-mcp-pro/) is organized by user task. Advanced references remain available for [architecture](docs/architecture/), [configuration](docs/guide/configuration.md), [release verification](docs/RELEASE_VERIFICATION.md), [security policy](SECURITY.md), [roadmap](docs/ROADMAP.md), and [changelog](CHANGELOG.md).

The [compatibility record](https://oaslananka.github.io/easyeda-mcp-pro/reference/easyeda-compatibility.html) separates live-tested EasyEDA versions from mocked and experimental behavior; do not infer a product guarantee from a model or a passing test.

## Technical reference

The main workflow stays short. Details for source users and automation live here;
[configuration](docs/guide/configuration.md) and
[security architecture](docs/security-architecture.md) provide the full contracts.

<details>
<summary>Tool profiles, configuration and maintenance</summary>

### MCP capability profiles

Counts below are generated from the active registry, not copied from a release claim.

<!-- capability-counts:start -->

| Profile        | Registered tools |
| -------------- | ---------------: |
| `core`         |               84 |
| `pro`          |              115 |
| `full`         |              132 |
| `dev`          |              137 |
| `experimental` |              138 |

<!-- capability-counts:end -->

### Keyless sourcing controls

The [configuration guide](docs/guide/configuration.md) covers
`KEYLESS_SOURCING_ENABLED`, `SOURCING_CACHE_TTL_SECONDS` and
`VENDOR_MIN_REQUEST_INTERVAL_MS`. Free supplier snapshots can be incomplete;
a lookup does not confer purchasing approval.

### Reserved AI configuration

No in-process AI provider client is currently implemented. Reserved `AI_*`
settings do not activate an AI provider; do not supply provider credentials.

### Engineering and agent references

The on-demand engineering review router is the
[engineering review reference](skills/design-validation/references/engineering-review.md).
Its review guidance is not automatic safety or fabrication certification.
See [agent runtime configuration](docs/agent-runtime-config.md).

### Dependency and release maintenance

Hosted Renovate is an account-level prerequisite; checked-in configuration
does not prove the GitHub integration is active. See
[repository governance](docs/REPOSITORY_GOVERNANCE.md).
Releases follow the [Release Policy](docs/RELEASE_POLICY.md),
[release process](docs/RELEASE_PROCESS.md), and
[verification guide](docs/RELEASE_VERIFICATION.md).
The experimental adapter is documented in the
[CDP bridge guide](docs/guide/cdp-bridge.md).

</details>

## Contributing and license

Reproducible bug reports, documentation improvements and patches are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). [DeepWiki](https://deepwiki.com/oaslananka/easyeda-mcp-pro) provides a secondary code-navigation reference.

Project-authored source is licensed under **[AGPL-3.0-only](LICENSE)**. For extension, bundled and third-party materials see [LICENSING.md](LICENSING.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
