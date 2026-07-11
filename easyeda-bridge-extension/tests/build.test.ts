import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Regression test for a real bug: the second esbuild call in build.mjs used
// to pass a `define` object literal that REPLACED (rather than merged onto)
// commonOptions.define, silently dropping __MCP_DEV_HOTSWAP__ so hot-swap
// support was always compiled out regardless of MCP_DEV_HOTSWAP. Verified
// live: a dev build reported hotSwapCompiled:false in the running extension.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = join(root, 'scripts', 'build.mjs');

function buildInto(outDir: string, env: Record<string, string>): string {
  execFileSync('node', [buildScript], {
    cwd: root,
    env: { ...process.env, MCP_BUILD_OUT_DIR: outDir, ...env },
    stdio: 'pipe',
  });
  return readFileSync(join(outDir, 'index.js'), 'utf8');
}

describe('build.mjs hot-swap define', () => {
  const outDirs: string[] = [];

  afterEach(() => {
    for (const dir of outDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('compiles HOTSWAP_COMPILED to the literal true when MCP_DEV_HOTSWAP=true', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ext-build-dev-'));
    outDirs.push(outDir);
    const bundle = buildInto(outDir, { MCP_DEV_HOTSWAP: 'true' });
    expect(bundle).toMatch(/HOTSWAP_COMPILED\s*=\s*true;/);
    expect(bundle).not.toContain('__MCP_DEV_HOTSWAP__');
  });

  it('compiles HOTSWAP_COMPILED to the literal false when MCP_DEV_HOTSWAP is unset', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ext-build-prod-'));
    outDirs.push(outDir);
    const bundle = buildInto(outDir, { MCP_DEV_HOTSWAP: '' });
    expect(bundle).toMatch(/HOTSWAP_COMPILED\s*=\s*false;/);
    expect(bundle).not.toContain('__MCP_DEV_HOTSWAP__');
  });

  it('declares the startup activation event required by the EasyEDA loader', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'extension.json'), 'utf8')) as {
      activationEvents?: { onStartupFinished?: boolean };
    };

    expect(manifest.activationEvents?.onStartupFinished).toBe(true);
  });

  it('reuses one persistent runtime across repeated EasyEDA menu evaluations', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ext-build-persistent-runtime-'));
    outDirs.push(outDir);
    const bundle = buildInto(outDir, { MCP_DEV_HOTSWAP: '' });

    const storageState = { autoConnect: false };
    const toastMessages: string[] = [];
    const socketMessages = new Map<string, (data: string) => void>();
    let registerCalls = 0;
    const context = vm.createContext({
      console,
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      URL,
      Promise,
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval: () => undefined,
      localStorage: {
        getItem: () => String(storageState.autoConnect),
        setItem: (_key: string, value: string) => {
          storageState.autoConnect = value !== 'false';
        },
      },
      eda: {
        sys_Storage: {
          getExtensionUserConfig: () => storageState.autoConnect,
          setExtensionUserConfig: async (_key: string, value: boolean) => {
            await Promise.resolve();
            storageState.autoConnect = value;
            return true;
          },
        },
        sys_Message: {
          showToastMessage: (message: string) => toastMessages.push(message),
        },
        sys_WebSocket: {
          register: (
            id: string,
            _url: string,
            onMessage: (data: string) => void,
            onOpen?: () => void,
          ) => {
            registerCalls += 1;
            socketMessages.set(id, onMessage);
            queueMicrotask(() => onOpen?.());
          },
          send: (id: string, payload: string) => {
            const parsed = JSON.parse(payload) as { type?: string };
            if (parsed.type === 'handshake') {
              queueMicrotask(() => {
                socketMessages.get(id)?.(
                  JSON.stringify({
                    type: 'hello',
                    contractVersion: 1,
                    supportedProtocolVersions: ['1.0.0'],
                  }),
                );
              });
            }
          },
          close: () => undefined,
        },
      },
    });

    vm.runInContext(bundle, context);
    const firstRuntime = (context as any).__easyedaMcpProBridgeRuntime_v7__;
    await (context as any).edaEsbuildExportName.enableAutoConnect();
    await (context as any).edaEsbuildExportName.enableAutoConnect();
    expect(storageState.autoConnect).toBe(true);
    expect(registerCalls).toBeGreaterThan(0);
    expect(toastMessages.at(-1)).toContain('Auto-Connect: ON');

    vm.runInContext(bundle, context);
    const secondRuntime = (context as any).__easyedaMcpProBridgeRuntime_v7__;
    expect(secondRuntime).toBe(firstRuntime);
    await (context as any).edaEsbuildExportName.disableAutoConnect();
    await (context as any).edaEsbuildExportName.disableAutoConnect();
    expect(storageState.autoConnect).toBe(false);
    expect(toastMessages.at(-1)).toContain('Auto-Connect: OFF');
  });

  it('publishes EasyEDA lifecycle and menu exports through the official IIFE global', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ext-build-lifecycle-'));
    outDirs.push(outDir);
    const bundle = buildInto(outDir, { MCP_DEV_HOTSWAP: '' });

    expect(bundle).toContain('var edaEsbuildExportName = (() => {');
    for (const exportedName of [
      'activate',
      'deactivate',
      'connect',
      'disconnect',
      'showStatus',
      'enableAutoConnect',
      'disableAutoConnect',
      'toggleAutoConnect',
    ]) {
      expect(bundle).toMatch(new RegExp(`${exportedName}: \\(\\) => ${exportedName}`));
    }
  });
});
