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
import { callsText, resultsText, toolsPrompt } from './protocol.mjs';
import { ClaudeSession } from './session.mjs';

const { default: z } = await import(resolveHost('@deepseek-ai/schemastery'));
const { LlmAdapter } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const { credentialRef } = await import(resolveHost('@deepseek-ai/dsh-credentials'));

export const name = 'alex-claude-bare-dsh';
export const inject = ['llm', 'credentials'];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Declared window, not the models' real 1M: dsh compacts at 80% of it, so ~200k, which
// keeps steps fast and leaves 50k of headroom for the reply and tool results.
const DEFAULT_CONTEXT_WINDOW = 250_000;
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
  // dsh owns compaction (it rewrites its history and the provider follows); the CLI
  // compacting on its own would rewrite Claude's transcript at another moment.
  autoCompactEnabled: false,
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
    contextWindow: z.natural().min(1).default(DEFAULT_CONTEXT_WINDOW),
  })).default(DEFAULT_MODELS),
  idleMinutes: z.natural().min(1).default(30).description('Stop a session process after this long without a step; the next step resumes it.'),
  maxProcesses: z.natural().min(1).default(6),
});

const stateRoot = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'claude-bare-dsh');

/**
 * Deterministic Claude session id for a dsh session, formatted as a UUIDv4. A new
 * generation is a new Claude conversation for the same dsh session (after dsh rewrote
 * its history); generation 0 keeps the original id.
 */
export function claudeSessionId(sessionId, generation = 0) {
  const seed = generation ? `claude-bare-dsh:${sessionId}#${generation}` : `claude-bare-dsh:${sessionId}`;
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Claude's own downscaling bounds (long edge 1568 px, ~1.15 MP): anything larger costs
// tokens for no gain. Bytes stay under the API's per-image cap after base64.
const IMAGE_LONG_EDGE = 1568;
const IMAGE_PIXELS = 1_150_000;
const IMAGE_BYTES = 3_500_000;
const MAX_IMAGES = 20;

/**
 * Text of content blocks. With `images`, each image is collected to be attached after the
 * text and marked where it was; without (older history, one-shot calls) a placeholder
 * names it, so a long conversation never re-sends every image it ever held.
 */
const textOf = (content, images) => (content ?? []).map(block => {
  if (block.type === 'text') return block.text;
  if (block.type === 'image') {
    const label = block.attachment?.name ? ` ${block.attachment.name}` : '';
    if (!images || block.offloaded || images.length >= MAX_IMAGES) return `[image${label}: not attached here]`;
    images.push(block);
    return `[image ${images.length}${label}: attached below]`;
  }
  return '';
}).filter(Boolean).join('\n');

/** Request size for one image: within Claude's useful bounds, never upscaled. */
export function imageTarget(ref) {
  const width = Number(ref?.width) || IMAGE_LONG_EDGE, height = Number(ref?.height) || IMAGE_LONG_EDGE;
  const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(width, height), Math.sqrt(IMAGE_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), maxBytes: IMAGE_BYTES };
}

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
function toolResults(messages, history, images) {
  const names = new Map(history.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => [block.id, block.name]) : []));
  return messages.filter(message => message.role === 'tool').map(message => ({
    name: names.get(message.toolCallId) ?? 'tool', text: textOf(message.content, images) || '(no output)', isError: message.isError === true }));
}

/** A whole conversation as one prompt, for a fresh process. */
export function transcript(messages, images, attachFrom = messages.length) {
  const out = [];
  for (let at = 0; at < messages.length; at++) {
    const message = messages[at];
    const collect = at >= attachFrom ? images : undefined;
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      // Consecutive results go together, as the next user message would carry them.
      const run = [];
      while (messages[at]?.role === 'tool') run.push(messages[at++]);
      at--;
      out.push(`[tool results]\n${resultsText(toolResults(run, messages, collect))}`);
      continue;
    }
    if (message.role === 'assistant') {
      const calls = callsText(message.content.filter(block => block.type === 'tool-call'));
      out.push(`[assistant]\n${[textOf(message.content, collect), calls].filter(Boolean).join('\n')}`);
      continue;
    }
    out.push(`[${message.role === 'developer' ? 'developer' : 'user'}]\n${textOf(message.content, collect)}`);
  }
  return out.join('\n\n');
}

/**
 * The next user line for a step: the results of the calls the last reply made, then any
 * new text. Plain text when there is nothing but user messages.
 */
export function newInput(tail, history = tail, images) {
  const relevant = tail.filter(message => message.role !== 'system');
  const results = toolResults(relevant, history, images);
  const others = relevant.filter(message => message.role !== 'tool');
  const text = others.every(message => message.role === 'user')
    ? others.map(message => textOf(message.content, images)).filter(Boolean).join('\n\n')
    : transcript(others, images, 0);
  return [results.length ? resultsText(results) : '', text].filter(Boolean).join('\n\n');
}

const sha = text => createHash('sha256').update(text).digest('hex');

/** The ids of a request's conversation, in order (system messages excluded). */
export const historyIds = messages => messages.filter(message => message.role !== 'system')
  .map((message, index) => message.id ?? `anonymous:${message.role}:${index}`);
const startsWith = (ids, prefix) => prefix.length <= ids.length && prefix.every((id, index) => ids[index] === id);
/** A compaction checkpoint dsh wrote in place of the span it condensed. */
const hasCheckpoint = messages => messages.some(message => message.source?.compactionId !== undefined);
const COMPACTION_ANCHOR_CHARS = 160;
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
    this.lineageFile = join(this.root, 'lineage.json');
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  providerInfo(provider) { return { id: provider, name: this.config.displayName }; }

  async listModels(provider) {
    return this.config.models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: ['text', 'image'] }));
  }

  async resolveModel(provider, model) {
    const known = this.config.models.find(entry => entry.id === model);
    return { provider, id: model, name: known?.name ?? model, inputModalities: ['text', 'image'],
      context: { contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      reasoning: { efforts: EFFORTS.map(id => ({ id, name: id })) } };
  }

  async *stream(options) {
    const token = await this.token();
    if (!token) {
      yield* errorFinish('MISSING_CREDENTIAL', `No Claude token: run \`claude setup-token\` and store it as the dsh credential ${this.config.tokenRef}.`);
      return;
    }
    // Only the agent loop's own steps belong to the session's Claude conversation. Side
    // requests carry the session id too but no tools: the TUI's session recap and btw
    // questions. Routed into the live process they joined Claude's transcript (and
    // respawned it without the tool list), so the next real turn believed it had none.
    const compaction = options.purpose === 'compaction' && options.sessionId;
    if (!compaction && (options.purpose || !options.sessionId || !options.tools?.length)) { yield* this.oneShot(options, token); return; }
    // One step at a time per session: a second caller waits instead of spawning a twin.
    const sessionId = String(options.sessionId);
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => mine);
    this.locks.set(sessionId, chain);
    await previous;
    try {
      if (compaction) yield* this.compact(options, token);
      else yield* this.turn(options, token, undefined);
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
    // Claude keeps its own transcript; dsh rewrites its history when it compacts (or on
    // an edit). History that no longer starts with what this Claude conversation was
    // built from gets a new conversation, else dsh compacts while Claude's context (and
    // the usage reported back) stays as large as before, and compaction loops.
    const ids = historyIds(options.messages);
    let lineage = this.lineage(sessionId);
    const rewritten = lineage.ids.length ? !startsWith(ids, lineage.ids) : !lineage.known && hasCheckpoint(options.messages);
    if (rewritten) {
      this.drop(sessionId);
      session = undefined;
      lineage = this.saveLineage(sessionId, { generation: lineage.generation + 1, ids: [] });
    }
    if (session && (session.spec !== spec || !session.alive || session.dirty)) {
      this.drop(sessionId);
      session = undefined;
    }
    const claudeId = claudeSessionId(sessionId, lineage.generation);
    const resume = retry === 'resume' || (retry !== 'fresh' && this.started().has(claudeId));
    const spawned = !session;
    if (!session) session = this.spawn(sessionId, options, token, spec, prompt, resume ? { resume: claudeId } : { fresh: claudeId });

    // A live or resumed process already holds everything up to the last assistant
    // message; a fresh one for an existing conversation gets all of it once.
    const priorAssistant = options.messages.some(message => message.role === 'assistant');
    const tail = afterLastAssistant(options.messages);
    // Images of this step's new messages are attached; older ones stay placeholders.
    const images = [];
    const text = spawned && !resume && priorAssistant
      ? transcript(options.messages, images, options.messages.length - tail.length)
      : newInput(tail, options.messages, images);
    session.sendUser(await this.userContent(text, images, options.signal));

    // The finish decides whether a refused session id is retried, so the usage chunk
    // before it is held back: a retried attempt must not leave a usage chunk behind.
    let held;
    for await (const chunk of session.step(options.signal, options.tools)) {
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
      if (chunk.type === 'finish' && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') this.saveLineage(sessionId, { generation: lineage.generation, ids });
      if (held) { yield held; held = undefined; }
      yield chunk;
    }
  }

  /**
   * dsh's summarization call: the span to condense (a prefix of the history) plus the
   * compaction instruction. When this session's Claude conversation was built from that
   * same history, the instruction goes to it, so the whole prefix is a cache read
   * instead of ~200k fresh input tokens; it names the last message of the span because
   * dsh keeps the messages after it verbatim. That conversation is then retired: dsh is
   * about to replace the span with the summary. Otherwise a one-shot call answers, with
   * the session's own system prompt so at least that prefix is cached.
   */
  async *compact(options, token) {
    const sessionId = String(options.sessionId);
    const instruction = options.messages.at(-1);
    const region = options.messages.slice(0, -1);
    const lineage = this.lineage(sessionId);
    const claudeId = claudeSessionId(sessionId, lineage.generation);
    const matches = lineage.ids.length > 0 && startsWith(lineage.ids, historyIds(region)) && instruction?.role === 'user'
      && (this.sessions.get(sessionId)?.alive || this.started().has(claudeId));
    if (!matches) { yield* this.oneShot(options, token, { sessionPrompt: true }); return; }
    const prompt = [systemText(options), toolsPrompt(options.tools), ENVIRONMENT_NOTE].filter(Boolean).join('\n\n');
    const spec = JSON.stringify({ model: options.model, effort: options.reasoningEffort ?? null, prompt: sha(prompt) });
    let session = this.sessions.get(sessionId);
    if (session && (session.spec !== spec || !session.alive || session.dirty)) { this.drop(sessionId); session = undefined; }
    if (!session) session = this.spawn(sessionId, options, token, spec, prompt, { resume: claudeId });
    const last = [...region].reverse().find(message => message.role !== 'system');
    const anchor = (last ? (textOf(last.content) || callsText(last.content?.filter?.(block => block.type === 'tool-call') ?? [])) : '').replace(/\s+/g, ' ').trim().slice(0, COMPACTION_ANCHOR_CHARS);
    const scope = anchor
      ? `Condense only the conversation up to and including the ${last.role} message that begins: «${anchor}». Everything after that message stays verbatim and must not be summarized.\n\n`
      : '';
    try {
      session.sendUser(scope + textOf(instruction.content));
      yield* session.step(options.signal, [], { textOnly: true });
    } finally {
      // The summary request now sits in this transcript; the next turn starts a new one.
      this.drop(sessionId);
      this.saveLineage(sessionId, { generation: lineage.generation + 1, ids: [] });
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

  /** The user line: text, then each collected image read through dsh's attachment store. */
  async userContent(text, images, signal) {
    if (!images.length) return text;
    const attachments = this.ctx.get?.('attachments');
    const parts = [{ type: 'text', text: text || '(see attached)' }];
    for (const [index, block] of images.entries()) {
      try {
        if (!attachments) throw new Error('no attachment service in this dsh');
        const image = await attachments.readImageRequest(block.attachment, imageTarget(block.attachment), signal);
        parts.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64') } });
      } catch (error) {
        parts.push({ type: 'text', text: `[image ${index + 1} could not be loaded: ${error?.message ?? error}]` });
      }
    }
    return parts;
  }

  /** dsh's prompt goes by file: one argv element is capped at 128 KiB and shows in `ps`. */
  promptFile(text) {
    const path = join(this.prompts, `${sha(text).slice(0, 32)}.txt`);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  }

  env(token) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: this.home, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTO_COMPACT: '1' };
    delete env.ANTHROPIC_API_KEY; // the token is the login; an inherited key would win over it
    return env;
  }

  /**
   * Titles, recaps and compaction: one answer, no session, no transcript. With
   * `sessionPrompt` the system prompt is the session's own (tools included), so its
   * prefix is shared with the session's cache entry.
   */
  async *oneShot(options, token, { sessionPrompt = false } = {}) {
    const system = sessionPrompt
      ? [systemText(options), toolsPrompt(options.tools), ENVIRONMENT_NOTE].filter(Boolean).join('\n\n')
      : systemText(options);
    const args = [...this.baseArgs(options), '--max-turns', '1', '--no-session-persistence',
      ...(system ? ['--append-system-prompt-file', this.promptFile(system)] : [])];
    const session = new ClaudeSession({ command: this.config.command, args, env: this.env(token), cwd: this.work, spec: 'one-shot' });
    // stdin is closed below, so an interrupt cannot be written: abort kills instead.
    const onAbort = () => session.kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      session.sendUser(newInput(options.messages));
      session.child.stdin.end();
      yield* session.step(options.signal, [], { textOnly: true });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      session.kill();
    }
  }

  async token() {
    try { return (await this.ctx.credentials.resolve(credentialRef(this.config.tokenRef)))?.value?.trim() || undefined; }
    catch { return undefined; }
  }

  /** What a dsh session's current Claude conversation was built from. */
  lineage(sessionId) {
    const entry = this.lineages()[sessionId];
    return entry ? { known: true, generation: entry.generation ?? 0, ids: entry.ids ?? [] } : { known: false, generation: 0, ids: [] };
  }
  saveLineage(sessionId, entry) {
    const all = this.lineages();
    all[sessionId] = { generation: entry.generation, ids: entry.ids };
    writeFileSync(this.lineageFile, JSON.stringify(all), { mode: 0o600 });
    return { known: true, ...all[sessionId] };
  }
  lineages() {
    try { return JSON.parse(readFileSync(this.lineageFile, 'utf8')); } catch { return {}; }
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
