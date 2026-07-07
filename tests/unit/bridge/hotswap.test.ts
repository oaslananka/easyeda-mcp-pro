import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pushDispatcher, readDispatcherArtifact } from '../../../src/bridge/hotswap.js';

function makeArtifactDir(source: string, buildId?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hotswap-'));
  writeFileSync(join(dir, 'dispatcher.js'), source);
  if (buildId) {
    writeFileSync(join(dir, 'dispatcher.meta.json'), JSON.stringify({ buildId }));
  }
  return dir;
}

describe('readDispatcherArtifact', () => {
  it('reads the bundle and takes the buildId from the meta sidecar', () => {
    const dir = makeArtifactDir('console.log(1);', 'dab12xcd34xef56');
    const artifact = readDispatcherArtifact(join(dir, 'dispatcher.js'));
    expect(artifact.buildId).toBe('dab12xcd34xef56');
    expect(artifact.byteLength).toBe(Buffer.byteLength('console.log(1);', 'utf8'));
    expect(artifact.sha256).toBe(
      crypto.createHash('sha256').update('console.log(1);', 'utf8').digest('hex'),
    );
  });

  it('falls back to a content-hash buildId when the sidecar is missing', () => {
    const dir = makeArtifactDir('console.log(2);');
    const artifact = readDispatcherArtifact(join(dir, 'dispatcher.js'));
    expect(artifact.buildId).toMatch(/^d[0-9a-f]{4}x[0-9a-f]{4}x[0-9a-f]{4}$/);
  });
});

describe('pushDispatcher', () => {
  it('drives begin, all chunks in order, then commit, and verifies the echoed buildId', async () => {
    const source = 'x'.repeat(10_000);
    const dir = makeArtifactDir(source, 'dtestxbuildxid1');
    const artifact = readDispatcherArtifact(join(dir, 'dispatcher.js'));

    const calls: Array<{ method: string; params: unknown }> = [];
    const call = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === 'system.hotSwap.commit') {
        return { swapped: true, buildId: 'dtestxbuildxid1', methodCount: 49 };
      }
      return {};
    });

    const result = await pushDispatcher(call as never, artifact, 4096);
    expect(result.buildId).toBe('dtestxbuildxid1');

    expect(calls[0].method).toBe('system.hotSwap.begin');
    expect(calls[0].params).toMatchObject({
      totalChunks: 3,
      byteLength: 10_000,
      sha256: artifact.sha256,
      buildId: 'dtestxbuildxid1',
    });
    const chunkCalls = calls.filter((c) => c.method === 'system.hotSwap.chunk');
    expect(chunkCalls).toHaveLength(3);
    const reassembled = chunkCalls.map((c) => (c.params as { data: string }).data).join('');
    expect(reassembled).toBe(source);
    expect(calls[calls.length - 1].method).toBe('system.hotSwap.commit');
  });

  it('throws when the extension echoes a different buildId', async () => {
    const dir = makeArtifactDir('y'.repeat(100), 'daaaaxbbbbxcccc');
    const artifact = readDispatcherArtifact(join(dir, 'dispatcher.js'));
    const call = vi.fn(async (method: string) =>
      method === 'system.hotSwap.commit' ? { swapped: true, buildId: 'dother' } : {},
    );
    await expect(pushDispatcher(call as never, artifact, 4096)).rejects.toThrow(
      /build id mismatch/,
    );
  });
});
