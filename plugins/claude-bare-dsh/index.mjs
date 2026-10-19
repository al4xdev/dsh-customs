// dsh provider backed by the official Claude Code CLI, as close to a bare model as the
// CLI allows with a subscription login:
// - no tools of its own at all (`--tools ""`, no MCP servers): dsh's tools reach Claude
//   through the text protocol of protocol.mjs and run in dsh's own loop;
// - no skills, setting sources, built-in context plugins or auto-memory;
// - an empty config dir of its own (no user CLAUDE.md, settings, hooks, agents or
//   plugins) and an empty working dir (no project CLAUDE.md);
// - login by `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, read through dsh's
//   credential store, so the interactive `~/.claude` login is never shared or rotated.
// Claude Code's own system prompt stays (with a subscription login only appending is
// supported; `--bare`/`--system-prompt` need an API key); dsh's prompt is appended.
// This plugin makes no network request itself: only the `claude` binary does.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHost } from '../common.mjs';
import { callText, resultsText, toolsPrompt } from './protocol.mjs';
import { ClaudeSession } from './session.mjs';

const { default: z } = await import(resolveHost('@deepseek-ai/schemastery'));
const { LlmAdapter } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const { credentialRef } = await import(resolveHost('@deepseek-ai/dsh-credentials'));

export const name = 'alex-claude-bare-dsh';
export const inject = ['llm', 'credentials'];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
];
// Claude Code's own prompt describes the environment (cwd, platform, git) of the empty
// dir the CLI runs in.
const ENVIRONMENT_NOTE = "The working directory, platform and git facts in Claude Code's environment section above describe an empty placeholder directory; the dsh context in this conversation is authoritative.";

// Built-in plugins that add context (AGENTS.md loading, plugin-authoring guidance) and
// auto-memory, verified against the 2.1.303 init frame. The telemetry plugin adds none.
const SESSION_SETTINGS = {
  autoMemoryEnabled: false,
  enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false },
};

export const Config = z.object({
  provider: z.string().default('claude-bare-dsh').description('Provider route id in dsh.'),
  displayName: z.string().default('Claude (bare)'),
  command: z.string().default('claude').description('Claude Code executable.'),
  tokenRef: z.string().role('credential-ref').default('CLAUDE_CODE_OAUTH_TOKEN')
    .description('dsh credential holding the token printed by `claude setup-token`.'),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    contextWindow: z.natural().min(1).default(200000),
  })).default(DEFAULT_MODELS),
  idleMinutes: z.natural().min(1).default(30).description('Stop a session process after this long without a step; the next step resumes it.'),
  maxProcesses: z.natural().min(1).default(6),
});

const stateRoot = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'claude-bare-dsh');

/** Deterministic Claude session id for a dsh session, formatted as a UUIDv4. */
export function claudeSessionId(sessionId) {
  const hex = createHash('sha256').update(`claude-bare-dsh:${sessionId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const textOf = content => (content ?? []).map(block => {
  if (block.type === 'text') return block.text;
  if (block.type === 'image') return `[image${block.attachment?.name ? ` ${block.attachment.name}` : ''} omitted: this provider sends text only]`;
  return '';
}).filter(Boolean).join('\n');

/** The messages after the last assistant message: what this step adds. */
export function afterLastAssistant(messages) {
  let at = -1;
  messages.forEach((message, index) => { if (message.role === 'assistant') at = index; });
  return messages.slice(at + 1);
}

/** dsh's system prompt: leading system messages of a loop request plus `options.system`. */
export function systemText(options) {
  return [options.system, ...options.messages.filter(message => message.role === 'system').map(message => textOf(message.content))]
    .filter(Boolean).join('\n\n');
}

/** Tool results of `messages`, named after the assistant calls in `history` they answer. */
function toolResults(messages, history) {
  const names = new Map(history.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => [block.id, block.name]) : []));
  return messages.filter(message => message.role === 'tool').map(message => ({
    name: names.get(message.toolCallId) ?? 'tool', text: textOf(message.content) || '(no output)', isError: message.isError === true }));
}

/** A whole conversation as one prompt, for a fresh process. */
export function transcript(messages) {
  const out = [];
  for (let at = 0; at < messages.length; at++) {
    const message = messages[at];
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      // Consecutive results go together, as the next user message would carry them.
      const run = [];
      while (messages[at]?.role === 'tool') run.push(messages[at++]);
      at--;
      out.push(`[tool results]\n${resultsText(toolResults(run, messages))}`);
      continue;
    }
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool-call').map(block => callText(block.name, block.arguments));
      out.push(`[assistant]\n${[textOf(message.content), ...calls].filter(Boolean).join('\n')}`);
      continue;
    }
    out.push(`[${message.role === 'developer' ? 'developer' : 'user'}]\n${textOf(message.content)}`);
  }
  return out.join('\n\n');
}

/**
 * The next user line for a step: the results of the calls the last reply made, then any
 * new text. Plain text when there is nothing but user messages.
 */
export function newInput(tail, history = tail) {
  const relevant = tail.filter(message => message.role !== 'system');
  const results = toolResults(relevant, history);
  const others = relevant.filter(message => message.role !== 'tool');
  const text = others.every(message => message.role === 'user')
    ? others.map(message => textOf(message.content)).filter(Boolean).join('\n\n')
    : transcript(others);
  return [results.length ? resultsText(results) : '', text].filter(Boolean).join('\n\n');
}

const sha = text => createHash('sha256').update(text).digest('hex');
const RETRY_FRESH = /no conversation found/i;
const RETRY_RESUME = /already in use/i;

class ClaudeCliAdapter extends LlmAdapter {
  constructor(ctx, config) {
    super();
    this.ctx = ctx;
    this.config = config;
    this.sessions = new Map(); // dsh session id -> ClaudeSession
    this.locks = new Map();    // dsh session id -> tail of its step chain
    this.root = stateRoot();
    this.home = join(this.root, 'claude-home');
    this.work = join(this.root, 'work');
    this.prompts = join(this.root, 'prompts');
    for (const dir of [this.root, this.home, this.work, this.prompts]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.startedFile = join(this.root, 'started.json');
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  providerInfo(provider) { return { id: provider, name: this.config.displayName }; }

  async listModels(provider) {
    return this.config.models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: ['text'] }));
  }

  async resolveModel(provider, model) {
    const known = this.config.models.find(entry => entry.id === model);
    return { provider, id: model, name: known?.name ?? model, inputModalities: ['text'],
      context: { contextWindow: known?.contextWindow ?? 200000 },
      reasoning: { efforts: EFFORTS.map(id => ({ id, name: id })) } };
  }

  async *stream(options) {
    const token = await this.token();
    if (!token) {
      yield* errorFinish('MISSING_CREDENTIAL', `No Claude token: run \`claude setup-token\` and store it as the dsh credential ${this.config.tokenRef}.`);
      return;
    }
    if (options.purpose || !options.sessionId) { yield* this.oneShot(options, token); return; }
    // One step at a time per session: a second caller waits instead of spawning a twin.
    const sessionId = String(options.sessionId);
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => mine);
    this.locks.set(sessionId, chain);
    await previous;
    try {
      yield* this.turn(options, token, undefined);
    } catch (error) {
      this.drop(sessionId);
      yield* errorFinish('PROVIDER_ERROR', `claude-bare-dsh: ${error?.message ?? error}`);
    } finally {
      release();
      if (this.locks.get(sessionId) === chain) this.locks.delete(sessionId);
    }
  }

  /** @param retry undefined, or 'fresh' / 'resume' after a refused session id */
  async *turn(options, token, retry) {
    const sessionId = String(options.sessionId);
    const prompt = [systemText(options), toolsPrompt(options.tools), ENVIRONMENT_NOTE].filter(Boolean).join('\n\n');
    // The prompt (tools included) is fixed for a process: a change respawns it on the
    // same Claude session.
    const spec = JSON.stringify({ model: options.model, effort: options.reasoningEffort ?? null, prompt: sha(prompt) });
    let session = this.sessions.get(sessionId);
    if (session && (session.spec !== spec || !session.alive || session.dirty)) {
      this.drop(sessionId);
      session = undefined;
    }
    const claudeId = claudeSessionId(sessionId);
    const resume = retry === 'resume' || (retry !== 'fresh' && this.started().has(claudeId));
    const spawned = !session;
    if (!session) session = this.spawn(sessionId, options, token, spec, prompt, resume ? { resume: claudeId } : { fresh: claudeId });

    // A live or resumed process already holds everything up to the last assistant
    // message; a fresh one for an existing conversation gets all of it once.
    const priorAssistant = options.messages.some(message => message.role === 'assistant');
    const tail = afterLastAssistant(options.messages);
    session.sendUser(spawned && !resume && priorAssistant ? transcript(options.messages) : newInput(tail, options.messages));

    // The finish decides whether a refused session id is retried, so the usage chunk
    // before it is held back: a retried attempt must not leave a usage chunk behind.
    let held;
    for await (const chunk of session.step(options.signal)) {
      if (chunk.type === 'usage') { held = chunk; continue; }
      if (chunk.type === 'finish' && chunk.reason.kind === 'error' && !retry) {
        const message = chunk.reason.failure.message;
        const again = resume && RETRY_FRESH.test(message) ? 'fresh' : !resume && RETRY_RESUME.test(message) ? 'resume' : undefined;
        if (again) {
          if (again === 'fresh') this.forget(claudeId); else this.markStarted(claudeId);
          this.drop(sessionId);
          yield* this.turn(options, token, again);
          return;
        }
      }
      if (held) { yield held; held = undefined; }
      yield chunk;
    }
  }

  spawn(sessionId, options, token, spec, prompt, mode) {
    while (this.sessions.size >= this.config.maxProcesses) {
      const idle = [...this.sessions.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) break;
      this.drop(idle[0]);
    }
    const args = [...this.baseArgs(options), '--append-system-prompt-file', this.promptFile(prompt),
      ...(mode.resume ? ['--resume', mode.resume] : ['--session-id', mode.fresh])];
    const claudeId = mode.resume ?? mode.fresh;
    const session = new ClaudeSession({ command: this.config.command, args, env: this.env(token), cwd: this.work, spec,
      onInit: () => this.markStarted(claudeId) });
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Flags shared by every call: stream-json both ways, and Claude Code stripped down. */
  baseArgs(options) {
    return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'user', '--settings', JSON.stringify(SESSION_SETTINGS),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.reasoningEffort ? ['--effort', String(options.reasoningEffort)] : [])];
  }

  /** dsh's prompt goes by file: one argv element is capped at 128 KiB and shows in `ps`. */
  promptFile(text) {
    const path = join(this.prompts, `${sha(text).slice(0, 32)}.txt`);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  }

  env(token) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: this.home, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    delete env.ANTHROPIC_API_KEY; // the token is the login; an inherited key would win over it
    return env;
  }

  /** Titles and compaction: one answer, no tools, no session, no transcript. */
  async *oneShot(options, token) {
    const system = systemText(options);
    const args = [...this.baseArgs(options), '--max-turns', '1', '--no-session-persistence',
      ...(system ? ['--append-system-prompt-file', this.promptFile(system)] : [])];
    const session = new ClaudeSession({ command: this.config.command, args, env: this.env(token), cwd: this.work, spec: 'one-shot' });
    // stdin is closed below, so an interrupt cannot be written: abort kills instead.
    const onAbort = () => session.kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      session.sendUser(newInput(options.messages));
      session.child.stdin.end();
      yield* session.step(options.signal);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      session.kill();
    }
  }

  async token() {
    try { return (await this.ctx.credentials.resolve(credentialRef(this.config.tokenRef)))?.value?.trim() || undefined; }
    catch { return undefined; }
  }

  started() {
    try { return new Set(JSON.parse(readFileSync(this.startedFile, 'utf8'))); } catch { return new Set(); }
  }
  markStarted(id) {
    const ids = this.started();
    if (ids.has(id)) return;
    ids.add(id);
    writeFileSync(this.startedFile, JSON.stringify([...ids]), { mode: 0o600 });
  }
  forget(id) {
    const ids = this.started();
    if (ids.delete(id)) writeFileSync(this.startedFile, JSON.stringify([...ids]), { mode: 0o600 });
  }

  drop(sessionId) {
    this.sessions.get(sessionId)?.kill();
    this.sessions.delete(sessionId);
  }

  sweep() {
    const cutoff = Date.now() - this.config.idleMinutes * 60_000;
    for (const [id, session] of this.sessions) if (!session.busy && session.lastUsed < cutoff) this.drop(id);
  }

  dispose() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }
}

function* errorFinish(code, message) {
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'error', failure: { code, message } } };
}

export function apply(ctx, config) {
  const adapter = new ClaudeCliAdapter(ctx, config);
  ctx.llm.registerAdapter([config.provider], adapter);
  ctx.effect(() => () => adapter.dispose(), 'claude-bare-dsh: stop session processes');
}

export { ClaudeCliAdapter };
