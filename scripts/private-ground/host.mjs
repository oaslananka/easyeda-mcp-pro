import { createGroundSession } from './host-session.mjs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { z } from 'zod';

function verifiedPublicationBase(result) {
  return [
    result.coldReopenVerified === true,
    result.originalUnchanged === true,
    /^[0-9a-f]{64}$/.test(result.sha256 ?? ''),
    typeof result.output === 'string',
  ].every(Boolean);
}

function verifiedDeletionPublication(result) {
  return [
    verifiedPublicationBase(result),
    result.deletedVerified === true,
    result.deleteCommitted === true,
    result.rollbackComplete === false,
    typeof result.deletedId === 'string',
    result.deletedId?.length > 0,
  ].every(Boolean);
}

async function checkedResponse(action, value, exit) {
  const response = JSON.parse(value);
  if (response?.action !== action || typeof response.result?.success !== 'boolean')
    throw new Error('Private worker response does not match the request');
  const result = response.result;
  if (result.success === true && action === 'publish_delete') {
    if (!verifiedDeletionPublication(result) || (await exit) !== 0)
      throw new Error('Verified committed deletion output unavailable');
  }
  if (result.success === true && action === 'publish') {
    if (!verifiedPublicationBase(result) || result.rollbackComplete !== true || (await exit) !== 0)
      throw new Error('Verified output result unavailable');
  }
  return result;
}

// Only trusted, fixed actions are forwarded to the isolated worker. The
// original project/output paths are supplied at launch, never by MCP input.
function startWorker(args) {
  const child = spawn(
    '/usr/bin/python3',
    [join(__dirname, 'launcher.py'), ...args, '--node', process.execPath, '--interactive'],
    {
      shell: false,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let failed = false;
  child.on('error', () => {
    failed = true;
    lines.close();
  });
  child.stdin.on('error', () => {
    failed = true;
    lines.close();
  });
  const exit = new Promise((resolve) => child.once('close', resolve));
  return {
    async call(action) {
      if (failed) throw new Error('Private worker unavailable');
      child.stdin.write(JSON.stringify({ action }) + '\n');
      const { done, value } = await iterator.next();
      if (done || value.length > 65536) throw new Error('Private worker response unavailable');
      return checkedResponse(action, value, exit);
    },
    stop() {
      failed = true;
      lines.close();
      child.stdin.destroy();
      child.kill('SIGTERM');
    },
  };
}

const specs = [
  [
    'inspect',
    'Inspect Ground in the isolated copy. Returns current phase and native snapshot or verified absence.',
    false,
  ],
  ['preview', 'Preview the only supported deletion, without modifying the working copy.', false],
  ['begin', 'Begin one-operation transaction after preview; must precede delete.', false],
  ['delete', 'Delete the bound Ground on the private copy; requires explicit confirmation.', true],
  [
    'rollback',
    'Restore the deleted Ground and verify its native fingerprint; does not publish a file.',
    true,
  ],
  [
    'publish',
    'Save the verified rollback, cold reopen in a new worker, and publish only a new output file. Ends this session.',
    true,
  ],
  [
    'publish_delete',
    'Commit the independently verified Ground deletion, save and cold reopen a new project COPY. Never overwrites the original; there is no rollback after publication.',
    true,
  ],
];

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'private-ground-session --project INPUT.eprj2 --output NEW.eprj2 --editor PATH --activation PATH --confirm-write --allow-library-network',
    );
    console.log(
      'Linux-only stdio MCP session for one disconnected default Ground. Preview, begin, delete; then rollback+publish or publish_delete into a NEW copy. The isolated worker has a bounded 260-second operation window. Disconnect discards unverified work.',
    );
    return;
  }
  const session = createGroundSession(() => startWorker(args));
  const server = new McpServer({ name: 'easyeda-private-ground-session', version: '1.0.0' });
  for (const [action, description, confirm] of specs) {
    server.registerTool(
      'easyeda_private_ground_' + action,
      {
        description,
        inputSchema: confirm
          ? z.object({ confirmWrite: z.literal(true) }).strict()
          : z.object({}).strict(),
        annotations: {
          readOnlyHint: action === 'inspect' || action === 'preview',
          destructiveHint: action === 'delete' || action === 'publish_delete',
        },
      },
      async (_input, context) => {
        const result = await session.call(action, context?.signal);
        return {
          isError: result.success !== true,
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
  }
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 65536,
  });
  process.stdin.once('end', session.stop);
  process.once('SIGINT', () => {
    session.stop();
    void server.close();
  });
  process.once('SIGTERM', () => {
    session.stop();
    void server.close();
  });
  server.server.onclose = session.stop;
  await server.connect(transport);
}

main(process.argv.slice(2)).catch(() => {
  console.error('Private Ground MCP session unavailable');
  process.exitCode = 1;
});
