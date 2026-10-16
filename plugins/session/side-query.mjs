import { resolveInstalled } from './host-paths.mjs';

// Side queries for the Companion: `ask` (the TUI's `/btw`) and `recap` (the
// TUI's `/recap`), run INSIDE the dsh-tui process that hosts the target agent,
// on that agent's own model route. The TUI implements them in
// @deepseek-harness-tui/dsh-tui lib/types/dsh-adapter/{sideQuestion,recap}.js and
// lib/types/channel/side-prompts.js, but its package exports none of those
// modules, so the minimal logic is mirrored here (behavior notes inline).
// Nothing here appends to the session log, steers or waits for the main turn.

export const SIDE_TIMEOUT_MS = 120_000;
export const MAX_ANSWER_CHARS = 8000;
export const MAX_QUESTION_BYTES = 8 * 1024;
export const RECAP_RECENT_CHARS = 6000;
const RECAP_RECENT_TURNS = 6;
const PENDING_ARGS_LIMIT = 400;

/** Same answered-call shapes as the TUI's compat/messages.js answeredToolCallIds. */
function answeredToolCallIds(message) {
  const ids = message.role === 'tool' && typeof message.toolCallId === 'string' ? [message.toolCallId] : [];
  for (const block of message.content ?? []) if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') ids.push(block.toolCallId);
  return ids;
}

/**
 * Mirror of the TUI's splitUnresolvedToolCalls: a side call can land while the
 * main turn waits on a tool, and providers reject a transcript whose assistant
 * tool call has no result. Every unanswered call is removed (an emptied
 * assistant message is dropped); only calls of the still-open step come back
 * as `pending`, so the prompt can say they are still executing.
 */
export function splitUnresolvedToolCalls(messages, running) {
  const answered = new Set(), calls = [];
  for (const message of messages) {
    for (const id of answeredToolCallIds(message)) answered.add(id);
    if (message.role === 'assistant') for (const block of message.content ?? []) if (block?.type === 'tool-call') calls.push(block);
  }
  const unresolved = new Set(calls.filter(call => !answered.has(call.id)).map(call => call.id));
  if (unresolved.size === 0) return { messages, pending: [] };
  const pending = calls.filter(call => unresolved.has(call.id) && running.has(call.id));
  const kept = [];
  for (const message of messages) {
    if (message.role !== 'assistant') { kept.push(message); continue; }
    const content = message.content.filter(block => block?.type !== 'tool-call' || !unresolved.has(block.id));
    if (content.length === 0) continue;
    kept.push(content.length === message.content.length ? message : { ...message, content });
  }
  return { messages: kept, pending };
}

/** Mirror of openStepToolCallIds: tool calls of the open step still waiting for a result. */
export function openStepToolCallIds(events) {
  const open = new Set();
  for (const event of events) {
    if (['turn/start', 'turn/end', 'step/end'].includes(event?.type)) open.clear();
    if (event?.type === 'assistant/message') for (const block of event.data?.message?.content ?? []) if (block?.type === 'tool-call') open.add(block.id);
    if (event?.type === 'tool/result') open.delete(event.data?.message?.source?.callId);
  }
  return open;
}

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
function clip(text, limit) {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit)}…`;
}

/**
 * The TUI's sideQuestionPrompt, with one deliberate difference: the target's
 * declared tools are replayed (see buildSideRequest) to keep the request a
 * cache-reusing prefix of the main conversation, so the text says no tool will
 * run instead of claiming none is declared.
 */
export function wrapSideQuestion(question, pending = []) {
  const running = pending.map(call => `${call.name} ${clip(oneLine(typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? '')), PENDING_ARGS_LIMIT)}`);
  const note = running.length === 0 ? '' : `\nThe main task is still executing these tool calls; their results are not available yet:\n${running.map(line => `- ${line}`).join('\n')}`;
  return `<side-question-context>
Give one concise answer to the question below using the conversation already provided.
This auxiliary call runs alongside the main session. The main task continues independently;
do not describe it as interrupted, resumed, or as work performed by this call.
Do not call any tool: tool definitions may be listed above, but nothing will execute in this call.
Do not claim to inspect files, execute commands, browse, or carry out future actions.
There will be no follow-up turn for this call.
When the available context is insufficient, state what is unknown without promising research.${note}
</side-question-context>

${question}`;
}

function textOfContent(content) {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) return block.text.trim();
  return undefined;
}
/** Mirror of the TUI's collectRecentActivity: newest exchanges first into the budget, printed oldest to newest. */
export function collectRecentActivity(events, limitChars = RECAP_RECENT_CHARS) {
  const entries = [];
  for (const event of events) {
    if (event?.type === 'user/message') { const text = textOfContent(event.data?.content); if (text !== undefined) entries.push({ role: 'user', text }); }
    else if (event?.type === 'assistant/message') { const text = textOfContent(event.data?.message?.content); if (text !== undefined) entries.push({ role: 'assistant', text }); }
  }
  let budget = limitChars;
  const picked = [];
  for (const entry of entries.slice(-RECAP_RECENT_TURNS * 2).reverse()) {
    if (budget <= 0) break;
    const text = entry.text.length > budget ? entry.text.slice(0, budget) : entry.text;
    picked.push({ role: entry.role, text });
    budget -= text.length + entry.role.length + 2;
  }
  return picked.reverse().map(entry => `${entry.role}: ${entry.text}`).join('\n');
}
/** The TUI's wrapRecapPrompt contract (JSON title + one-line summary). */
export function wrapRecapPrompt(activity) {
  return `Create a compact session recap from the activity excerpt below.
Use the user's language and describe the work and its current outcome accurately.
Return one JSON object with two string fields:
- "title": a descriptive title of about 2-6 words.
- "summary": one line of about 10-20 words covering the most recent progress.
Do not include Markdown fences or any text outside the JSON object.

Activity excerpt:
${activity}`;
}
/** The TUI's parseRecapResponse: the JSON object if present, else the whole text as summary. */
export function parseRecapResponse(raw) {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const summary = typeof parsed?.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : undefined;
      const title = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined;
      if (summary !== undefined) return title === undefined ? { summary } : { summary, title };
    } catch { /* Fall through to the raw-text summary. */ }
  }
  return { summary: raw.trim() };
}

const snapshotEvents = session => typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : Array.isArray(session?.events) ? session.events : [];
function systemText(messages) {
  const system = messages.findLast?.(message => message.role === 'system');
  const text = system?.content?.map(block => block?.type === 'text' ? block.text : '').join('') ?? '';
  return text || undefined;
}

/**
 * The route the live agent itself uses: the last request header's call config
 * (what its next request is compared against), else its agent options, as
 * dsh-compaction-basic resolves an auxiliary target. Never the Companion's route.
 */
export function routeOf(agent) {
  let header;
  try { header = agent.session.requestHeader?.(); } catch { header = undefined; }
  const config = header?.config ?? agent.options ?? {};
  if (typeof config.provider !== 'string' || !config.provider || typeof config.model !== 'string' || !config.model) return undefined;
  const route = { provider: config.provider, model: config.model };
  for (const key of ['reasoningEffort', 'temperature', 'maxTokens']) if (config[key] !== undefined) route[key] = config[key];
  if (Array.isArray(config.stop)) route.stop = [...config.stop];
  return { route, tools: Array.isArray(header?.tools) ? header.tools : undefined };
}

/**
 * ask: the derived history (unresolved tool calls stripped) + one wrapped
 * question, with the target's tools and tool history replayed, exactly like
 * the compaction call keeps the provider's warm prefix cache. recap: only the
 * borrowed system text + a <=6000-character activity excerpt, like the TUI.
 */
export function buildSideRequest(agent, kind, question, signal) {
  const resolved = routeOf(agent);
  if (!resolved) return { error: 'side_unavailable', reason: 'The live agent has no model route yet.' };
  const session = agent.session;
  let messages, extra = {};
  if (kind === 'ask') {
    const history = splitUnresolvedToolCalls(session.deriveMessages(), openStepToolCallIds(snapshotEvents(session)));
    messages = [...history.messages, { role: 'user', content: [{ type: 'text', text: wrapSideQuestion(question, history.pending) }] }];
    if (resolved.tools) extra.tools = [...resolved.tools];
    if (typeof session.toolHistory === 'function') { try { extra.toolHistory = session.toolHistory(); } catch { /* Optional route projection. */ } }
  } else {
    const activity = collectRecentActivity(snapshotEvents(session));
    if (!activity) return { error: 'side_no_activity', reason: 'The session has no user/assistant text to recap yet.' };
    messages = [{ role: 'user', content: [{ type: 'text', text: wrapRecapPrompt(activity) }] }];
    let system;
    try { system = systemText(session.deriveMessages()); } catch { system = undefined; }
    if (system) extra.system = system;
  }
  return { options: { ...resolved.route, messages, ...extra, sessionId: session.id, signal } };
}

let assemblerClass;
async function blockAssembler() {
  assemblerClass ??= (await import(resolveInstalled('@deepseek-ai/dsh-llm', 'dsh-llm unavailable for side queries'))).BlockAssembler;
  return new assemblerClass();
}

/**
 * Stream one side call. Only visible text is kept (reasoning and any tool-call
 * block are discarded: nothing executes). The answer is capped: past the cap
 * the stream is aborted, so an unexpectedly long answer stops costing tokens.
 */
export async function runSideQuery({ llm, agent, kind, question, signal, timeoutMs = SIDE_TIMEOUT_MS, maxChars = MAX_ANSWER_CHARS }) {
  if (typeof llm?.stream !== 'function') return { ok: false, code: 'side_unavailable', reason: 'The live host has no LLM service.' };
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([stop.signal, deadline, ...(signal ? [signal] : [])]);
  const built = buildSideRequest(agent, kind, question, combined);
  if (built.error) return { ok: false, code: built.error, reason: built.reason };
  const assembler = await blockAssembler();
  let streamed = '', truncated = false;
  try {
    for await (const chunk of llm.stream(built.options)) {
      assembler.push(chunk);
      if (chunk?.type === 'text-delta' && chunk.text) {
        streamed += chunk.text;
        if (streamed.length > maxChars) { truncated = true; stop.abort(); break; }
      }
    }
  } catch (error) {
    if (!truncated) {
      if (deadline.aborted) return { ok: false, code: 'side_timeout', reason: `No answer within ${Math.round(timeoutMs / 1000)}s.` };
      if (signal?.aborted) return { ok: false, code: 'cancelled', reason: 'The side query was cancelled.' };
      return { ok: false, code: 'side_failed', reason: String(error?.message ?? error).slice(0, 240) };
    }
  }
  if (!truncated) {
    if (deadline.aborted) return { ok: false, code: 'side_timeout', reason: `No answer within ${Math.round(timeoutMs / 1000)}s.` };
    if (signal?.aborted) return { ok: false, code: 'cancelled', reason: 'The side query was cancelled.' };
    let finish;
    try { finish = assembler.finish; } catch { finish = undefined; }
    if (finish?.kind === 'error' || finish?.kind === 'aborted') return { ok: false, code: 'side_failed', reason: String(finish.failure?.message ?? finish.kind).slice(0, 240) };
  }
  let text;
  try { text = truncated ? streamed : assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join(''); }
  catch { text = streamed; }
  text = text.trim();
  if (!text) return { ok: false, code: 'side_no_answer', reason: 'The model returned no text answer.' };
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  const route = { provider: built.options.provider, model: built.options.model, ...(built.options.reasoningEffort === undefined ? {} : { reasoningEffort: built.options.reasoningEffort }) };
  if (kind === 'recap') return { ok: true, answer: { kind, ...parseRecapResponse(text), truncated, route } };
  return { ok: true, answer: { kind, text, truncated, route } };
}
