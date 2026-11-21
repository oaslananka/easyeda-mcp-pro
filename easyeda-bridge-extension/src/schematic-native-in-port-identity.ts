import { isRecord } from './utils.js';

/**
 * Exact V4.1.105 IN port identity observed in a disposable native
 * delete/recreate/save/full cold reopen. Neither its display name nor its net
 * alone is sufficient. This read-only evidence grants no write permission.
 */
const VERIFIED_V4_IN_PORT = Object.freeze({
  libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
  uuid: '21c0c70348655df0',
  name: 'Netport-IN',
});

interface NativePortIdentityDependencies {
  readFirstPath(paths: string[]): unknown;
  readState(primitive: unknown, key: string): unknown;
  extractPrimitiveId(primitive: unknown): string;
}

interface NativeReader {
  get?(id: string): Promise<unknown>;
}

interface NativePortIdentity {
  direction: 'IN';
  nativeSymbol: typeof VERIFIED_V4_IN_PORT;
}

function matchesSymbol(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.libraryUuid === VERIFIED_V4_IN_PORT.libraryUuid &&
    value.uuid === VERIFIED_V4_IN_PORT.uuid &&
    value.name === VERIFIED_V4_IN_PORT.name
  );
}

function matchesPort(
  deps: NativePortIdentityDependencies,
  port: unknown,
  id: string,
  property: Record<string, unknown>,
): boolean {
  const state = (key: string) => deps.readState(port, key);
  const direction = state('Direction');
  return (
    deps.extractPrimitiveId(port) === id &&
    state('ComponentType') === 'netport' &&
    matchesSymbol(state('Component')) &&
    state('Name') === property.net &&
    state('Net') === property.net &&
    state('X') === property.x &&
    state('Y') === property.y &&
    state('Rotation') === 0 &&
    state('Mirror') === false &&
    (direction === undefined || direction === 'IN')
  );
}

function matchesPin(
  deps: NativePortIdentityDependencies,
  pin: unknown,
  pinId: string,
  property: Record<string, unknown>,
): boolean {
  const state = (key: string) => deps.readState(pin, key);
  return (
    deps.extractPrimitiveId(pin) === pinId &&
    state('PinName') === 'IN' &&
    state('PinNumber') === '1' &&
    state('pinType') === 'IN' &&
    state('X') === property.x &&
    state('Y') === property.y &&
    state('Rotation') === 0 &&
    state('NoConnected') === false
  );
}

function supportedPose(property: Record<string, unknown>): boolean {
  return (
    typeof property.net === 'string' &&
    property.net.length > 0 &&
    property.net.length <= 1024 &&
    typeof property.x === 'number' &&
    Number.isFinite(property.x) &&
    typeof property.y === 'number' &&
    Number.isFinite(property.y) &&
    property.rotation === 0 &&
    property.mirror === false &&
    (property.direction === undefined || property.direction === 'IN')
  );
}

/**
 * Call only inside a typed native V4.1.105 project/page read bracket. The
 * observed unmirrored, zero-rotation IN descriptor must match both the
 * embedded pin and its independently addressable native pin. Scope is
 * rechecked by the caller. No connectivity or attribute-isolation claim.
 */
export async function inspectVerifiedNativeInPort(
  deps: NativePortIdentityDependencies,
  id: string,
  property: Record<string, unknown>,
): Promise<NativePortIdentity | undefined> {
  if (!id || !supportedPose(property)) return undefined;
  try {
    const components = deps.readFirstPath(['SCH_PrimitiveComponent', 'sch_PrimitiveComponent']) as
      NativeReader | undefined;
    const pins = deps.readFirstPath(['SCH_PrimitivePin', 'sch_PrimitivePin']) as
      NativeReader | undefined;
    if (typeof components?.get !== 'function' || typeof pins?.get !== 'function') return undefined;
    const port = await components.get(id);
    if (!matchesPort(deps, port, id, property)) return undefined;
    const withPins = port as { getAllPins?: () => Promise<unknown> };
    if (typeof withPins.getAllPins !== 'function') return undefined;
    const embedded = await withPins.getAllPins();
    const pinId = id + '-e11';
    if (!Array.isArray(embedded) || embedded.length !== 1) return undefined;
    if (!matchesPin(deps, embedded[0], pinId, property)) return undefined;
    if (!matchesPin(deps, await pins.get(pinId), pinId, property)) return undefined;
    if (!matchesPort(deps, await components.get(id), id, property)) return undefined;
    return { direction: 'IN', nativeSymbol: { ...VERIFIED_V4_IN_PORT } };
  } catch {
    // Native read ambiguity is not verification; do not guess a direction.
    return undefined;
  }
}
