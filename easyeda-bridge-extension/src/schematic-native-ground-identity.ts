/**
 * Native EasyEDA Pro 4.1.105 Ground-GND symbol identity verified on a
 * disposable .eprj2 in a create/delete/recreate/save/cold-reopen cycle.
 *
 * This identifies only the exact GND power symbol, not a generic net label,
 * alternate ground library or another editor version. It does not authorize
 * deletion: the transactional server preflight remains a separate gate.
 */
export const VERIFIED_V4_GROUND_SYMBOL = Object.freeze({
  libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
  uuid: 'af20086a8911a85a',
  name: 'Ground-GND',
});

export function isVerifiedV4GroundSymbol(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.libraryUuid === VERIFIED_V4_GROUND_SYMBOL.libraryUuid &&
    v.uuid === VERIFIED_V4_GROUND_SYMBOL.uuid &&
    v.name === VERIFIED_V4_GROUND_SYMBOL.name
  );
}

export function verifiedNativeGroundDescriptor(
  nativeSymbol: unknown,
  nativeVersion: string | undefined,
  net: unknown,
): { identification: 'Ground'; nativeSymbol: typeof VERIFIED_V4_GROUND_SYMBOL } | undefined {
  if (nativeVersion !== '4.1.105' || net !== 'GND' || !isVerifiedV4GroundSymbol(nativeSymbol)) {
    return undefined;
  }
  return { identification: 'Ground', nativeSymbol: { ...VERIFIED_V4_GROUND_SYMBOL } };
}
