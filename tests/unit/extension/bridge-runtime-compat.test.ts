import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const extensionSourcePath = join(process.cwd(), 'easyeda-bridge-extension', 'src', 'index.ts');

async function readExtensionSource(): Promise<string> {
  return readFile(extensionSourcePath, 'utf8');
}

describe('bridge extension runtime compatibility guards', () => {
  it('only marks the register socket open via the real connectedCallFn, never a speculative timer', async () => {
    const source = await readExtensionSource();

    expect(source).toContain('const fireOpen = (): void =>');
    expect(source).not.toContain('EASYEDA_REGISTER_OPEN_FALLBACK_MS');
    expect(source).toContain("Only the API's real connected callback may mark the socket open.");
  });

  it('surfaces the External Interactions permission hint when register throws', async () => {
    const source = await readExtensionSource();

    expect(source).toContain('showExternalInteractionHintOnce');
    expect(source).toContain('External Interactions permission');
    expect(source).toContain('showToast(message);');
  });
});
