import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, join } from 'node:path';

export const name = 'alex-music';
export const inject = ['commands'];
export const HELP = `Usage: /music <command>
play [<query> | --id VIDEO_ID] [--enqueue] (no query resumes)
pause | resume | stop | next | last | previous | status | queue
volume NUMBER (0–100) | seek SECONDS [--relative]
repeat off|one|all | shuffle | clear | shutdown
auth status | auth import-simpmusic [--force] [--auth-user 0–100]
Use quotes for queries containing spaces. No shell expansion is performed.`;
const SIMPLE = new Set(['pause', 'resume', 'stop', 'next', 'last', 'previous', 'status', 'queue', 'shuffle', 'clear', 'shutdown']);
const invalid = () => { throw new Error(HELP); };

// A small argv lexer, not a shell: substitutions and operators remain literal.
export function tokenize(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) invalid();
  const tokens = [];
  let token = '', quote = null, started = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length && (raw[i + 1] === quote || /[\\"' ]/.test(raw[i + 1]))) {
      token += raw[++i]; started = true;
    } else if (quote) {
      if (c === quote) quote = null;
      else token += c;
    } else if (c === '"' || c === "'") {
      quote = c; started = true;
    } else if (c === ' ') {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else { token += c; started = true; }
  }
  if (quote) invalid();
  if (started) tokens.push(token);
  if (tokens.length > 64) invalid();
  return tokens;
}

export function parseInput(raw) {
  const [command, ...rest] = tokenize(raw);
  if (!command || command === 'help' || command === '--help') {
    if (rest.length) invalid();
    return null;
  }
  if (SIMPLE.has(command)) { if (rest.length) invalid(); return [command === 'last' ? 'previous' : command]; }
  if (command === 'auth') {
    if (rest[0] === 'status' && rest.length === 1) return ['auth', 'status'];
    if (rest[0] !== 'import-simpmusic') invalid();
    let force = false, authUser;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--force' && !force) force = true;
      else if (rest[i] === '--auth-user' && authUser === undefined && /^\d{1,3}$/.test(rest[i + 1] ?? '')) {
        authUser = Number(rest[++i]);
        if (authUser > 100) invalid();
      } else invalid();
    }
    return ['auth', 'import-simpmusic', ...(force ? ['--force'] : []), ...(authUser !== undefined ? ['--auth-user', String(authUser)] : [])];
  }
  if (command === 'repeat') {
    if (rest.length !== 1 || !['off', 'one', 'all'].includes(rest[0])) invalid();
    return [command, rest[0]];
  }
  if (command === 'volume' || command === 'seek') {
    const relative = command === 'seek' && rest[1] === '--relative';
    if (rest.length !== (relative ? 2 : 1) || !/^-?\d+(?:\.\d+)?$/.test(rest[0] ?? '')) invalid();
    const value = Number(rest[0]);
    if (!Number.isFinite(value) || Math.abs(value) > (command === 'volume' ? 100 : 86400) || (!relative && value < 0)) invalid();
    return [command, String(value), ...(relative ? ['--relative'] : [])];
  }
  if (command === 'play') {
    const enqueue = rest.includes('--enqueue');
    if (rest.filter(t => t === '--enqueue').length > 1) invalid();
    const args = rest.filter(t => t !== '--enqueue');
    if (args[0] === '--id') {
      if (args.length !== 2 || !/^[A-Za-z0-9_-]{11}$/.test(args[1])) invalid();
      return ['play', '--id', args[1], ...(enqueue ? ['--enqueue'] : [])];
    }
    if (!args.length) { if (enqueue) invalid(); return ['play']; }
    const query = args.join(' ');
    if (!query || query.length > 500 || args.some(t => t.startsWith('-'))) invalid();
    return ['play', ...(enqueue ? ['--enqueue'] : []), query];
  }
  invalid();
}

export function resolveConfig(config = {}, env = process.env, home = homedir()) {
  const project = config.projectPath ?? env.KIOSKTUNES_PROJECT ?? env.SIMP_MCP_PROJECT ?? join(home, 'git/my/kiosktunes-mcp');
  const uv = config.uvBinary ?? env.KIOSKTUNES_UV ?? env.SIMP_MCP_UV ?? 'uv';
  if (typeof project !== 'string' || !isAbsolute(project) || project.length > 4096 || /[\x00-\x1f\x7f]/.test(project)) throw new Error('Music projectPath / SIMP_MCP_PROJECT must be an absolute path.');
  if (typeof uv !== 'string' || (uv !== 'uv' && !isAbsolute(uv)) || uv.length > 4096 || /[\x00-\x1f\x7f]/.test(uv)) throw new Error('Music uvBinary / SIMP_MCP_UV must be uv or an absolute executable path.');
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxOutputBytes = config.maxOutputBytes ?? 32_768;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('Music timeoutMs must be 100–120000.');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > 65_536) throw new Error('Music maxOutputBytes must be 256–65536.');
  return { project, uv, timeoutMs, maxOutputBytes };
}

function safeOutput(text) {
  // Defense in depth only: the CLI must never emit credentials on stdout.
  return text.replace(/[^\n]*(?:cookie|authorization|bearer|oauth|access[_ -]?token|refresh[_ -]?token|password|secret)[^\n]*/gi, '[Sensitive output omitted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}

export function runMusic(args, settings, { signal, spawnProcess = spawn } = {}) {
  if (signal?.aborted) return Promise.resolve({ kind: 'error', text: 'Music command canceled.' });
  return new Promise(resolve => {
    let child, timer, killTimer, bytes = 0, output = '', failure, settled = false;
    const decoder = new StringDecoder('utf8');
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = text => {
      if (failure || settled) return;
      failure = text;
      child?.kill('SIGTERM');
      // Bound the handler even if a descendant keeps the stdio pipes open.
      killTimer = setTimeout(() => { child?.kill('SIGKILL'); finish({ kind: 'error', text: failure }); }, 500);
    };
    const abort = () => stop('Music command canceled.');
    try {
      child = spawnProcess(settings.uv, ['run', '--directory', settings.project, 'kiosktunes-mcp', 'music', ...args], {
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch { finish({ kind: 'error', text: 'Could not start uv. Check the configured executable and project installation.' }); return; }
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > settings.maxOutputBytes) stop('Music output exceeded its limit.');
      else if (!failure) output += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    // Never retain stderr: uv and third-party failures may contain credentials.
    child.stderr.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > settings.maxOutputBytes) stop('Music output exceeded its limit.');
    });
    child.once('error', () => finish({ kind: 'error', text: 'Could not start uv. Check the configured executable and project installation.' }));
    child.once('close', code => {
      clearTimeout(killTimer);
      finish(failure ? { kind: 'error', text: failure } : code === 0
        ? { kind: 'success', text: safeOutput(output + decoder.end()) || 'Music command completed.' }
        : { kind: 'error', text: 'Music command failed. Check the project installation, authentication, and player availability.' });
    });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('Music command timed out. Its player-side effects may already have occurred.'), settings.timeoutMs);
    if (signal?.aborted) abort();
  });
}

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const pending = new Set();
  let disposed = false;
  ctx.commands.register({
    definitionId: name, name: 'music', description: 'Control the standalone SimpMusic player (no model request)',
    // Even rejected input may accidentally contain credentials; never persist it.
    recordInput: false,
    input: { hint: '<command> [arguments]', attachments: false },
    async handler({ rawInput = '', signal }) {
      let args;
      try { args = parseInput(rawInput); } catch { return { kind: 'error', text: HELP }; }
      if (!args) return { kind: 'success', text: HELP };
      if (disposed) return { kind: 'error', text: 'Music plugin is unloaded.' };
      if (pending.size >= 4) return { kind: 'error', text: 'Too many music commands are running. Try again shortly.' };
      const controller = new AbortController();
      pending.add(controller);
      try { return await runMusic(args, settings, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal }); }
      finally { pending.delete(controller); }
    },
  });
  ctx.effect(() => () => { disposed = true; for (const controller of pending) controller.abort(); });
}
