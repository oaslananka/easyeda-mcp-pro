export function extractPinsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.pins)) {
    return payload.pins;
  }
  return [];
}
