import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_HOSTED_RELAY_URL } from '../src/remote-client.js';

describe('Cloud connection menu', () => {
  it('offers the official Cloud first and Custom Cloud independently on every EasyEDA editor', () => {
    const manifestPath = fileURLToPath(new URL('../extension.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      headerMenus: Record<
        string,
        Array<{ menuItems: Array<{ title: string; registerFn: string }> }>
      >;
    };
    expect(Object.keys(manifest.headerMenus).sort()).toEqual(['home', 'pcb', 'pcbView', 'sch']);
    for (const entries of Object.values(manifest.headerMenus)) {
      const menus = entries[0].menuItems;
      expect(menus.slice(0, 3).map((item) => item.registerFn)).toEqual([
        'connectHostedCloud',
        'connectCustomRemote',
        'connect',
      ]);
      expect(menus[0].title).toBe('Connect EasyEDA MCP Pro Cloud');
      expect(menus[1].title).toContain('Custom Cloud (WSS)');
      expect(menus[2].title).toBe('Connect Local MCP');
      expect(menus.some((item) => /experimental/i.test(item.title))).toBe(false);
    }
    expect(OFFICIAL_HOSTED_RELAY_URL).toBe('wss://easyeda-mcp-pro.oaslananka.dev/remote/relay');
  });
});
