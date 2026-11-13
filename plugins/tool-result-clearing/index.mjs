// Tool-result clearing: the stock tool-result pruner, plus Claude Code's way of keeping old
// tool output out of the prompt.
//
// Why: in the owner's recent DSH sessions tool results are 72% of the context bytes, and
// summary compaction is the main cache breaker (403 of 615 Opus misses, ~118k tokens of
// cache write each). The stock pruner only trims the middle of results over 8k characters,
// so the many medium bash/read outputs stay whole until a summary replaces the conversation.
//
// What Claude Code 2.1.323 does instead (read from its binary): it keeps the 12 most recent
// results of its read/shell/search tools and replaces older ones with a marker or a pointer
// to the saved output, only when that saves at least 20k tokens, and it does so when the
// prompt cache is already cold (the user returns after 3900 s, just past the 1 h TTL) or
// when context pressure builds. Clearing rewrites the prompt from the first cleared result,
// so doing it while the cache is warm would cost a rewrite for nothing.
//
// Here:
// - `pruneSession` (called by compaction-basic before it summarizes, and on a context
//   overflow) first clears old results, then trims the remaining over-budget ones exactly
//   like the stock pruner. When that brings the context under the threshold, compaction-basic
//   skips the summary and the conversation itself (every assistant message and tool call)
//   survives.
// - an `agent/pre-step` listener clears old results when the last model reply is older than
//   `idleSeconds`: the cache is gone anyway, so the rewrite it forces is the cheapest one.
//
// Each cleared result is saved to a private file first; the marker carries its path, so the
// model can read it back with bash. A result that cannot be saved is left untouched. The
// replacement goes through the same replay-safe `compaction/prune` + surface-replace events
// as the stock pruner.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHost } from '../common.mjs';

const { ToolResultPruner, DEFAULTS } = await import(resolveHost('@deepseek-ai/dsh-compaction-tool-result-pruner'));
const { freezeMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const { default: z } = await import(resolveHost('@deepseek-ai/schemastery'));

export const MARKER = '[Old tool result cleared to save context';
// Tools whose output is a re-obtainable observation (re-run the command, re-read the file).
// Not here on purpose: subagent/send_message results (a child's work, not reproducible),
// skill (loaded instructions), ask_user_question (the owner's answers), todo/goal/plan
// state changes.
export const CLEARABLE = ['bash', 'read', 'grep', 'glob', 'list', 'web_fetch', 'job_output', 'browser',
  'plan_read', 'plan_list', 'research', 'edit', 'write', 'apply_patch', 'read_image'];

const defaultDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'dsh-cleared-tool-results');
const safeSegment = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_';
const textOf = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
const isCleared = blocks => blocks.length > 0 && blocks[0].type === 'text' && blocks[0].text.startsWith(MARKER);

export default class ToolResultClearing extends ToolResultPruner {
  static inject = ['tokenMeter'];
  static Config = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    keepRecent: z.number().step(1).min(0).default(12),
    clearAtLeastTokens: z.number().step(1).min(0).default(20000),
    // 0 turns the idle trigger off; clearing then happens only under context pressure.
    idleSeconds: z.number().min(0).default(3900),
    tools: z.array(z.string()).default(CLEARABLE),
    dir: z.string().default(''),
  });

  constructor(ctx, config = {}) {
    const { thresholdChars, headChars, tailChars } = config;
    super(ctx, Object.fromEntries(Object.entries({ thresholdChars, headChars, tailChars }).filter(([, v]) => v !== undefined)));
    this.clearing = {
      keepRecent: config.keepRecent ?? 12,
      clearAtLeastTokens: config.clearAtLeastTokens ?? 20000,
      idleSeconds: config.idleSeconds ?? 3900,
      tools: new Set(config.tools ?? CLEARABLE),
      dir: config.dir || defaultDir(),
    };
    this.now = () => Date.now();
    if (this.clearing.idleSeconds > 0) {
      // Prepended so the pressure check of compaction-basic, which runs on the same event,
      // measures the context after this clearing.
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (!signal?.aborted) {
          try { this.clearAfterIdle(agent.session); } catch (error) {
            ctx.logger?.warn?.(`tool-result clearing after idle failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return next();
      }, true);
    }
  }

  /** Clear old results only when the last model reply is older than `idleSeconds`. */
  clearAfterIdle(session) {
    const last = this.lastReplyTime(session);
    if (last === undefined || this.now() - last < this.clearing.idleSeconds * 1000) return null;
    return this.clearOld(session);
  }

  lastReplyTime(session) {
    const nodes = session.surface.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const event = session.eventAt(nodes[i]);
      if (event?.type === 'assistant/message' && typeof event.time === 'number') return event.time;
    }
    return undefined;
  }

  /** Surface tool results in order, each with its tool name and current message. */
  results(session) {
    const names = new Map(), out = [];
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq);
      if (event?.type === 'assistant/message') {
        for (const block of session.deriveEventMessage(event).content ?? []) if (block.type === 'tool-call') names.set(block.id, block.name);
      } else if (event?.type === 'tool/result') {
        const message = session.deriveEventMessage(event);
        const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId;
        out.push({ seq, event, message, name: names.get(callId), callId });
      }
    }
    return out;
  }

  /**
   * Replace every clearable result older than the `keepRecent` newest with a marker, once
   * the total saving reaches `clearAtLeastTokens`. Returns null when nothing was cleared.
   */
  clearOld(session) {
    const clearable = this.results(session).filter(r => this.clearing.tools.has(r.name) && !isCleared(r.message.content ?? []));
    const old = clearable.slice(0, Math.max(0, clearable.length - this.clearing.keepRecent));
    const plans = [];
    let saved = 0;
    for (const result of old) {
      const text = textOf(result.message.content ?? []);
      if (!text) continue;
      const marker = `${MARKER}; full text (${text.length} chars): ${this.pathFor(session, result)}]`;
      if (marker.length >= text.length) continue;
      const content = [{ type: 'text', text: marker }, ...(result.message.content ?? []).filter(block => block.type !== 'text')];
      const replacement = freezeMessage({ ...result.message, content });
      const delta = this.ctx.tokenMeter.estimateMessage(result.message) - this.ctx.tokenMeter.estimateMessage(replacement);
      if (delta <= 0) continue;
      plans.push({ result, text, replacement });
      saved += delta;
    }
    if (!plans.length || saved < this.clearing.clearAtLeastTokens) return null;
    const cleared = [];
    for (const { result, text, replacement } of plans) {
      try { this.save(session, result, text); } catch { continue; }
      this.replace(session, result, replacement);
      cleared.push({ seq: result.seq, callId: result.callId, name: result.name, chars: text.length });
    }
    if (cleared.length) this.ctx.logger?.info?.(`tool-result clearing: cleared ${cleared.length} old results (~${saved} tokens), kept the last ${this.clearing.keepRecent}`);
    return cleared.length ? { cleared, tokensSaved: saved } : null;
  }

  pathFor(session, result) {
    return join(this.clearing.dir, safeSegment(session.id), `${result.seq}-${safeSegment(result.callId ?? 'call')}.txt`);
  }

  save(session, result, text) {
    // Synchronous on purpose: compaction-basic calls pruneSession without awaiting it.
    const path = this.pathFor(session, result);
    mkdirSync(join(this.clearing.dir, safeSegment(session.id)), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  }

  replace(session, result, message) {
    const { seq, event, message: original } = result;
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
    });
    return session.append('tool/result', { ...event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    });
  }

  /** Pressure path: clear old results, then trim what is left over budget (stock behavior). */
  pruneSession(session) {
    this.clearOld(session);
    return super.pruneSession(session);
  }
}
