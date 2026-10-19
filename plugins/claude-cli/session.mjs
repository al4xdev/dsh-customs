// One long-lived `claude -p` process per dsh session, driven over stream-json, and the
// translation of its output into dsh stream chunks for one dsh step at a time.
//
// The process has no tools, so every CLI turn ends on its own `result`. Tool use is
// the text protocol of protocol.mjs: call blocks in Claude's reply become dsh
// `tool-call` blocks and the step finishes with `tool-calls`; dsh runs them and the
// next step sends the results as a new user message to the same process.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { CallParser } from './protocol.mjs';

const INTERRUPT_GRACE_MS = 5000;
const STDERR_TAIL = 2000;

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
  constructor({ command, args, env, cwd, spec, onInit }) {
    this.spec = spec;
    this.queue = new Queue();
    /** Message ids already streamed as partials; a later whole `assistant` frame is an echo. */
    this.streamed = new Set();
    this.busy = false;
    /** A step left early (its consumer stopped reading): queued frames belong to no one. */
    this.dirty = false;
    this.alive = true;
    this.stderr = '';
    this.lastUsed = Date.now();
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => { this.stderr += String(error.message); });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-STDERR_TAIL); });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { this.stderr = (this.stderr + line + '\n').slice(-STDERR_TAIL); return; }
      // The CLI has created (or reopened) its transcript once it reports init.
      if (event.type === 'system' && event.subtype === 'init') onInit?.();
      this.queue.push({ kind: 'event', event });
    });
    this.child.on('close', code => {
      this.alive = false;
      this.queue.push({ kind: 'exit', code });
    });
  }

  write(message) {
    if (!this.alive || this.child.stdin.writableEnded) return false;
    this.child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }

  sendUser(text) {
    // The CLI refuses an empty text block.
    this.write({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: text || '(continue)' }] }, parent_tool_use_id: null });
  }

  interrupt() {
    return this.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
  }

  kill() {
    if (!this.alive) return;
    this.child.kill('SIGTERM');
    setTimeout(() => { if (this.alive) this.child.kill('SIGKILL'); }, INTERRUPT_GRACE_MS).unref();
  }

  /**
   * Translate one CLI turn into the chunks of one dsh step: text and reasoning as they
   * stream, call blocks as tool calls, and the turn's `result` as the finish (or
   * `tool-calls` when the reply asked for tools). Abort and exit end it too.
   */
  async *step(signal) {
    this.busy = true;
    this.lastUsed = Date.now();
    const out = new StepWriter();
    const parser = new CallParser();
    let aborting = false, cutting = false, ended = false, killTimer;
    const stopTurn = () => {
      if (!this.interrupt()) this.kill();
      // Bound to this step: a later step on the same process must not be killed by it.
      killTimer ??= setTimeout(() => { if (!ended) this.kill(); }, INTERRUPT_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => { aborting = true; stopTurn(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    // Parser output into chunks; a cut (the model inventing results) stops the turn once.
    const emit = function* (pieces) {
      for (const piece of pieces) {
        if (piece.text) yield* out.text(piece.text);
        else if (piece.call) yield* out.toolCall(`claude-cli-${randomUUID()}`, piece.call.name, piece.call.arguments);
        else if (piece.cut && !cutting) { cutting = true; stopTurn(); }
      }
    };
    try {
      for (;;) {
        const item = await this.queue.next();
        if (item.kind === 'exit') {
          this.streamed.clear();
          if (!cutting) yield* emit(parser.end());
          yield* out.close();
          ended = true;
          if (parser.calls > 0 && !aborting) yield* out.finish({ kind: 'tool-calls' });
          else yield* out.finish(aborting ? abortedReason() : { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: `claude exited ${item.code}: ${this.stderr.trim() || 'no output'}` } });
          return;
        }
        const event = item.event;
        switch (event.type) {
          case 'stream_event':
            if (event.parent_tool_use_id) break;
            yield* this.#streamEvent(event.event, out, parser, emit);
            break;
          case 'assistant':
            // With partial messages on, a whole message only matters when it was never
            // streamed (the CLI's synthetic rate-limit notice has a fresh id).
            if (event.parent_tool_use_id || this.streamed.has(event.message?.id) || cutting) break;
            for (const block of event.message?.content ?? []) if (block.type === 'text' && block.text) yield* emit(parser.feed(block.text));
            break;
          case 'control_request':
            // Nothing in this process can ask for permission; refuse whatever does.
            this.write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'not supported' } });
            break;
          case 'rate_limit_event': {
            const info = event.rate_limit_info ?? {};
            const covered = info.isUsingOverage || ['allowed', 'allowed_warning'].includes(info.overageStatus);
            if (info.status === 'rejected' && !covered) out.limit = info;
            break;
          }
          case 'result': {
            this.streamed.clear();
            if (!cutting) yield* emit(parser.end());
            yield* out.close();
            if (!out.hasUsage && event.usage) out.addUsage(event.usage);
            ended = true;
            if (aborting) yield* out.finish(abortedReason());
            // A reply that asked for tools ends the step on them, even when it was cut.
            else if (parser.calls > 0) yield* out.finish({ kind: 'tool-calls' });
            else if (cutting) yield* out.finish({ kind: 'stop' });
            else yield* out.finish(resultReason(event, out.limit));
            return;
          }
          default:
            break; // system frames, keep_alive, interrupt echoes
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      if (!ended) this.dirty = true;
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  *#streamEvent(event, out, parser, emit) {
    switch (event?.type) {
      case 'message_start':
        if (event.message?.id) this.streamed.add(event.message.id);
        if (event.message?.usage) out.messageUsage(event.message.usage);
        break;
      case 'content_block_delta':
        if (typeof event.delta?.text === 'string') { if (!parser.cut) yield* emit(parser.feed(event.delta.text)); }
        else if (typeof event.delta?.thinking === 'string') yield* out.reasoning(event.delta.thinking);
        break;
      case 'content_block_stop':
        // Text held for a possible block stays held across blocks; reasoning closes here.
        if (out.open?.type === 'reasoning') yield* out.close();
        break;
      case 'message_delta':
        if (event.usage) out.messageUsage(event.usage);
        break;
      case 'message_stop':
        out.endMessage();
        break;
      default:
        break;
    }
  }
}

const abortedReason = () => ({ kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } });

export function resultReason(result, limit) {
  if (limit) {
    const resetAt = Number(limit.resetsAt) * (Number(limit.resetsAt) < 1e12 ? 1000 : 1);
    return { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Claude usage limit reached',
      ...(Number.isFinite(resetAt) && resetAt > Date.now() ? { providerRetryAfterMs: resetAt - Date.now() } : {}) } };
  }
  if (result.is_error) {
    const message = String(result.result || (Array.isArray(result.errors) ? result.errors.join('; ') : '') || result.subtype || 'claude error');
    const login = result.api_error_status === 401 || /not logged in|authentication_error|failed to authenticate|oauth .*invalid/i.test(message);
    return { kind: 'error', failure: { code: login ? 'MISSING_CREDENTIAL' : 'PROVIDER_ERROR', message: login ? `${message} (refresh the token: claude setup-token)` : message,
      ...(Number.isInteger(result.api_error_status) ? { status: result.api_error_status } : {}) } };
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
