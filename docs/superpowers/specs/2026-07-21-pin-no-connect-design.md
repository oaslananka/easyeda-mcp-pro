# Native Pin No-Connect Design

## Context

Issue #328 requests native EasyEDA Pro no-connect support. EasyEDA Pro does not represent this marker as a standalone schematic component. The official UI guide states that placing or deleting a No Connect marker toggles the target component pin's `No Connected` state. The official Extension API exposes component pins through `SCH_PrimitiveComponent.getAllPinsByPrimitiveId`, readback through `ISCH_PrimitiveComponentPin.getState_NoConnected()`, and mutation through the component-pin state/`SCH_PrimitivePin.modify` API.

`SCH_PrimitiveComponent.createShortCircuitFlag()` is a different short-circuit symbol and must not be used for this feature. `schematic.createNetFlag` must remain limited to named net labels and power/ground flags.

## Goals

- Expose a dedicated MCP write tool that sets or clears native no-connect state on one exact component pin.
- Resolve pins by component primitive ID plus exact pin number.
- Fail before mutation when the target pin is missing or ambiguous.
- Return the real component-pin primitive ID, prior state, final state, and readback verification.
- Support bridge-extension and CDP bridge paths.
- Expose `primitiveId` and `noConnected` in the existing component-pin read tool.
- Preserve the existing net model: no wire, label, net flag, or net name is created.
- Keep the operation reversible by accepting `noConnected: false`.

## Non-goals

- Do not add `NoConnect` to the net-flag identification enum.
- Do not call `createShortCircuitFlag`.
- Do not infer a pin from coordinates alone.
- Do not silently pick the first duplicate pin number.
- Do not claim live macOS/EasyEDA validation until it has actually been performed.

## Public MCP interface

Tool name: `easyeda_schematic_set_pin_no_connect`

Input:

```ts
{
  projectId: string;
  primitiveId: string; // component primitive ID
  pinNumber: string;
  noConnected?: boolean; // defaults to true
  confirmWrite: true;
}
```

Output:

```ts
{
  success: boolean;
  project_id: string;
  component_primitive_id: string;
  pin_primitive_id?: string;
  pin_number: string;
  previous_no_connected?: boolean;
  no_connected?: boolean;
  changed?: boolean;
  verified?: boolean;
  error_code?: string;
  error?: string;
}
```

The tool is a `core`, `medium`-risk, confirmed write. `noConnected: false` removes the native marker.

## Bridge interface

Read method:

```ts
schematic.getPinNoConnect({ projectId, primitiveId, pinNumber });
```

Write method:

```ts
schematic.setPinNoConnect({ projectId, primitiveId, pinNumber, noConnected });
```

Both bridge implementations must:

1. Call `SCH_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)`.
2. Compare normalized pin numbers exactly as strings.
3. Require exactly one match.
4. Extract the real component-pin primitive ID.
5. Read `NoConnected` through the native getter/state.

The write method must set only `noConnected`, read the pin again, and reject an unverified result.

## Runtime compatibility strategy

The extension dispatcher should prefer the component-pin object's public `setState_NoConnected(value)` plus `done()` path when available. It may fall back to `SCH_PrimitivePin.modify(pin, { noConnected: value })` for runtimes exposing the documented class method. The CDP expression follows the same order.

No fallback may mutate unrelated pin fields.

## Batch behavior

The initial feature PR will add a batch operation `action: "setPinNoConnect"` with component primitive ID, pin number, and desired boolean. Atomic rollback snapshots the prior pin state through `schematic.getPinNoConnect` and restores it with `schematic.setPinNoConnect` if a later operation fails.

## Read model

`easyeda_schematic_component_pins` will additionally return:

```ts
{
  primitiveId?: string;
  noConnected?: boolean;
}
```

This makes the write independently observable and gives agents a safe preflight/readback path.

## Error model

- `PIN_NOT_FOUND`: no exact pin-number match.
- `PIN_AMBIGUOUS`: more than one exact match.
- `PIN_PRIMITIVE_ID_UNAVAILABLE`: the runtime did not expose a real pin ID.
- `PIN_NO_CONNECT_UNSUPPORTED`: neither supported mutation path exists.
- `PIN_NO_CONNECT_VERIFY_FAILED`: post-write readback differs from the requested state.

Errors are returned by the MCP tool without inventing success. Bridge errors preserve `code`, `message`, and diagnostic details when available.

## Testing

- MCP schema and handler unit tests for set, clear, defaults, and bridge errors.
- Component-pin read tests for direct and nested `primitiveId`/`NoConnected` fields.
- Extension dispatcher tests for setter/done, class-modify fallback, missing pin, duplicate pin, and readback mismatch.
- CDP expression tests verifying mapped read/write behavior and generated API calls.
- Atomic batch tests for apply and rollback.
- Full repository verification.
- Draft PR remains marked as requiring live macOS/EasyEDA validation for ERC behavior and save/reopen persistence.

## Official references

- https://prodocs.easyeda.com/en/schematic/place-no-connect/
- https://prodocs.easyeda.com/en/api/reference/pro-api.sch_primitivecomponent.getallpinsbyprimitiveid.html
- https://prodocs.easyeda.com/en/api/reference/pro-api.sch_primitivepin.modify.html
- https://prodocs.easyeda.com/en/api/reference/pro-api.isch_primitivecomponentpin.getstate_noconnected.html
- https://prodocs.easyeda.com/en/api/reference/pro-api.isch_primitivecomponentpin.setstate_noconnected.html
