/**
 * Risk classification for EasyEDA bridge methods reached via the Remote
 * Relay `tool_request` path.
 *
 * `tool_request.toolName` carries a bridge method name (e.g.
 * `schematic.listNets`, `pcb.placeComponent`) — the same vocabulary
 * `dispatch()` in index.ts already understands for local bridge requests.
 * This keeps a single source of truth for "what can the bridge do" instead
 * of introducing a second, MCP-tool-name-shaped vocabulary that the
 * extension bundle would have to keep in sync with `src/tools/*.ts`.
 *
 * `dispatch()` itself already fails closed for any method not in its
 * switch statement (`METHOD_NOT_ALLOWED`). This module only adds the
 * additional risk tier needed to gate write/export/destructive methods
 * behind remote approval, independent of whatever risk level a (not yet
 * implemented) upstream gateway may claim in the request envelope.
 */

export type RemoteBridgeRisk = 'read' | 'write' | 'export' | 'destructive';

/** Methods that delete design data. Always the highest risk tier. */
const DESTRUCTIVE_METHODS = new Set(['pcb.deleteComponent', 'schematic.deletePrimitive']);

/** Methods that produce an external file/artifact. */
const EXPORT_METHODS = new Set([
  'board.exportGerbers',
  'export.netlist',
  'export.pdf',
  'export.pickPlace',
  'project.export',
]);

/** Methods that mutate design/document state but are neither destructive nor an export. */
const WRITE_METHODS = new Set([
  'pcb.addTrack',
  'pcb.addVia',
  'pcb.addZone',
  'pcb.modifyComponent',
  'pcb.placeComponent',
  'schematic.addWire',
  'schematic.connectPinToNet',
  'schematic.connectPinsByNet',
  'schematic.createNetFlag',
  'schematic.createNetPort',
  'schematic.modifyPrimitive',
  'schematic.placeComponent',
  'project.save',
]);

const RISK_ORDER: Record<RemoteBridgeRisk, number> = {
  read: 0,
  write: 1,
  export: 2,
  destructive: 3,
};

/**
 * Classify a bridge method by the risk it poses if executed unattended
 * over a remote relay connection.
 *
 * `api.call`/`api.execute` are raw EasyEDA API escape hatches with no
 * fixed effect set, so they are always treated as `destructive` for the
 * remote path regardless of the arguments supplied.
 */
export function classifyBridgeMethodRisk(method: string): RemoteBridgeRisk {
  if (method.startsWith('api.')) return 'destructive';
  if (DESTRUCTIVE_METHODS.has(method)) return 'destructive';
  if (EXPORT_METHODS.has(method)) return 'export';
  if (WRITE_METHODS.has(method)) return 'write';
  return 'read';
}

/**
 * Combine the extension's own method-based risk classification with a risk
 * level optionally declared by the request envelope (e.g. from a future
 * gateway policy layer). The stricter (higher) of the two always wins —
 * the envelope can never downgrade a method the extension itself considers
 * more dangerous.
 */
export function resolveRemoteRisk(method: string, declaredRiskLevel?: string): RemoteBridgeRisk {
  const localRisk = classifyBridgeMethodRisk(method);
  if (!isRemoteBridgeRisk(declaredRiskLevel)) return localRisk;
  return RISK_ORDER[declaredRiskLevel] >= RISK_ORDER[localRisk] ? declaredRiskLevel : localRisk;
}

function isRemoteBridgeRisk(value: string | undefined): value is RemoteBridgeRisk {
  return value === 'read' || value === 'write' || value === 'export' || value === 'destructive';
}
