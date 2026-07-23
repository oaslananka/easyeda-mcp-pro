# Compatibility Matrix

This document lists the tested and supported versions, environments, and clients for `easyeda-mcp-pro`.

Version ranges in this overview are support-policy targets, not exact live-validation claims. The generated [EasyEDA exact-version evidence matrix](./reference/easyeda-compatibility.md) is the source of truth for live runtime claims, review dates, and known limitations.

---

## 1. Runtime & Environment

| Environment | Supported Versions | Tested Status | Notes                                             |
| :---------- | :----------------- | :------------ | :------------------------------------------------ |
| **Node.js** | `>= 24 < 27`       | **Verified**  | Uses native ESModules features and `node:sqlite`. |
| **pnpm**    | `>= 11`            | **Verified**  | Standard package manager for workspace builds.    |
| **npm**     | `*`                | **Verified**  | Supported via `npx` execution.                    |
| **Docker**  | `v20.x` or newer   | **Verified**  | Fully containerized execution using alpine/node.  |

---

## 2. EasyEDA Pro Versions

| EasyEDA Pro Version         | Tested Status                 | Notes                                                                                                                                                                                                                      |
| :-------------------------- | :---------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v3.2.x** (Desktop / Web)  | **Supported**                 | Requires **Allow External Interaction**. Some v3.2 runtimes accept `SYS_WebSocket.register()` without reporting open; the bridge safely closes that handle and retries with `SYS_WebSocket.create()` or browser WebSocket. |
| **v2.2.x** (Desktop / Web)  | **Evidence refresh required** | Legacy development target; add a current exact-version live record before making a release claim.                                                                                                                          |
| **v2.1.x**                  | **Needs Validation**          | Mostly compatible, but some schematic APIs may be missing.                                                                                                                                                                 |
| **v2.0.x**                  | **Needs Validation**          | Underlying extension APIs might not expose required methods.                                                                                                                                                               |
| **v1.x** (Standard Edition) | **Unsupported**               | Standard edition does not support the Pro extension platform.                                                                                                                                                              |

---

## 3. MCP Clients

| Client                   | Configuration | Tested Status | Notes                                       |
| :----------------------- | :------------ | :------------ | :------------------------------------------ |
| **Claude Desktop**       | Stdio         | **Verified**  | Recommended for full layout prompts.        |
| **Cursor IDE**           | Stdio         | **Verified**  | Excellent for coding with live PCB context. |
| **VS Code Copilot**      | Stdio         | **Verified**  | Configured in users settings.               |
| **Windsurf**             | Stdio         | **Verified**  | Excellent transport support.                |
| **Cline**                | Stdio         | **Verified**  | Full auto-approve compatible.               |
| **Gemini / Antigravity** | Stdio         | **Verified**  | Full tool execution support.                |
| **Zed Editor**           | Stdio         | **Verified**  | Fully integrated.                           |

---

## 4. Operating Systems

| OS                                | Supported                                  | Notes                                                                                                                                                                                       |
| :-------------------------------- | :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Windows 10/11**                 | **Verified**                               | Tested with PowerShell and CMD.                                                                                                                                                             |
| **macOS** (Intel / Apple Silicon) | **Supported; release validation required** | Automated coverage models the EasyEDA Pro 3.2.149 silent-register behavior without an `eda` global. Packaged `.eext` validation on affected macOS hardware remains required before release. |
| **Linux** (Ubuntu / Fedora)       | **Verified**                               | Tested with bash.                                                                                                                                                                           |

---

## 5. Supplier API Integrations

| Supplier    | API Protocol   | Auth Type          | Sourcing Tested | Ordering Tested       |
| :---------- | :------------- | :----------------- | :-------------- | :-------------------- |
| **LCSC**    | HTTPS / Public | Public Search      | **Verified**    | N/A                   |
| **JLCPCB**  | HTTPS / REST   | Client ID & Secret | **Verified**    | **Approved API only** |
| **Mouser**  | HTTPS / REST   | API Key            | **Verified**    | N/A                   |
| **DigiKey** | HTTPS / OAuth2 | OAuth2 Credentials | **Verified**    | N/A                   |
