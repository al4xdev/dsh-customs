// Text tool protocol between dsh and a Claude Code process that has no tools at all
// (built-in tools off, and MCP servers are not an option: an organization allowlist can
// keep a local MCP server's tools out of the request).
//
// The model writes calls in the function-call markup Claude models are trained on, and
// the provider turns each one into a real dsh `tool-call`; dsh runs it in its own loop
// and the results come back as the next user message:
//
//   <function_calls>
//   <invoke name="bash">
//   <parameter name="command">ls</parameter>
//   </invoke>
//   </function_calls>
//
// Teaching that markup instead of an invented one keeps the model on familiar ground:
// deep into a long session it drifted back to it anyway. What it improvises around it
// is accepted too: the `antml:` tag prefix, a missing `<function_calls>` wrapper, a
// self-closing `<invoke/>`, a JSON body instead of parameters, and the older
// `<dsh_call name="x">{json}</dsh_call>` form.

const MARKUP_PREFIX = /<(\/?)antml:/g;
const DSH_OPEN = '<dsh_call', DSH_CLOSE = '</dsh_call>';
const INVOKE_OPEN = '<invoke', INVOKE_CLOSE = '</invoke>';
const WRAPPERS = ['<function_calls>', '</function_calls>'];
// Text a model writes when it imagines a tool's answer instead of waiting for it.
const INVENTED = ['<function_results', '<function_result', '<dsh_result'];
const BASE_MARKERS = [DSH_OPEN, INVOKE_OPEN, ...WRAPPERS, ...INVENTED];
// The prefixed spellings only need to be held until the prefix is normalized away.
const MARKERS = [...BASE_MARKERS, ...BASE_MARKERS.map(marker => marker.replace(/^<(\/?)/, '<$1antml:'))];
// Text after the last call is normally empty; past this much it is the model narrating
// or guessing, and the turn is cut.
const MAX_TRAILING = 400;
// A tag header longer than this without its `>` is not a call header.
const MAX_HEADER = 200;

const DSH_HEADER = /^<dsh_call\s+name\s*=\s*["']([^"']+)["']\s*(\/?)>/;
const INVOKE_HEADER = /^<invoke\s+name\s*=\s*["']([^"']+)["']\s*(\/?)>/;
const PARAMETER = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/g;

export function toolsPrompt(tools) {
  if (!tools?.length) return '';
  const entries = tools.map(tool => [
    `## ${tool.name}`,
    tool.description?.trim() || '(no description)',
    `Parameters (JSON Schema): ${JSON.stringify(tool.parameters ?? { type: 'object' })}`,
  ].join('\n'));
  return [
    '# Tools',
    "Claude Code's built-in tools are disabled in this session. The only tools are the dsh tools listed below; use them for all reading, editing, searching and commands.",
    'To run tools, write a function_calls block in your reply:',
    '<function_calls>',
    '<invoke name="TOOL_NAME">',
    '<parameter name="PARAMETER_NAME">value</parameter>',
    '</invoke>',
    '</function_calls>',
    'Write string values as plain text; write numbers, booleans, arrays and objects as JSON. Several invoke blocks in one function_calls block run in parallel.',
    'After the function_calls block, stop and end your reply. The results arrive in the next message, in call order, inside a <function_results> block. Inside a result, `&lt;` before a tool-protocol tag name (function_calls, function_results, invoke, dsh_call, dsh_result) stands for `<`.',
    'Never write function_results yourself and never guess a result. Write a function_calls block only to run tools, never in an example or a code block.',
    '',
    'Available tools:',
    '',
    entries.join('\n\n'),
  ].join('\n');
}

// Only tool-protocol tags are escaped: a result quoting them must not look like a call
// or close the results block. Everything else reaches the model byte for byte (an
// `&lt;` in file content would be copied back into edits).
const escapeTags = text => String(text).replace(/<(\/?(?:antml:)?(?:dsh_call|dsh_result|function_calls|function_results|invoke)\b)/g, '&lt;$1');

/** The next user message for tool results (in call order). */
export function resultsText(results) {
  if (!results.length) return '';
  const blocks = results.map((result, index) =>
    `<dsh_result name="${result.name}" index="${index + 1}"${result.isError ? ' error="true"' : ''}>\n${escapeTags(result.text)}\n</dsh_result>`);
  return ['<function_results>', ...blocks, '</function_results>'].join('\n');
}

/** Past calls in the markup the model is asked to write, for transcripts. */
export function callsText(calls) {
  if (!calls.length) return '';
  const invokes = calls.map(({ name, arguments: raw }) => {
    let args;
    try { args = JSON.parse(raw || '{}'); } catch { args = undefined; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return `<invoke name="${name}">${raw || ''}</invoke>`;
    const parameters = Object.entries(args).map(([key, value]) =>
      `<parameter name="${key}">${typeof value === 'string' ? value : JSON.stringify(value)}</parameter>`);
    return [`<invoke name="${name}">`, ...parameters, '</invoke>'].join('\n');
  });
  return ['<function_calls>', ...invokes, '</function_calls>'].join('\n');
}

/** One newline of tag layout on each side is markup, not value (`/var/log\n` is not a path). */
const unpad = value => value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

/**
 * `<parameter>` values as a JSON arguments string. Values are text in that markup; a
 * parameter the tool's schema types as anything but a string is read as JSON when it
 * parses, so `depth` "2" becomes 2 and an array stays an array. A body with no
 * parameters that is itself a JSON object is taken as the arguments.
 */
export function invokeArguments(body, schema) {
  const properties = schema?.properties ?? {};
  const args = {};
  let found = false;
  for (const [, name, raw] of body.matchAll(PARAMETER)) {
    found = true;
    const type = properties[name]?.type;
    const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
    const value = unpad(raw);
    if (types.length === 0 || (types.length === 1 && types[0] === 'string')) { args[name] = value; continue; }
    try { args[name] = JSON.parse(value.trim()); } catch { args[name] = value; }
  }
  if (!found) {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try { const parsed = JSON.parse(trimmed); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(parsed); } catch {}
    }
  }
  return JSON.stringify(args);
}

/**
 * Streaming parser for one reply. `feed` returns what is safe to emit so far: text, or a
 * complete call. Text that might be the start of a block is held until it is decided.
 * After the first call, only further calls count; an invented result or a long tail
 * means the model is guessing, reported as `{ cut: true }` once.
 * @param tools - the request's tool schemas, to type `<parameter>` values.
 */
export class CallParser {
  #pending = '';
  #trailing = 0;
  #schemas;
  #afterMarkup = false; // whitespace right after a wrapper or a call is layout too
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
      this.#pending = this.#pending.replace(MARKUP_PREFIX, '<$1');
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
      if (wrapper) { this.#pending = this.#pending.slice(wrapper.length); this.#afterMarkup = true; continue; } // never shown
      const invented = INVENTED.find(tag => this.#pending.startsWith(tag));
      if (invented) { this.#text(out, this.#pending); this.#pending = ''; break; }
      const dsh = this.#pending.startsWith(DSH_OPEN);
      const header = (dsh ? DSH_HEADER : INVOKE_HEADER).exec(this.#pending);
      if (!header) {
        // Not a call header (yet): wait for the `>` while it can still become one, else
        // the `<` is ordinary text, such as a quoted `<invoke name="bash"...`.
        if (!final && this.#pending.indexOf('>') < 0 && this.#pending.length < MAX_HEADER) break;
        this.#text(out, '<');
        this.#pending = this.#pending.slice(1);
        continue;
      }
      const name = header[1];
      let body = '';
      if (header[2] === '/') {
        this.#pending = this.#pending.slice(header[0].length); // self-closing: no arguments
      } else {
        const closeTag = dsh ? DSH_CLOSE : INVOKE_CLOSE;
        const close = this.#pending.indexOf(closeTag);
        if (close < 0) {
          if (final) this.#pending = ''; // an unfinished block never runs
          break;
        }
        body = this.#pending.slice(header[0].length, close);
        this.#pending = this.#pending.slice(close + closeTag.length);
      }
      this.#call(out, name, dsh, body);
    }
    return out;
  }

  #call(out, name, dsh, body) {
    let args;
    if (dsh && !/<parameter\b/.test(body)) {
      const trimmed = body.trim();
      args = trimmed || '{}';
    } else {
      args = invokeArguments(body, this.#schemas.get(name));
    }
    this.calls++;
    this.#trailing = 0;
    this.#afterMarkup = true;
    out.push({ call: { name, arguments: args } });
  }

  #text(out, text) {
    if (this.#afterMarkup) {
      // Drop the layout whitespace markup leaves, even when it arrives in later chunks.
      const rest = text.replace(/^\s+/, '');
      if (!rest) return;
      this.#afterMarkup = false;
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
  for (const marker of BASE_MARKERS) {
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
