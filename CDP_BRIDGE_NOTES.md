# CDP Bridge Notes

Date: 2026-07-06

## Verified

EasyEDA Pro was started with remote debugging on 127.0.0.1:9222. The HTTP target list exposed an open editor page:

- title: TestProject | JLCEDA Pro - V3.2.149.88089769
- type: page
- URL: pro.easyeda.com/editor

## Added

- src/bridge/cdp-manager.ts
- src/server/factory.ts selects CDP mode when EASYEDA_BRIDGE=cdp

## Usage

Start EasyEDA Pro:

```bash
easyeda-pro --no-sandbox --gtk-version=3 --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

Start MCP in CDP mode:

```bash
EASYEDA_BRIDGE=cdp EASYEDA_CDP_URL=http://127.0.0.1:9222 pnpm dev
```

## First-pass mapped calls

- system.getStatus
- system.apiInventory
- api.execute
- api.call

## Deliberately blocked until mapped

- schematic write methods
- pcb write methods
- project save/export methods

## Next debug sequence

1. Read status through MCP/CDP.
2. Inventory EasyEDA runtime globals.
3. Identify schematic editor runtime objects.
4. Map read methods first.
5. Map write methods one by one on a disposable schematic.
6. Draw a simple LED-resistor circuit.
7. Port stable CDP mappings back into the extension bridge.

## Current known issues

1. Existing development flow depends on extension package/import/reload.
2. Original bridge was extension-only and could not attach to an already open EasyEDA renderer.
3. Runtime write calls must not be guessed because wrong mappings can corrupt the open project.
