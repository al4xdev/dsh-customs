// Text tool protocol between dsh and a Claude Code process that has no tools at all
// (built-in tools off, and MCP servers are not an option: an organization allowlist can
// keep a local MCP server's tools out of the request).
//
// dsh's tools are described in the appended system prompt. Claude asks for one by
// writing `<dsh_call name="tool">{json arguments}</dsh_call>` and ending its reply; the
// provider turns every block into a real dsh `tool-call`, dsh runs it in its own loop,
// and the results come back as the next user message in `<dsh_result>` blocks.

const OPEN = '<dsh_call';
const CLOSE = '</dsh_call>';
const RESULT = '<dsh_result';
// Text after the last call is normally empty; past this much it is the model narrating
// or guessing, and the turn is cut.
const MAX_TRAILING = 400;

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
    `${OPEN} name="TOOL_NAME">{"argument": "value"}${CLOSE}`,
    'The body is one JSON object with the arguments, following the tool\'s schema. Write several call blocks in one reply to run them in parallel.',
    `After your last call block, stop and end your reply. The results arrive in the next message, in call order, as ${RESULT} name="TOOL_NAME" index="1">…</dsh_result> blocks.`,
    `Never write a ${RESULT}> block yourself and never guess a result. Write a call block only to run it, never in an example or a code block.`,
    '',
    'Available tools:',
    '',
    entries.join('\n\n'),
  ].join('\n');
}

const escape = text => String(text).replace(/</g, '&lt;');

/** The next user message for tool results (in call order), plus any other new text. */
export function resultsText(results) {
  return results.map((result, index) =>
    `${RESULT} name="${result.name}" index="${index + 1}"${result.isError ? ' error="true"' : ''}>\n${escape(result.text)}\n</dsh_result>`).join('\n');
}

/** A past call rendered the way Claude writes it, for transcripts. */
export const callText = (name, args) => `${OPEN} name="${name}">${args || '{}'}${CLOSE}`;

/**
 * Streaming parser for one reply. `feed` returns what is safe to emit so far: text, or a
 * complete call. Text that might be the start of a block is held until it is decided.
 * After the first call, only further calls count; a `<dsh_result` or a long tail means
 * the model is inventing results, reported as `{ cut: true }` once.
 */
export class CallParser {
  #pending = '';
  #trailing = 0;
  calls = 0;
  cut = false;

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
      const open = this.#pending.indexOf(OPEN);
      if (open < 0) {
        const keep = final ? 0 : heldPrefix(this.#pending, [OPEN, RESULT]);
        this.#text(out, this.#pending.slice(0, this.#pending.length - keep));
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        break;
      }
      this.#text(out, this.#pending.slice(0, open));
      if (this.cut) break;
      const close = this.#pending.indexOf(CLOSE, open);
      if (close < 0) {
        if (final) this.#pending = ''; // an unfinished block never runs
        else this.#pending = this.#pending.slice(open);
        break;
      }
      const block = this.#pending.slice(open, close);
      this.#pending = this.#pending.slice(close + CLOSE.length);
      const header = /^<dsh_call\s+name\s*=\s*["']([^"']+)["']\s*>/.exec(block);
      if (!header) continue; // malformed header: not a call
      const body = block.slice(header[0].length).trim();
      this.calls++;
      this.#trailing = 0;
      out.push({ call: { name: header[1], arguments: body || '{}' } });
    }
    return out;
  }

  #text(out, text) {
    if (!text) return;
    if (this.calls === 0) {
      if (text.includes(RESULT)) {
        const at = text.indexOf(RESULT);
        if (at > 0) out.push({ text: text.slice(0, at) });
        this.cut = true;
        out.push({ cut: true });
        return;
      }
      out.push({ text });
      return;
    }
    // After a call nothing but more calls belongs to this reply.
    this.#trailing += text.trim().length;
    if (text.includes(RESULT) || this.#trailing > MAX_TRAILING) {
      this.cut = true;
      out.push({ cut: true });
    }
  }
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
