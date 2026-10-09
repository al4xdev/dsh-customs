import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';

const MAX_CONFIG_BYTES = 1024 * 1024;
const common = ['transport', 'serverName', 'enabled', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect'];
const fields = {
  stdio: new Set([...common, 'command', 'args', 'env', 'cwd']),
  'streamable-http': new Set([...common, 'url', 'headers']),
};
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

/** Only this exact project-local opt-in is read; never user-wide MCP files. */
export async function readProjectConfig(root) {
  const path = join(root, '.agents', 'mcp.json');
  let canonical;
  try { canonical = await realpath(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  // A project-local symlink may not smuggle in a home/global configuration.
  const local = relative(root, canonical);
  if (local === '..' || local.startsWith('../') || isAbsolute(local)) throw new Error('Project MCP config resolves outside the project');
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
