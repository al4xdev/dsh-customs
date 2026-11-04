// One long-lived `claude -p` process per dsh session, driven over stream-json, and the
// translation of its output into dsh stream chunks for one dsh step at a time.
//
// dsh's tools are an in-process MCP server of the process (mcp.mjs). Claude calls them
// natively; the step finishes with `tool-calls` when the reply that made the calls ends,
// while the CLI turn stays open with each `tools/call` parked until the next step answers
// it with dsh's result. The turn ends on its own `result`, and only a real abort
// interrupts it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SERVER, definitions, dshName } from './mcp.mjs';

const INTERRUPT_GRACE_MS = 5000;
const STDERR_TAIL = 2000;
const INIT_ID = 'dsh-initialize';
const TOOL_USE_ID = 'claudecode/toolUseId';
const CANCELLED = { content: [{ type: 'text', text: 'Cancelled: the turn ended before this call ran.' }], isError: true };
const UNAVAILABLE = { content: [{ type: 'text', text: 'Tools are unavailable for this request.' }], isError: true };

/** Minimal async queue: producers push, one consumer awaits. */
class Queue {
  #items = [];
  #waiters = [];
  push(item) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item); else this.#items.push(item);
  }
  next() {
    if (this.#items.length) return Promise.resolve(this.#items.shift());
    return new Promise(resolve => this.#waiters.push(resolve));
  }
}

export class ClaudeSession {
  constructor({ command, args, env, cwd, spec, tools, onInit }) {
    this.spec = spec;
    this.tools = tools ?? [];
    this.mcp = this.tools.length ? definitions(this.tools) : undefined;
    this.queue = new Queue();
    /** Message ids already streamed as partials; a later whole `assistant` frame is an echo. */
    this.streamed = new Set();
    this.busy = false;
    /** A step left early (its consumer stopped reading): queued frames belong to no one. */
    this.dirty = false;
    this.alive = true;
    this.stderr = '';
    this.lastUsed = Date.now();
    /** User lines wait until the CLI has registered the MCP server. */
    this.ready = !this.mcp;
    this.held = [];
    /** The CLI turn waits on calls dsh is running. */
    this.parked = false;
    /** tool_use ids handed to dsh in this turn and not answered yet. */
    this.owed = new Set();
    /** tool_use id -> answer of a parked `tools/call`. */
    this.waiting = new Map();
    /** tool_use id -> dsh's result that arrived before its `tools/call`. */
    this.results = new Map();
    /** A text-only step: any call is refused at once. */
    this.toolsOff = false;
    /** dsh message ids this process has already been sent. */
    this.delivered = new Set();
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => { this.stderr += String(error.message); });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-STDERR_TAIL); });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { this.stderr = (this.stderr + line + '\n').slice(-STDERR_TAIL); return; }
      // Control traffic is answered here: a `tools/call` may arrive between steps.
      if (event.type === 'control_request') { this.#control(event); return; }
      if (event.type === 'control_cancel_request') { this.#cancel(event.request_id); return; }
      if (event.type === 'control_response') { if (event.response?.request_id === INIT_ID) this.#initialized(event.response); return; }
      // The CLI has created (or reopened) its transcript once it reports init.
      if (event.type === 'system' && event.subtype === 'init') onInit?.();
      this.queue.push({ kind: 'event', event });
    });
    this.child.on('close', code => {
      this.alive = false;
      this.queue.push({ kind: 'exit', code });
    });
    if (this.mcp) this.write({ type: 'control_request', request_id: INIT_ID, request: { subtype: 'initialize', sdkMcpServers: [SERVER] } });
  }

  write(message) {
    if (!this.alive || this.child.stdin.writableEnded) return false;
    if (!this.ready && message.type === 'user') { this.held.push(message); return true; }
    this.child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }

  /** One user line: plain text, or text and image blocks (Anthropic content shape). With
   *  `next` it joins the open turn after the results being answered. */
  sendUser(content, { next = false } = {}) {
    // The CLI refuses an empty text block.
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content || '(continue)' }] : content;
    this.write({ type: 'user', session_id: '', message: { role: 'user', content: blocks }, parent_tool_use_id: null, ...(next ? { priority: 'next' } : {}) });
  }

  /** dsh's result for a call: answers its parked `tools/call`, or waits for it. */
  answer(id, result) {
    this.owed.delete(id);
    const parked = this.waiting.get(id);
    if (!parked) { this.results.set(id, result); return; }
    this.waiting.delete(id);
    parked.reply(result);
  }

  interrupt() {
    return this.write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } });
  }

  kill() {
    if (!this.alive) return;
    this.child.kill('SIGTERM');
    setTimeout(() => { if (this.alive) this.child.kill('SIGKILL'); }, INTERRUPT_GRACE_MS).unref();
  }

  #respond(requestId, response, error) {
    this.write({ type: 'control_response', response: error === undefined
      ? { subtype: 'success', request_id: requestId, response }
      : { subtype: 'error', request_id: requestId, error } });
  }

  #initialized(response) {
    if (response.subtype !== 'success') {
      this.stderr += `registering the dsh MCP server failed: ${response.error ?? 'unknown error'}`;
      this.kill();
      return;
    }
    this.ready = true;
    for (const message of this.held.splice(0)) this.write(message);
  }

  #control(event) {
    const request = event.request ?? {};
    if (request.subtype !== 'mcp_message' || request.server_name !== SERVER || !this.mcp) {
      // Nothing in this process can grant a permission or run a hook; refuse whatever asks.
      this.#respond(event.request_id, undefined, 'not supported');
      return;
    }
    const message = request.message ?? {};
    // Notifications get the empty acknowledgement the Agent SDK sends.
    if (message.id === undefined) { this.#respond(event.request_id, { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } }); return; }
    const reply = result => this.#respond(event.request_id, { mcp_response: { jsonrpc: '2.0', id: message.id, result } });
    if (message.method === 'initialize') reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '1.0.0' } });
    else if (message.method === 'tools/list') reply({ tools: this.mcp });
    else if (message.method === 'tools/call') this.#call(event.request_id, message.params, reply);
    else this.#respond(event.request_id, { mcp_response: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } } });
  }

  #call(requestId, params, reply) {
    const id = params?._meta?.[TOOL_USE_ID];
    if (this.toolsOff || !id) { reply(UNAVAILABLE); return; }
    const ready = this.results.get(id);
    if (ready) { this.results.delete(id); reply(ready); return; }
    this.waiting.set(id, { requestId, reply });
  }

  #cancel(requestId) {
    for (const [id, parked] of this.waiting) if (parked.requestId === requestId) this.waiting.delete(id);
  }

  /** The turn is over: nothing is owed, and no call may stay parked. */
  #settle() {
    this.parked = false;
    this.owed.clear();
    this.results.clear();
    for (const parked of this.waiting.values()) parked.reply(CANCELLED);
    this.waiting.clear();
  }

  /**
   * Translate the CLI's output into the chunks of one dsh step: text and reasoning as they
   * stream, `tool_use` blocks as tool calls. A reply that made calls ends the step with
   * `tool-calls` and leaves the turn parked; the turn's `result` (or an exit) ends it.
   * Text-only steps (summaries, one-shot answers) refuse any call.
   */
  async *step(signal, { textOnly = false } = {}) {
    this.busy = true;
    this.lastUsed = Date.now();
    this.toolsOff = textOnly;
    const out = new StepWriter();
    const calling = new Map(); // stream index -> { id, name, json } of a tool_use being streamed
    let calls = 0, aborting = false, ended = false, killTimer;
    const onAbort = () => {
      aborting = true;
      if (!this.interrupt()) this.kill();
      // Bound to this step: a later step on the same process must not be killed by it.
      killTimer ??= setTimeout(() => { if (!ended) this.kill(); }, INTERRUPT_GRACE_MS);
      killTimer.unref?.();
    };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const item = await this.queue.next();
        if (item.kind === 'exit') {
          this.streamed.clear();
          this.#settle();
          yield* out.close();
          ended = true;
          yield* out.finish(aborting ? abortedReason() : { kind: 'error', failure: Object.freeze({ code: 'PROVIDER_ERROR', message: `claude exited ${item.code}: ${this.stderr.trim() || 'no output'}` }) });
          return;
        }
        const event = item.event;
        switch (event.type) {
          case 'stream_event': {
            if (event.parent_tool_use_id) break;
            const e = event.event;
            if (e?.type === 'message_start') {
              if (e.message?.id) this.streamed.add(e.message.id);
              if (e.message?.usage) out.messageUsage(e.message.usage);
            } else if (e?.type === 'content_block_start') {
              if (e.content_block?.type === 'tool_use' && !textOnly) calling.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: '' });
            } else if (e?.type === 'content_block_delta') {
              if (typeof e.delta?.text === 'string') yield* out.text(e.delta.text);
              else if (typeof e.delta?.thinking === 'string') yield* out.reasoning(e.delta.thinking);
              else if (typeof e.delta?.partial_json === 'string' && calling.has(e.index)) calling.get(e.index).json += e.delta.partial_json;
            } else if (e?.type === 'content_block_stop') {
              if (out.open?.type === 'reasoning') yield* out.close();
              const call = calling.get(e.index);
              calling.delete(e.index);
              // A call to a tool dsh did not offer gets Claude Code's own error.
              const name = call && dshName(call.name, this.tools);
              if (name) {
                this.owed.add(call.id);
                calls++;
                yield* out.toolCall(call.id, name, call.json || '{}');
              }
            } else if (e?.type === 'message_delta') {
              if (e.usage) out.messageUsage(e.usage);
            } else if (e?.type === 'message_stop') {
              out.endMessage();
              if (calls > 0 && !aborting) {
                yield* out.close();
                ended = true;
                this.parked = true;
                yield* out.finish({ kind: 'tool-calls' });
                return;
              }
            }
            break;
          }
          case 'assistant':
            // With partial messages on, a whole message only matters when it was never
            // streamed. The CLI's synthetic error messages (a rate-limit notice) are not
            // the model's: they never reach the user, but their limit info is kept.
            if (event.parent_tool_use_id || this.streamed.has(event.message?.id)) break;
            if (event.is_api_error_message || event.error === 'rate_limit' || event.message?.model === '<synthetic>') {
              if (event.api_error_params?.rate_limit_info) out.limit ??= event.api_error_params.rate_limit_info;
              break;
            }
            for (const block of event.message?.content ?? []) if (block.type === 'text' && block.text) yield* out.text(block.text);
            break;
          case 'rate_limit_event': {
            const info = event.rate_limit_info ?? {};
            const covered = info.isUsingOverage || ['allowed', 'allowed_warning'].includes(info.overageStatus);
            if (info.status === 'rejected' && !covered) out.limit = info;
            break;
          }
          case 'result':
            this.streamed.clear();
            this.#settle();
            yield* out.close();
            if (!out.hasUsage && event.usage) out.addUsage(event.usage);
            ended = true;
            yield* out.finish(aborting ? abortedReason() : resultReason(event, out.limit));
            return;
          default:
            break; // system frames, tool_result echoes, keep_alive
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      this.toolsOff = false;
      if (!ended) this.dirty = true;
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }
}

const abortedReason = () => ({ kind: 'aborted', failure: Object.freeze({ code: 'ABORTED', message: 'aborted' }) });

export function resultReason(result, limit) {
  const rateLimit = limit ?? (result.api_error_status === 429 || result.api_error === 'usage_limit_reached' ? result.api_error_params?.rate_limit_info : undefined);
  if (rateLimit) {
    const resetAt = Number(rateLimit.resetsAt) * (Number(rateLimit.resetsAt) < 1e12 ? 1000 : 1);
    const delay = Number.isFinite(resetAt) && resetAt > Date.now() ? (resetAt - Date.now() + 2000) : undefined;
    return { kind: 'error', failure: Object.freeze({
      code: 'RATE_LIMIT',
      status: 429,
      message: result.result || 'Claude usage limit reached',
      ...(delay ? { providerRetryAfterMs: delay } : {}),
    }) };
  }
  if (result.is_error) {
    const message = String(result.result || (Array.isArray(result.errors) ? result.errors.join('; ') : '') || result.subtype || 'claude error');
    const login = result.api_error_status === 401 || /not logged in|authentication_error|failed to authenticate|oauth .*invalid/i.test(message);
    const status = Number.isInteger(result.api_error_status) ? result.api_error_status : undefined;
    return { kind: 'error', failure: Object.freeze({
      code: login ? 'MISSING_CREDENTIAL' : 'PROVIDER_ERROR',
      message: login ? `${message} (refresh the token: claude setup-token)` : message,
      ...(status ? { status } : {}),
    }) };
  }
  if (result.stop_reason === 'max_tokens') return { kind: 'max-tokens' };
  return { kind: 'stop' };
}

const USAGE_FIELDS = [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_input_tokens'], ['cacheWriteTokens', 'cache_creation_input_tokens']];

/** Block bookkeeping for one dsh step: indexes, one open block at a time, usage once. */
class StepWriter {
  index = 0;
  open;       // { index, type, text }
  total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  message;    // usage of the API message being streamed
  hasUsage = false;
  limit;      // rejected rate_limit_event of this turn

  *text(text) { yield* this.#delta('text', text); }
  *reasoning(text) { yield* this.#delta('reasoning', text); }

  *#delta(type, text) {
    if (!text) return;
    if (this.open?.type !== type) {
      // Whitespace never opens a block, so a reply that is only calls draws no text.
      if (!text.trim()) return;
      yield* this.close();
      this.open = { index: this.index++, type, text: '' };
      yield { type: 'block-start', index: this.open.index, blockType: type };
    }
    this.open.text += text;
    yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: this.open.index, text };
  }

  *close() {
    if (!this.open) return;
    const { index, type, text } = this.open;
    this.open = undefined;
    yield { type: 'block-end', index, block: { type, text } };
  }

  *toolCall(id, name, args) {
    yield* this.close();
    const index = this.index++;
    yield { type: 'block-start', index, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args };
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } };
  }

  /** message_start carries input and cache counts, message_delta the output (and may
   *  repeat input): keep the largest figure per field for the current message. */
  messageUsage(usage) {
    this.hasUsage = true;
    this.message ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const [ours, theirs] of USAGE_FIELDS) this.message[ours] = Math.max(this.message[ours], Number(usage[theirs]) || 0);
  }

  endMessage() {
    if (!this.message) return;
    for (const [ours] of USAGE_FIELDS) this.total[ours] += this.message[ours];
    this.message = undefined;
  }

  /** Turn-level fallback when no partial message reported any usage. */
  addUsage(usage) {
    this.hasUsage = true;
    for (const [ours, theirs] of USAGE_FIELDS) this.total[ours] += Number(usage[theirs]) || 0;
  }

  /** Usage (every counter, once) and then the terminal finish; nothing may follow. */
  *finish(reason) {
    this.endMessage();
    const usage = this.total;
    yield { type: 'usage', usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens } };
    yield { type: 'finish', reason };
  }
}
