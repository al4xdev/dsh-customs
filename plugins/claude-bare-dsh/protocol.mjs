// Text tool protocol between dsh and a Claude Code process that has no tools at all
// (built-in tools off, and MCP servers are not an option: an organization allowlist can
// keep a local MCP server's tools out of the request).
//
// dsh's tools are described in the appended system prompt. Claude asks for one by
// writing `<dsh_call name="tool">{json arguments}</dsh_call>` and ending its reply; the
// provider turns every block into a real dsh `tool-call`, dsh runs it in its own loop,
// and the results come back as the next user message in `<dsh_result>` blocks.
//
// Claude models also fall back to the function-call markup they are trained on
// (`<invoke name="tool"><parameter name="p">v</parameter></invoke>`, optionally inside
// `<function_calls>`), most often deep into a long session. Those blocks are calls too:
// treating them as text left a session whose every "call" silently never ran.

const DSH_OPEN = '<dsh_call', DSH_CLOSE = '</dsh_call>';
const INVOKE_OPEN = '<invoke', INVOKE_CLOSE = '</invoke>';
const WRAPPERS = ['<function_calls>', '</function_calls>'];
// Text a model writes when it imagines a tool's answer instead of waiting for it.
const INVENTED = ['<dsh_result', '<function_results', '<function_result'];
const MARKERS = [DSH_OPEN, INVOKE_OPEN, ...WRAPPERS, ...INVENTED];
// Text after the last call is normally empty; past this much it is the model narrating
// or guessing, and the turn is cut.
const MAX_TRAILING = 400;
// A tag header longer than this without its `>` is not a call header.
const MAX_HEADER = 200;

const DSH_HEADER = /^<dsh_call\s+name\s*=\s*["']([^"']+)["']\s*>/;
const INVOKE_HEADER = /^<invoke\s+name\s*=\s*["']([^"']+)["']\s*>/;
const PARAMETER = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/g;

export function toolsPrompt(tools) {
  if (!tools?.length) return '';
  const entries = tools.map(tool => [
    `## ${tool.name}`,
    tool.description?.trim() || '(no description)',
    `Arguments (JSON Schema): ${JSON.stringify(tool.parameters ?? { type: 'object' })}`,
  ].join('\n'));
  return [
    '# Tools',
    "Claude Code's built-in tools are disabled in this session. The only tools are the dsh tools listed below; use them for all reading, editing, searching and commands.",
    'To run a tool, write a call block in your reply, exactly in this form:',
    `${DSH_OPEN} name="TOOL_NAME">{"argument": "value"}${DSH_CLOSE}`,
    'The body is one JSON object with the arguments, following the tool\'s schema. Write several call blocks in one reply to run them in parallel.',
    'After your last call block, stop and end your reply. The results arrive in the next message, in call order, as <dsh_result name="TOOL_NAME" index="1">…</dsh_result> blocks. Inside a result, `&lt;dsh_` stands for a literal `<dsh_`.',
    'Never write a <dsh_result> block yourself and never guess a result. Write a call block only to run it, never in an example or a code block.',
    '',
    'Available tools:',
    '',
    entries.join('\n\n'),
  ].join('\n');
}

// Only the protocol's own tags are escaped: a result quoting them must not close or
// open a block. Everything else reaches the model byte for byte (an `&lt;` in file
// content would be copied back into edits).
const escapeTags = text => String(text).replace(/<(\/?dsh_(?:call|result)\b)/g, '&lt;$1');

/** The next user message for tool results (in call order), plus any other new text. */
export function resultsText(results) {
  return results.map((result, index) =>
    `<dsh_result name="${result.name}" index="${index + 1}"${result.isError ? ' error="true"' : ''}>\n${escapeTags(result.text)}\n</dsh_result>`).join('\n');
}

/** A past call rendered the way Claude is asked to write it, for transcripts. */
export const callText = (name, args) => `${DSH_OPEN} name="${name}">${args || '{}'}${DSH_CLOSE}`;

/**
 * `<invoke>` parameters as a JSON arguments string. Values are text in that markup; a
 * parameter the tool's schema types as anything but a string is read as JSON when it
 * parses, so `depth` "2" becomes 2 and an array stays an array.
 */
export function invokeArguments(body, schema) {
  const properties = schema?.properties ?? {};
  const args = {};
  for (const [, name, raw] of body.matchAll(PARAMETER)) {
    const type = properties[name]?.type;
    const wantsString = type === 'string' || (Array.isArray(type) && type.includes('string') && type.length === 1);
    let value = raw;
    if (!wantsString && type !== undefined) {
      try { value = JSON.parse(raw.trim()); } catch { value = raw; }
    }
    args[name] = value;
  }
  return JSON.stringify(args);
}

/**
 * Streaming parser for one reply. `feed` returns what is safe to emit so far: text, or a
 * complete call. Text that might be the start of a block is held until it is decided.
 * After the first call, only further calls count; an invented result or a long tail
 * means the model is guessing, reported as `{ cut: true }` once.
 * @param tools - the request's tool schemas, to type `<invoke>` parameters.
 */
export class CallParser {
  #pending = '';
  #trailing = 0;
  #schemas;
  #afterWrapper = false; // whitespace right after `<function_calls>` is markup too
  calls = 0;
  cut = false;

  constructor(tools = []) {
    this.#schemas = new Map(tools.map(tool => [tool.name, tool.parameters]));
  }

  feed(text) {
    this.#pending += text;
    return this.#drain(false);
  }

  /** End of the reply: whatever is held is plain text (an unfinished block is dropped). */
  end() {
    return this.#drain(true);
  }

  #drain(final) {
    const out = [];
    while (this.#pending && !this.cut) {
      const at = firstMarker(this.#pending);
      if (at < 0) {
        const keep = final ? 0 : heldPrefix(this.#pending, MARKERS);
        this.#text(out, this.#pending.slice(0, this.#pending.length - keep));
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        break;
      }
      this.#text(out, this.#pending.slice(0, at));
      if (this.cut) break;
      this.#pending = this.#pending.slice(at);
      const wrapper = WRAPPERS.find(tag => this.#pending.startsWith(tag));
      if (wrapper) { this.#pending = this.#pending.slice(wrapper.length); this.#afterWrapper = true; continue; } // markup only, never shown
      const invented = INVENTED.find(tag => this.#pending.startsWith(tag));
      if (invented) { this.#text(out, this.#pending); this.#pending = ''; break; }
      const dsh = this.#pending.startsWith(DSH_OPEN);
      const header = (dsh ? DSH_HEADER : INVOKE_HEADER).exec(this.#pending);
      if (!header) {
        // Not a call header (yet): wait for the `>` while it can still become one, else
        // the `<` is ordinary text, such as a quoted `<invoke name="bash"...`.
        const close = this.#pending.indexOf('>');
        if (!final && close < 0 && this.#pending.length < MAX_HEADER) break;
        this.#text(out, '<');
        this.#pending = this.#pending.slice(1);
        continue;
      }
      const closeTag = dsh ? DSH_CLOSE : INVOKE_CLOSE;
      const close = this.#pending.indexOf(closeTag);
      if (close < 0) {
        if (final) this.#pending = ''; // an unfinished block never runs
        break;
      }
      const body = this.#pending.slice(header[0].length, close);
      this.#pending = this.#pending.slice(close + closeTag.length);
      const name = header[1];
      const args = dsh ? (body.trim() || '{}') : invokeArguments(body, this.#schemas.get(name));
      this.calls++;
      this.#trailing = 0;
      this.#afterWrapper = true; // the newline after a block is layout as well
      out.push({ call: { name, arguments: args } });
    }
    return out;
  }

  #text(out, text) {
    if (this.#afterWrapper) {
      // Drop the layout whitespace a wrapper leaves, even when it arrives in later chunks.
      const rest = text.replace(/^\s+/, '');
      if (!rest) return;
      this.#afterWrapper = false;
      text = rest;
    }
    if (!text) return;
    const invented = INVENTED.map(tag => text.indexOf(tag)).filter(at => at >= 0).sort((a, b) => a - b)[0];
    if (this.calls === 0) {
      if (invented !== undefined) {
        if (invented > 0) out.push({ text: text.slice(0, invented) });
        this.cut = true;
        out.push({ cut: true });
        return;
      }
      out.push({ text });
      return;
    }
    // After a call nothing but more calls belongs to this reply.
    this.#trailing += text.trim().length;
    if (invented !== undefined || this.#trailing > MAX_TRAILING) {
      this.cut = true;
      out.push({ cut: true });
    }
  }
}

/** Index of the earliest marker in `text`, or -1. */
function firstMarker(text) {
  let first = -1;
  for (const marker of MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  return first;
}

/** Length of the longest suffix of `text` that is a proper prefix of any marker. */
function heldPrefix(text, markers) {
  let keep = 0;
  for (const marker of markers) {
    for (let length = Math.min(marker.length - 1, text.length); length > keep; length--) {
      if (marker.startsWith(text.slice(text.length - length))) { keep = length; break; }
    }
  }
  return keep;
}
