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
- If the service can change the design, guard those writes inside the service. The bridge can't
  inspect what a service does.

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
  "arguments": { "topic": "mcp.rcp.checkNet", "message": { "net": "USB_DP" }, "timeoutMs": 20000 }
}
```

The result is `{ "topic", "ok": true, "result": <service reply> }`. When something goes wrong, `ok` is
`false` and `error` explains why. `disabled: true` means the allowlist is empty.

## Limits and safety

| Limit           | Value                                                  |
| --------------- | ------------------------------------------------------ |
| Request payload | 256 KiB of JSON                                        |
| Reply           | `BRIDGE_MAX_PAYLOAD_SIZE` (1 MiB by default)           |
| Service timeout | 100 ms – 60 s (default 10 s)                           |
| Version drift   | Refused while the extension and server versions differ |

Remote Relay treats every call as a `write` (`external-action`) and asks for approval. See
[Safety Model §1.5](../SAFETY_MODEL.md#_1-5-extension-rpc-easyeda-extension-call).
