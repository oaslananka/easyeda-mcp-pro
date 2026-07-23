export const SUPPORTED_NODE_MAJOR = 24;
export const PINNED_NODE_VERSION = '24.18.0';
export const PINNED_PNPM_VERSION = '11.5.1';

export interface RuntimeVersionEvaluation {
  version: string | null;
  supported: boolean;
  required: string;
  pinned?: string;
}

function normalizeVersion(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function evaluateNodeRuntime(version: string): RuntimeVersionEvaluation {
  const normalized = normalizeVersion(version);
  const major = normalized ? Number(normalized.split('.')[0]) : Number.NaN;
  return {
    version: normalized,
    supported: Number.isInteger(major) && major === SUPPORTED_NODE_MAJOR,
    required: `${SUPPORTED_NODE_MAJOR}.x`,
    pinned: PINNED_NODE_VERSION,
  };
}

export function evaluatePnpmRuntime(version: string | null): RuntimeVersionEvaluation {
  const normalized = normalizeVersion(version);
  return {
    version: normalized,
    supported: normalized === PINNED_PNPM_VERSION,
    required: PINNED_PNPM_VERSION,
  };
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const result = evaluateNodeRuntime(version);
  if (result.supported) return;
  throw new Error(
    `Unsupported Node.js ${version}. easyeda-mcp-pro requires Node.js ${result.required}. Install the pinned ${PINNED_NODE_VERSION} runtime and rerun the command.`,
  );
}
