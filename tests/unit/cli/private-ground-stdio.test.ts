import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supported =
  process.platform === 'linux' && spawnSync('/usr/bin/python3', ['--version']).status === 0;
const names = ['begin', 'delete', 'inspect', 'preview', 'publish', 'rollback'];
const expectedTools = names.map((name) => 'easyeda_private_ground_' + name);

describe.skipIf(!supported)('private Ground real stdio protocol (no native editor)', () => {
  let root: string;
  let host: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'private-ground-stdio-test-'));
    host = join(root, 'host.cjs');
    await build({
      entryPoints: [resolve('scripts/private-ground/host.mjs')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: host,
      logLevel: 'error',
    });
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function connect() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        host,
        '--project',
        'missing.eprj2',
        '--output',
        'new.eprj2',
        '--editor',
        'missing',
        '--activation',
        'missing',
      ],
      cwd: root,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'private-ground-stdio-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  it('lists only scoped tools and refuses missing confirmation and missing launch consent', async () => {
    await copyFile(resolve('scripts/private-ground/launcher.py'), join(root, 'launcher.py'));
    const client = await connect();
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
      const deletion = list.tools.find((tool) => tool.name.endsWith('_delete'));
      expect(deletion?.inputSchema.required).toContain('confirmWrite');
      const deleteResult = await client.callTool({
        name: 'easyeda_private_ground_delete',
        arguments: {},
      });
      expect(deleteResult.isError).toBe(true);
      const inspect = await client.callTool(
        { name: 'easyeda_private_ground_inspect', arguments: {} },
        { timeout: 5000 },
      );
      expect(inspect.isError).toBe(true);
      expect(inspect.structuredContent).toMatchObject({ success: false });
      const second = await client.callTool(
        { name: 'easyeda_private_ground_inspect', arguments: {} },
        { timeout: 5000 },
      );
      expect(second.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('forwards only fixed actions and waits for a successful publication envelope and worker exit', async () => {
    // Synthetic child protocol fixture; no native runtime or actual project file.
    const trace = join(root, 'actions.txt');
    await writeFile(
      join(root, 'launcher.py'),
      [
        'import json,sys,pathlib',
        "trace=pathlib.Path(__file__).with_name('actions.txt')",
        'for line in sys.stdin:',
        "    request=json.loads(line); assert set(request)=={'action'}",
        "    action=request['action']",
        "    with trace.open('a') as f: f.write(action+'\\n')",
        "    result={'success':True,'phase':action}",
        "    if action=='publish':",
        "        result.update(coldReopenVerified=True,originalUnchanged=True,rollbackComplete=True,sha256='a'*64,output='synthetic.eprj2')",
        "    print(json.dumps({'action':action,'result':result}),flush=True)",
        "    if action=='publish': break",
      ].join('\n'),
    );
    const client = await connect();
    try {
      const wrong = await client.callTool({
        name: 'easyeda_private_ground_delete',
        arguments: { confirmWrite: true, primitiveId: 'alien' },
      });
      expect(wrong.isError).toBe(true);
      const inspect = await client.callTool({
        name: 'easyeda_private_ground_inspect',
        arguments: {},
      });
      expect(inspect.structuredContent).toMatchObject({ success: true, phase: 'inspect' });
      const publish = await client.callTool({
        name: 'easyeda_private_ground_publish',
        arguments: { confirmWrite: true },
      });
      expect(publish.structuredContent).toMatchObject({
        success: true,
        coldReopenVerified: true,
        output: 'synthetic.eprj2',
      });
      const after = await client.callTool({
        name: 'easyeda_private_ground_inspect',
        arguments: {},
      });
      expect(after.isError).toBe(true);
      expect(await readFile(trace, 'utf8')).toBe('inspect\npublish\n');
    } finally {
      await client.close();
    }
  });
});
