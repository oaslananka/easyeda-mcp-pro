# Connect EasyEDA MCP Pro Cloud to AI agents

> **Status (2026-11-15):** Cross-client acceptance instructions, **not** a claim of
> production availability. Feature PR #1057 is Draft and Cloud rollout #850 is HOLD.

## One MCP endpoint, multiple agent hosts

After a reviewed deployment is publicly reachable, point each client at:

`https://easyeda-mcp-pro.oaslananka.dev/mcp`

Hosted Cloud requires HTTPS Streamable HTTP, OAuth 2.1 authorization
discovery, PKCE, resource-bound access tokens, and a paired EasyEDA Pro
extension with an **explicitly selected** real schematic or PCB. The local
MCP server stays account-free and offline by default.

Set `MCP_APPS_ENABLED=true` on Hosted Cloud to expose the standard read-only
project-review MCP Apps widget. The underlying tools still work without a UI.

Set `MCP_V2_EXPERIMENTAL=true` on the Hosted runtime to serve both
`2025-11-25` (sessionful) and `2026-07-28` (stateless) protocol eras. This
does not grant access or remove any legacy capability. In 2026 requests the
client supplies `Mcp-Method`, per-request version metadata and no
`MCP-Session-Id`. Use the official SDK, not simulated JSON-RPC envelopes.

| Host                        | Where to connect                                                                                                              | Platform caveat                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ChatGPT**                 | Plugins → Add custom MCP server; enter the HTTPS URL, authenticate, inspect tools, then perform a project-scoped read.        | Full write-capable MCP and workspace publication depend on plan/admin settings; ChatGPT Pro custom MCP may be read-only.                                   |
| **Claude web**              | Customize → Connectors → Add custom connector; enter the URL and use its OAuth client identity or the registered client flow. | Claude connects from Anthropic's public cloud over HTTPS port 443; browser-only Access and private VPNs are not adequate.                                  |
| **Gemini web**              | Settings → Connected Apps → Custom apps; enter the URL and authorize it. Inspect schemas in Gemini Developer Mode.            | As documented on 2026-11-15, the consumer custom-app feature requires an eligible **US personal account, age 18+**, with activity on, and is English-only. |
| **Gemini API / Enterprise** | Configure the remote Streamable HTTP MCP tool or enterprise connector and its OAuth separately.                               | This is **not** the same integration path as consumer Gemini web.                                                                                          |

### First real user journey

1. Sign in to Hosted Cloud, install the exact reviewed preview EasyEDA Pro
   extension in an isolated profile, and pair it using a one-time code.
2. Select the real focused document on the Cloud dashboard. Verify that the
   project and account identity match the selected native editor.
3. Link the agent using only `easyeda.read`; first call `easyeda_health_check`.
   **MCP OAuth connected does not mean EasyEDA is connected.** The diagnostic
   reports `bridge_connected: false` and `status: degraded` until the owner's
   paired, focused project is reachable. After that check passes, verify
   read-only schematic/PCB inventory on a **disposable** project.
4. Revoke client access and confirm the old token cannot read again; use a
   second independently authenticated user to prove owner isolation.
5. For a separately authorized disposable write, require native
   `confirmWrite` and remote one-time approval, then cold-reopen the design
   to verify disk persistence. Do not treat an API response `true` or an
   in-memory change as proof.

**Current write limitation:** In EasyEDA Pro 3.2.209, beta
`SCH_PrimitiveText.delete` followed by native save acknowledged success
but did not persist the deletion across editor restart. The tool refuses
that path; it is tracked in #1060. Do not bypass with direct SQLite edits.

## Test with MCPJam

[MCPJam CLI](https://www.mcpjam.com/features/cli) can run free
transport, OAuth and schema checks without a paid LLM. Use a separate
test profile; do not paste access tokens, client secrets or real user
design data in logs or GitHub issues. Use a temporary loopback HTTP
server for early checks and **repeat on the actual HTTPS endpoint** for
real hosted acceptance.

```bash
npx --yes @mcpjam/cli@latest --no-telemetry server doctor --url http://127.0.0.1:PORT/mcp
npx --yes @mcpjam/cli@latest --no-telemetry compat --url http://127.0.0.1:PORT/mcp
```

**MCPJam web Inspector:** Add an HTTPS server using the official `/mcp`
URL, select **OAuth**, then open **Advanced Settings** and set
**Scope Override** to `easyeda.read` **before authorizing**. Its default
authorization request may include `easyeda.write`, `easyeda.export` and
`easyeda.project_admin` as well as read access. **Deny** any unexpectedly
broad consent request, correct the scope override, and verify the real
consent page lists **only** `easyeda.read` before selecting Allow.

The first owner-only MCPJam web pilot on 2026-11-15 completed CIMD/PKCE OAuth,
83-tool discovery, MCP Apps resource discovery and a health call. That
**earlier** pilot had no native editor paired. In a subsequent pilot on exact
PR #1057 commit `f1c9b70`, real MCPJam and the owner-paired **EasyEDA Pro
3.2.209** extension returned **33 populated PCB components** and **34
schematic component records** from a user-selected disposable design.
The same connected MCPJam client got `SESSION_UNPAIRED` after the owner
clicked **Remove access**; a revoked OAuth bearer was separately rejected
with **HTTP 403**. The preview was then stopped and its temporary settings
removed. These results **do not** prove a second independent user, any
actual ChatGPT/Claude/Gemini host account, or durable native Cloud WRITE.
See [the verified live run](https://github.com/oaslananka/easyeda-mcp-pro/issues/849#issuecomment-6888075039).

For Hosted Cloud, inspect OAuth protected-resource and authorization-server
discovery, then test 2025 and 2026-era connections with DCR and CIMD
where supported. Sign in with a specifically authorized test account.
An unauthenticated 401 is **correct** for protected MCP endpoints; an
anonymous local test is not a real OAuth acceptance.

Acceptance rows to record separately: `tools/list`, `tools/call`,
`resources/list`, `prompts/list`, optional MCP Apps UI resource with
headless fallback, 401 challenge and valid OAuth, user isolation, revoke,
selected-document bound real EasyEDA read, denied write without approval,
approved disposable write with persistence, disconnect/retry, and HTTPS
reachability from each intended agent provider. Label each
**PASS / FAIL / NOT VERIFIED**, never substitute a synthetic provider
for real account acceptance.

## Primary references — checked 2026-11-15

- [MCP specification 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [OpenAI custom MCP plugins](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- [Claude remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Gemini web custom connected apps](https://support.google.com/gemini/answer/17209137)
- [Gemini Developer Mode](https://developers.google.com/connected-apps/mcp/dev-mode)
- [MCPJam CLI](https://www.mcpjam.com/features/cli)
