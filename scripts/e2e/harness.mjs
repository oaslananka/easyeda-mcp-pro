import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };

export function startStdioMcpServer(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const child = spawn('node', options.args ?? ['dist/index.js'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRANSPORT: 'stdio',
      LOG_LEVEL: 'silent',
      TOOL_PROFILE: 'full',
      BRIDGE_RECONNECT_MAX_ATTEMPTS: '0',
      BRIDGE_RECONNECT_INTERVAL_MS: '1000',
      BRIDGE_TIMEOUT_MS: '30000',
      ...(options.env ?? {}),
    },
  });

  let reqId = 0;
  let exited = false;
  let exitCode = null;
  let stdoutLog = '';
  const stderrLog = [];
  const pending = new Map();

  const rejectPending = (error) => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };

  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code ?? signal ?? null;
    rejectPending(new Error(`MCP server exited before response: ${exitCode ?? 'unknown'}`));
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    stdoutLog += `${line}\n`;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed.id || !pending.has(parsed.id)) return;
    const entry = pending.get(parsed.id);
    pending.delete(parsed.id);
    clearTimeout(entry.timer);
    if (parsed.error) entry.reject(new Error(parsed.error.message));
    else entry.resolve(parsed.result);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) stderrLog.push(text);
  });

  const shutdown = (label) => {
    rejectPending(new Error(label ? `MCP server shutdown: ${label}` : 'MCP server shutdown'));
    try {
      child.stdin.end();
    } catch {}
    if (!exited) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    if (label) console.log(`  🔌 Shutdown: ${label}`);
  };

  const handleExit = () => shutdown('process exit');
  const handleSignal = (signal) => {
    shutdown(signal);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('exit', handleExit);
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const detach = () => {
    process.removeListener('exit', handleExit);
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  };

  const mcpCall = (method, params = {}, callTimeoutMs = timeoutMs) =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error(`MCP server already exited: ${exitCode ?? 'unknown'}`));
        return;
      }
      const id = ++reqId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method} (${callTimeoutMs}ms)`));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notifyInitialized = () => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  };

  const toolCall = async (name, args = {}) => {
    const result = await mcpCall('tools/call', { name, arguments: args });
    const content = result.content || [];
    const text = content.map((c) => c.text || c?.toString?.() || JSON.stringify(c)).join('\n');
    return { result, text, isError: result.isError === true };
  };

  return {
    child,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    stderrLog,
    mcpCall,
    toolCall,
    notifyInitialized,
    shutdown,
    detach,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get stdoutLog() {
      return stdoutLog;
    },
  };
}

export function spawnTrackedProcess(command, args = [], options = {}) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  });

  let exited = false;
  let exitCode = null;
  let stdoutLog = '';
  let stderrLog = '';

  child.stdout?.on('data', (chunk) => {
    stdoutLog += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderrLog += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code ?? signal ?? null;
  });

  const shutdown = (label) => {
    try {
      child.stdin?.end();
    } catch {}
    if (!exited) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    if (label) console.log(`  🔌 Shutdown: ${label}`);
  };

  const handleExit = () => shutdown('process exit');
  const handleSignal = (signal) => {
    shutdown(signal);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('exit', handleExit);
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  return {
    child,
    shutdown,
    detach() {
      process.removeListener('exit', handleExit);
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
    },
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    get stdoutLog() {
      return stdoutLog;
    },
    get stderrLog() {
      return stderrLog;
    },
  };
}
