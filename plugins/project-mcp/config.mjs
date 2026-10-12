import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';

const MAX_CONFIG_BYTES = 1024 * 1024;
const common = ['transport', 'serverName', 'enabled', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect'];
const fields = {
  stdio: new Set([...common, 'command', 'args', 'env', 'cwd']),
  'streamable-http': new Set([...common, 'url', 'headers']),
};
// Fields accepted only on a `builtin: true` server entry; everything else is
// handed to the native stdio/streamable-http schema unchanged below.
const builtinFields = new Set(['builtin', 'toolsDir', 'timeoutMs', 'enabled', 'failOnStartupError']);
const DEFAULT_BUILTIN_TIMEOUT_MS = 30_000;
// The static .mjs server launched for `builtin` servers.
const BUILTIN_SERVER = fileURLToPath(new URL('./server/generic.mjs', import.meta.url));
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

/** Find the nearest canonical Git worktree marker, including worktree gitfiles. */
export async function projectRoot(cwd) {
  if (cwd === undefined) return null;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Session cwd must be an absolute path');
  let current = await realpath(cwd);
  if (!(await stat(current)).isDirectory()) throw new Error('Session cwd must be a directory');
  for (;;) {
    const marker = join(current, '.git');
    let info;
    try { info = await stat(marker); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      let gitdir = marker;
      if (info.isFile()) {
        const text = await boundedText(marker, 16 * 1024);
        const match = /^gitdir: (.+)\r?\n?$/.exec(text);
        if (!match) throw new Error('Invalid project .git file');
        gitdir = resolve(current, match[1]);
      } else if (!info.isDirectory()) throw new Error('Invalid project .git marker');
      if (!(await stat(join(gitdir, 'HEAD'))).isFile()) throw new Error('Invalid project Git metadata');
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function boundedText(path, limit = MAX_CONFIG_BYTES) {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Project config must be a regular file');
    // Read at most limit + 1 even if a file grows after the metadata check.
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit) throw new Error('Project config exceeds size limit');
    return buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}

/**
 * Return true when `target` resolves strictly inside `base`. Both are
 * real-pathed, so a symlinked `target` cannot smuggle out of `base`. Single
 * source of truth for the `.agents` escape guard, shared with
 * `server/generic.mjs`.
 */
export async function isInsideDirectory(base, target) {
  const b = await realpath(base);
  const t = await realpath(target);
  const rel = relative(b, t);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

/** Only this exact project-local opt-in is read; never user-wide MCP files. */
export async function readProjectConfig(root) {
  const path = join(root, '.agents', 'mcp.json');
  let canonical;
  try { canonical = await realpath(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  // A project-local symlink may not smuggle in a home/global configuration.
  if (!(await isInsideDirectory(root, canonical))) throw new Error('Project MCP config resolves outside the project');
  return JSON.parse(await boundedText(canonical));
}

export async function serverConfigs(document, root, nativeConfig) {
  object(document, 'MCP config');
  for (const key of Object.keys(document)) if (key !== 'mcpServers') throw new Error(`Unknown MCP config field: ${key}`);
  object(document.mcpServers, 'mcpServers');
  const configs = [];
  for (const [serverName, raw] of Object.entries(document.mcpServers)) {
    object(raw, `MCP server ${serverName}`);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`MCP server ${serverName}: enabled must be boolean`);
    // Disabled legacy entries cannot execute, even if their old policy vocabulary is unsupported.
    if (raw.enabled === false) continue;
    // `builtin` servers are not transports: they launch the static .mjs server
    // (server/generic.mjs) and are handled before the native stdio/streamable-http
    // machinery below.
    if (raw.builtin === true) {
      for (const key of Object.keys(raw)) if (!builtinFields.has(key)) throw new Error(`MCP server ${serverName}: unsupported field ${key} for a builtin server`);
      if (raw.toolsDir !== undefined && typeof raw.toolsDir !== 'string') throw new Error(`MCP server ${serverName}: toolsDir must be a string`);
      if (raw.timeoutMs !== undefined && (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs <= 0 || raw.timeoutMs > 2147483647)) throw new Error(`MCP server ${serverName}: timeoutMs must be a positive integer (ms), at most 2147483647`);
      const dir = await realpath(resolve(root, raw.toolsDir ?? '.agents/tools'));
      if (!(await isInsideDirectory(root, dir))) throw new Error(`MCP server ${serverName}: toolsDir resolves outside the project`);
      if (!(await stat(dir)).isDirectory()) throw new Error(`MCP server ${serverName}: toolsDir must be a directory`);
      const timeoutMs = raw.timeoutMs ?? DEFAULT_BUILTIN_TIMEOUT_MS;
      // Align the native client's deadline and the handler's cooperative signal.
      const input = {
        transport: 'stdio',
        serverName,
        command: process.execPath,
        args: [BUILTIN_SERVER, '--project-root', root, '--tools-dir', dir, '--server-name', serverName, '--tool-call-timeout-ms', String(timeoutMs)],
        env: {},
        cwd: root,
        reconnect: { enabled: false },
        failOnStartupError: raw.failOnStartupError ?? true,
        toolCallTimeoutMs: timeoutMs
      };
      const result = nativeConfig['~standard'].validate(input);
      if (result && typeof result.then === 'function') throw new Error('Async native MCP config validation is unsupported');
      if (result.issues) throw new Error(`MCP server ${serverName}: invalid native configuration (${result.issues.map(issue => issue.path?.join('.') || 'config').join(', ')})`);
      configs.push(result.value);
      continue;
    }
    const transport = raw.transport ?? (raw.url === undefined ? 'stdio' : 'streamable-http');
    const allowed = fields[transport];
    if (!allowed) throw new Error(`MCP server ${serverName}: unsupported transport`);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`MCP server ${serverName}: unsupported field ${key}; permission policies cannot be silently relaxed`);
    if (raw.serverName !== undefined && raw.serverName !== serverName) throw new Error(`MCP server ${serverName}: serverName must match its config key`);
    const { enabled, ...native } = raw;
    const input = { ...native, transport, serverName, failOnStartupError: raw.failOnStartupError ?? true };
    if (transport === 'stdio') {
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error(`MCP server ${serverName}: cwd must be a string`);
      input.cwd = await realpath(resolve(root, raw.cwd || '.'));
      if (!(await stat(input.cwd)).isDirectory()) throw new Error(`MCP server ${serverName}: cwd must be a directory`);
    }
    const result = nativeConfig['~standard'].validate(input);
    if (result && typeof result.then === 'function') throw new Error('Async native MCP config validation is unsupported');
    if (result.issues) throw new Error(`MCP server ${serverName}: invalid native configuration (${result.issues.map(issue => issue.path?.join('.') || 'config').join(', ')})`);
    configs.push(result.value);
  }
  return configs;
}
