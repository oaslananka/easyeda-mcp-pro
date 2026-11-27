# Extension RPC (Experimental)

`easyeda_extension_call` lets an MCP client call functions that **your own EasyEDA extension**
exposes. Use it when an analysis already lives in an extension (for example, a return-path checker)
and you want an agent to run it across many nets, then summarize the findings.

The bridge forwards JSON data over EasyEDA's public message bus. It never sends code, and it can only
reach services that opt in.

## 1. Expose a service from your extension

Register a handler on the public bus under the `mcp.` namespace:

```js
eda.sys_MessageBus.rpcServicePublic('mcp.rcp.checkNet', async (message) => {
  // message is the JSON payload the agent sent, e.g. { net: 'USB_DP' }
  const violations = await analyzeReturnPath(message.net);
  return { net: message.net, violations }; // return plain JSON
});
```

- Topics must match `mcp.<name>`, using letters, digits, `_`, `-` and `.`, up to 124 characters in
  total. Anything else is unreachable from the bridge.
- The handler receives one argument. Pack request fields into an object.
- Return JSON-serializable data. Functions and native objects are reduced to descriptions, and
  nesting deeper than 10 levels is cut off.
- Only allow trusted services. They may mutate designs or perform external actions. The bridge can't inspect what a service does; the service must guard its own target and writes.

## 2. Allow the topic on the MCP server

The tool is disabled until you list the topics it may call. Use exact topics or a prefix ending
in `*`:

```bash
BRIDGE_EXTENSION_RPC_TOPICS=mcp.rcp.*
```

The tool is in the `experimental` profile, so also set `TOOL_PROFILE=experimental`.

## 3. Call it

```json
{
  "tool": "easyeda_extension_call",
  "arguments": {
    "topic": "mcp.rcp.checkNet",
    "message": { "net": "USB_DP" },
    "timeoutMs": 20000,
    "confirmWrite": true
  }
}
```

Each invocation needs explicit `confirmWrite: true` and a write-capable server scope. A configured allowlist does not grant per-invocation consent.

The result is `{ "topic", "ok": true, "result": <service reply> }`. When something goes wrong, `ok` is
`false` and `error` explains why. `outcomeUnknown: true` means a dispatched service may have performed a side effect or may still be running; inspect its state before retrying. A verified pre-dispatch refusal (unsupported runtime, invalid parameters, missing confirmation, bridge registry/version mismatch, a disconnected bridge, an unsupported remote dispatcher, or an invalid remote invocation grant) returns `outcomeUnknown: false`. `disabled: true` means the allowlist is empty. A terminal Remote Relay dispatch deadline instead returns the structured `ERR_REMOTE_RELAY` error with `details.remoteCode: REMOTE_EXTENSION_TIMEOUT` and `details.outcomeUnknown: true`, including the same inspect-before-retry warning in its text. The relay session is quarantined; do not automatically retry.

## Limits and safety

| Limit           | Value                                                            |
| --------------- | ---------------------------------------------------------------- |
| Request payload | 256 KiB of JSON                                                  |
| Reply           | Up to 256 KiB, or half the negotiated transport limit if smaller |
| Service timeout | 100 ms – 60 s (default 10 s)                                     |
| Version drift   | Refused while the extension and server versions differ           |

Remote Relay treats every call as `destructive` (high-risk `external-action`), requires the `easyeda.project_admin` scope, and asks for approval on every call. The native approval prompt identifies the exact service topic without exposing the message payload. See
[Safety Model §1.5](../SAFETY_MODEL.md#_1-5-extension-rpc-easyeda-extension-call).

Direct raw relay dispatch is disabled. Remote calls must use the allowlisted MCP tool and its matching, single-use invocation approval. Reply data is copied within the byte budget (depth 10); methods, accessors and non-JSON values are not executed. Oversized replies are rejected without sending their contents; the service may already have acted.
