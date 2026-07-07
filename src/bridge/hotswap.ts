import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Dev-only dispatcher hot swap (BRIDGE_HOT_SWAP_ENABLED): pushes a freshly
 * built extension dispatcher bundle (easyeda-bridge-extension/dist/dispatcher.js)
 * over the bridge as system.hotSwap.begin/chunk/commit frames. The extension
 * loader verifies the sha256, evals the bundle, and swaps its active
 * dispatcher — no .eext re-import, no reconnect.
 */

export interface DispatcherArtifact {
  source: string;
  buildId: string;
  sha256: string;
  byteLength: number;
}

export interface LoaderStatus {
  loaderVersion?: string;
  activeDispatcher?: 'baked' | 'pushed';
  buildId?: string;
  bakedBuildId?: string;
  methodCount?: number;
  methodListHash?: string;
  hotSwapCompiled?: boolean;
  hotSwapEnabled?: boolean;
}

export interface HotSwapResult {
  swapped: boolean;
  buildId?: string;
  methodCount?: number;
  methodListHash?: string;
}

type BridgeCall = <TParams, TResult>(
  method: string,
  params?: TParams,
  opts?: { timeoutMs?: number },
) => Promise<TResult>;

const BUILD_ID_PATTERN = /^[A-Za-z0-9x-]{4,64}$/;

/**
 * Read the dispatcher bundle plus its build metadata. The buildId comes from
 * the `dispatcher.meta.json` sidecar written by the extension build script;
 * the hash/size are recomputed from the actual bundle so a stale sidecar can
 * never push mismatched bytes.
 */
export function readDispatcherArtifact(bundlePath: string): DispatcherArtifact {
  const source = readFileSync(bundlePath, 'utf8');
  const metaPath = bundlePath.replace(/\.js$/, '.meta.json');
  let buildId = '';
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { buildId?: unknown };
    if (typeof meta.buildId === 'string' && BUILD_ID_PATTERN.test(meta.buildId)) {
      buildId = meta.buildId;
    }
  } catch {
    // Sidecar missing/unreadable — fall back to a content hash id below.
  }
  const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  if (!buildId) {
    const h = sha256.slice(0, 12);
    buildId = `d${h.slice(0, 4)}x${h.slice(4, 8)}x${h.slice(8, 12)}`;
  }
  return {
    source,
    buildId,
    sha256,
    byteLength: Buffer.byteLength(source, 'utf8'),
  };
}

export async function fetchLoaderStatus(call: BridgeCall): Promise<LoaderStatus> {
  return call<Record<string, never>, LoaderStatus>('system.loaderStatus', {});
}

/**
 * Drive a full begin → chunk* → commit push. Throws on any step failure; the
 * extension keeps its previous dispatcher in that case.
 */
export async function pushDispatcher(
  call: BridgeCall,
  artifact: DispatcherArtifact,
  chunkBytes: number,
): Promise<HotSwapResult> {
  const chunkSize = Math.max(4096, chunkBytes);
  const totalChunks = Math.max(1, Math.ceil(artifact.source.length / chunkSize));

  await call('system.hotSwap.begin', {
    totalChunks,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    buildId: artifact.buildId,
  });

  for (let seq = 0; seq < totalChunks; seq += 1) {
    await call('system.hotSwap.chunk', {
      seq,
      data: artifact.source.slice(seq * chunkSize, (seq + 1) * chunkSize),
    });
  }

  const result = await call<Record<string, never>, HotSwapResult>('system.hotSwap.commit', {});
  if (!result?.swapped) {
    throw new Error('Hot-swap commit did not report a successful swap');
  }
  if (result.buildId !== artifact.buildId) {
    throw new Error(
      `Hot-swap build id mismatch: pushed ${artifact.buildId}, extension reports ${result.buildId}`,
    );
  }
  return result;
}

export async function revertDispatcher(
  call: BridgeCall,
): Promise<{ reverted: boolean; buildId?: string }> {
  return call<Record<string, never>, { reverted: boolean; buildId?: string }>(
    'system.hotSwap.revert',
    {},
  );
}
