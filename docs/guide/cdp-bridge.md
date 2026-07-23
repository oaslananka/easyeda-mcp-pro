# CDP Bridge (Experimental)

The Chrome DevTools Protocol (CDP) bridge is an experimental, local diagnostic transport for attaching the MCP server to an already-open EasyEDA Pro renderer. The EasyEDA bridge extension remains the recommended transport for normal use because it has the broadest live-validation evidence and the most predictable lifecycle.

Use CDP when developing or debugging bridge mappings, not as a replacement for the extension in production workflows.

## Security boundary

CDP can evaluate code inside the EasyEDA renderer. Keep the debugging endpoint on loopback and never expose it on `0.0.0.0`, a LAN interface, a tunnel, or a public reverse proxy. Close EasyEDA Pro when the debugging session is finished.

Use a disposable project for every write-path experiment. MCP confirmation, profile, and scope controls still apply, and CDP adds its own write gates described below.

## Start EasyEDA Pro with local debugging

Launch EasyEDA Pro with a loopback-only debugging endpoint:

```bash
easyeda-pro \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222
```

Package-specific launchers may require their normal platform arguments in addition to the two remote-debugging flags. Do not add `--no-sandbox` unless your existing EasyEDA package already requires it and you understand the reduced isolation.

After opening a project, confirm that the target list is available only from the local machine:

```bash
curl --fail http://127.0.0.1:9222/json/list
```

## Start the MCP server in CDP mode

From a source checkout:

```bash
EASYEDA_BRIDGE=cdp \
EASYEDA_CDP_URL=http://127.0.0.1:9222 \
TOOL_PROFILE=dev \
pnpm dev
```

The default URL is `http://127.0.0.1:9222`. Set `EASYEDA_CDP_TARGET_ID` only when multiple matching renderer targets are present and automatic target selection is ambiguous.

## Verify the connection

Start with read-only diagnostics:

1. Call `easyeda_health_check`.
2. Call `easyeda_bridge_status` and confirm that the selected bridge is `cdp`.
3. Call `easyeda_get_capabilities`.
4. In the `dev` profile, use `easyeda_bridge_probe_methods` before relying on a method mapping.

A successful CDP connection proves target discovery and renderer communication; it does not prove that every extension method is mapped through CDP. Unmapped calls fail with `CDP_METHOD_NOT_MAPPED` rather than guessing an EasyEDA runtime API.

## Write gates

Mapped mutating methods are disabled unless the process explicitly enables them:

```bash
EASYEDA_CDP_ALLOW_WRITES=true
```

Use this only with a disposable EasyEDA project. The MCP tool must still pass its normal confirmation and authorization checks.

Unmapped methods that look mutating are blocked by a separate, stronger gate:

```bash
EASYEDA_CDP_ALLOW_UNMAPPED_WRITES=true
```

This flag exists for controlled bridge-development probes. It is not a general automation mode and must never be enabled against a valuable project. Prefer adding and testing a typed mapping instead of leaving this flag enabled.

Raw `api.execute` access is also subject to the repository's raw-execution quarantine and tool-profile policy. CDP does not bypass those controls.

## Known limitations

- The extension bridge is the supported default and has stronger live compatibility evidence.
- CDP support is method-by-method; extension parity must not be assumed.
- Renderer internals can change between EasyEDA Pro releases.
- The endpoint is local-only and is not part of the hosted or self-hosted Remote MCP transport model.
- Live support claims belong in the [EasyEDA compatibility matrix](../reference/easyeda-compatibility.md), not in ad hoc debug notes.

A historical local probe confirmed EasyEDA editor target discovery on EasyEDA Pro `3.2.149.88089769`. That observation is useful development evidence, not a blanket compatibility guarantee.
