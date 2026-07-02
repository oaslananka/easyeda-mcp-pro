# Roadmap

This roadmap describes the intended direction for `easyeda-mcp-pro` for the next 12 months. It is not a promise of delivery; it is a planning document for users, contributors, and OpenSSF Best Practices evidence.

## Project scope

`easyeda-mcp-pro` is a production-oriented MCP server for EasyEDA Pro. Its scope is controlled hardware-design assistance: schematic inspection, BOM workflows, safe manufacturing exports, supplier lookup, diagnostics, and security-conscious AI-assisted review.

The project does **not** aim to provide unattended paid ordering, bypass EasyEDA or supplier terms, redistribute vendor catalog data, or perform unrestricted arbitrary JavaScript execution by default.

## Next 12 months

### 2026 Q3: Security and release maturity

- Complete OpenSSF Best Practices Passing and Silver evidence.
- Keep branch protection, CodeQL, dependency monitoring, secret scanning, push protection, and release provenance enabled.
- Document signed release and verification steps.
- Reduce release-process ambiguity for npm packages, GitHub releases, SBOMs, and the EasyEDA bridge extension artifact.
- Add more regression tests for bug fixes and high-risk bridge/export paths.

### 2026 Q4: Tool quality and coverage

- Improve coverage in low-coverage modules, especially CLI setup, server factory, and supplier clients.
- Expand golden evaluations for common schematic, BOM, DRC/ERC, and manufacturing-review workflows.
- Add more negative-path tests for input validation, file paths, OAuth, and bridge pairing failures.
- Improve generated tool reference docs and examples for each profile: `core`, `pro`, `full`, and `dev`.

### 2027 Q1: User experience and compatibility

- Improve setup diagnostics for Claude Desktop, Cursor, VS Code, Windsurf, Cline, Gemini, Zed, Amazon Q, and Continue.
- Maintain compatibility tracking for EasyEDA Pro bridge APIs and document known unsupported versions.
- Improve troubleshooting flows for bridge installation, WebSocket connectivity, OAuth configuration, and supplier credentials.
- Add practical example workflows for schematic review, BOM sourcing, and manufacturing handoff.

### 2027 Q2: Safety model and ecosystem hardening

- Strengthen the safety model for write operations, export workflows, and vendor integrations.
- Continue to keep raw bridge execution disabled by default and isolated behind explicit experimental flags.
- Review vendor terms and unsupported workflows at least once per release cycle.
- Improve assurance-case evidence for trust boundaries, secure defaults, input validation, dependency monitoring, and release integrity.

## Maintenance policy

The latest npm and GitHub release is the actively maintained release. Older versions are best-effort only; users should upgrade to the latest release unless a documented compatibility issue prevents it.

## Non-goals

- Automatic paid ordering without explicit human confirmation.
- Redistributing proprietary EasyEDA, JLCPCB, LCSC, Mouser, or DigiKey data.
- Replacing human engineering review for manufacturability or safety-critical design decisions.
- Enabling remote HTTP exposure without explicit authentication and allowed-origin controls.
