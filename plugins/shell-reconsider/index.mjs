import { defineTool, stringOutput, assertActive } from '../common.mjs';

export const name = 'alex-shell-reconsider';
export const inject = ['tools'];

// ---------------------------------------------------------------------------
// Shell-aware classification
//
// The first version of this file ran regexes against the whole raw command
// string. That failed in both directions at once, and the combination is what
// made it routable:
//
//   False positives. /\b(rm|unlink)\b/ matched those letters *anywhere*, so
//   `docker run --rm`, `npm run remove-old`, a commit message mentioning rm, or
//   any quoted string containing "rm" was denied. When the guard denies things
//   that are obviously fine, the model stops treating it as a signal and starts
//   looking for the way around it — which is exactly what happened in the
//   session that prompted this rewrite, where a true `rm -rf` got bundled into
//   a compound script and the guard was narrated as an obstacle.
//
//   False negatives. Splitting on &&/||/; meant only the first line of each
//   chunk was inspected, so `echo hi` followed by `cat /etc/passwd` on the next
//   line never reached the read check. `$(rm -rf x)` and `sh -c 'rm -rf x'`
//   were invisible. And rm/unlink were the only removals recognised, leaving
//   rmdir, shred, truncate, `dd of=`, `find -delete`, `find -exec rm`,
//   `git clean -f` and `git reset --hard` uncovered.
//
// Classification therefore tokenizes first: quotes, escapes, comments and
// here-doc bodies are resolved, command substitutions and `sh -c` payloads are
// recursed into, and every check runs against a real argv[0] rather than a
// substring of the raw text.
//
// This is a reflection nudge, not a security boundary. It reads command text;
// it does not sandbox anything, and unusual input can still evade it.
// ---------------------------------------------------------------------------

// Longest-first: `.find` returns the first entry that matches at the offset, so
// `2>>` must be offered before `2>` before `>`.
const OPERATORS = ['&&', '||', '&>>', '&>', '2>>', '2>', '1>>', '1>', '>>', '<<<', '<<', '|&', '|', ';', '&', '(', ')', '>', '<'];

/** argv[0] values that remove, truncate or rewrite filesystem state. */
const DESTRUCTIVE = new Set(['rm', 'unlink', 'rmdir', 'shred', 'truncate']);
/** Prefixes that do not change which program actually runs. */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'setsid']);
/** Shells whose `-c` payload is itself a command string. */
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

const READ_OPS = new Set(['cat', 'head', 'tail', 'less', 'more']);
const LIST_OPS = new Set(['ls', 'tree', 'find']);
const GREP_OPS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUBSTITUTION = /^\u0000SUB(\d+)\u0000$/;
// Silent-failure idioms. Only used to colour a destructive reason, never to
// decide on its own: `cmd > /dev/null` is ordinary, `rm -rf x > /dev/null` is not.
const MASKING = /(?:2>|&>|>)\s*\/dev\/null|\|\|\s*(?:true|:)(?=\s|$|[;&|\n])/;

const PIPE_SEPARATORS = new Set(['|', '|&']);

/**
 * How many separate operations one bash call may carry. A dozen-step script is
 * not faster, it is opaque: the transcript shows one wall of text instead of a
 * sequence of decisions, and there is no discrete point to revert to.
 */
export const DEFAULT_COMPOUND_LIMIT = 6;

/**
 * Drops here-doc bodies so their payload is not parsed as commands, while still
 * reporting how many lines they held: a script fed through `bash <<EOF` is a
 * single shell statement and forty operations.
 */
function stripHereDocs(script) {
  const kept = [];
  let terminator = null;
  let heredocLines = 0;
  for (const line of script.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      else if (line.trim() !== '') heredocLines += 1;
      continue;
    }
    kept.push(line);
    if (line.includes('<<<')) continue;
    const match = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (match) terminator = match[1];
  }
  return { script: kept.join('\n'), heredocLines };
}

/**
 * Replaces `$(...)` and backtick payloads with placeholders so the surrounding
 * command can be tokenized normally, keeping each payload for recursion.
 * Single quotes suppress substitution, so their contents are left alone.
 */
function extractSubstitutions(script) {
  const bodies = [];
  let out = '';
  let quote = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += ch;
      continue;
    }
    if (ch === '\\') { out += ch + (script[i + 1] ?? ''); i += 1; continue; }
    if (quote === null && ch === "'") { quote = "'"; out += ch; continue; }
    if (ch === '"') { quote = quote === '"' ? null : '"'; out += ch; continue; }
    if (ch === '$' && script[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < script.length && depth > 0) {
        if (script[j] === '(') depth += 1;
        else if (script[j] === ')') depth -= 1;
        j += 1;
      }
      bodies.push(script.slice(i + 2, j - 1));
      out += ` \u0000SUB${bodies.length - 1}\u0000 `;
      i = j - 1;
      continue;
    }
    if (ch === '`') {
      const end = script.indexOf('`', i + 1);
      if (end !== -1) {
        bodies.push(script.slice(i + 1, end));
        out += ` \u0000SUB${bodies.length - 1}\u0000 `;
        i = end;
        continue;
      }
    }
    out += ch;
  }
  return { script: out, bodies };
}

/** Splits a script into word and operator tokens. */
function tokenize(script) {
  const tokens = [];
  let word = '';
  let quote = null;
  const flush = () => { if (word !== '') tokens.push({ type: 'word', value: word }); word = ''; };
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') { word += script[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) { quote = null; continue; }
      word += ch;
      continue;
    }
    if (ch === '\\') { word += script[i + 1] ?? ''; i += 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '#' && word === '') {
      while (i < script.length && script[i] !== '\n') i += 1;
      flush();
      tokens.push({ type: 'op', value: '\n' });
      continue;
    }
    if (ch === '\n') { flush(); tokens.push({ type: 'op', value: '\n' }); continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    const operator = OPERATORS.find(candidate => script.startsWith(candidate, i));
    if (operator !== undefined) { flush(); tokens.push({ type: 'op', value: operator }); i += operator.length - 1; continue; }
    word += ch;
  }
  flush();
  return tokens;
}

/**
 * Strips assignments and wrappers to find the program a command really runs.
 * `VAR=x sudo rm -rf y` resolves to `rm`; leading flags are skipped so
 * `nice -n 5 rm x` also resolves. Wrapper forms that take a separate flag
 * argument (e.g. `sudo -u root rm`) resolve imprecisely on purpose: this reads
 * text, it does not implement shell parsing.
 */
function resolveArgv(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (ASSIGNMENT.test(word)) { index += 1; continue; }
    if (word === 'xargs') {
      index += 1;
      while (index < words.length && words[index].startsWith('-')) index += 1;
      continue;
    }
    if (WRAPPERS.has(word)) {
      index += 1;
      while (index < words.length && (words[index].startsWith('-') || ASSIGNMENT.test(words[index]))) index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

/** Names the destructive operation a resolved command performs, if any. */
function detectDestructive(argv) {
  const program = argv[0];
  if (DESTRUCTIVE.has(program)) return `\`${program}\``;
  if (program === 'dd' && argv.some(word => word.startsWith('of='))) return '`dd of=`';
  if (program === 'find') {
    if (argv.includes('-delete')) return '`find -delete`';
    for (const flag of ['-exec', '-execdir']) {
      const at = argv.indexOf(flag);
      if (at !== -1 && DESTRUCTIVE.has(argv[at + 1])) return `\`find ${flag} ${argv[at + 1]}\``;
    }
  }
  if (program === 'git') {
    if (argv[1] === 'clean' && argv.slice(2).some(word => /^-[a-zA-Z]*[fdx]/.test(word))) return '`git clean` with -f/-d/-x';
    if (argv[1] === 'reset' && argv.includes('--hard')) return '`git reset --hard`';
  }
  return null;
}

/**
 * Classifies a shell command as reading, directory exploration, content
 * search, or a destructive operation. Returns null for anything else, so
 * ordinary development commands pass through untouched.
 */
export function classifyCommand(rawCommand, options = {}) {
  if (typeof rawCommand !== 'string') return null;
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;

  const compoundLimit = Number.isSafeInteger(options.compoundLimit) && options.compoundLimit > 0
    ? options.compoundLimit
    : DEFAULT_COMPOUND_LIMIT;

  let destructive = null;
  let destructiveNested = false;
  let commands = 0;
  const heads = [];

  const scan = (script, depth) => {
    if (depth > 8 || !script.trim()) return;
    const stripped = stripHereDocs(script);
    const { script: replaced, bodies } = extractSubstitutions(stripped.script);
    const tokens = tokenize(replaced);
    let words = [];
    let piped = false;
    let firstProgram = null;

    const flushCommand = () => {
      if (!words.length) { words = []; return; }
      const argv = resolveArgv(words);
      words = [];
      if (!argv.length) return;
      commands += 1;
      if (firstProgram === null) firstProgram = argv[0];
      if (!piped) heads.push(argv[0]);
      if (destructive === null) {
        destructive = detectDestructive(argv);
        if (destructive !== null && depth > 0) destructiveNested = true;
      }
      if (SHELLS.has(argv[0])) {
        const at = argv.indexOf('-c');
        if (at !== -1 && argv.length > at + 1) scan(argv.slice(at + 1).join(' '), depth + 1);
      }
    };

    for (const token of tokens) {
      if (token.type === 'word') { words.push(token.value); continue; }
      if (PIPE_SEPARATORS.has(token.value)) { flushCommand(); piped = true; continue; }
      flushCommand();
      piped = false;
    }
    flushCommand();

    // A here-doc is a script only when a shell is the one reading it. Counting
    // every body would flag `git commit -F - <<MSG`, where the body is a commit
    // message and not a single operation.
    if (stripped.heredocLines > 0 && firstProgram !== null && SHELLS.has(firstProgram)) {
      commands += stripped.heredocLines;
    }

    // Substitution payloads run as their own commands, one level deeper.
    for (const token of tokens) {
      if (token.type !== 'word') continue;
      const match = SUBSTITUTION.exec(token.value);
      if (match) scan(bodies[Number(match[1])] ?? '', depth + 1);
    }
  };

  scan(trimmed, 0);

  if (destructive !== null) {
    const notes = [];
    if (destructiveNested) notes.push('It was reached through a substitution or a nested shell rather than written directly.');
    if (MASKING.test(trimmed)) notes.push('The command also silences failures (`/dev/null` or `|| true`), which hides an incomplete removal.');
    return {
      type: 'destructive',
      reason: `Destructive command blocked: ${destructive}. Prefer the native \`trash\` tool for recoverable removal.${notes.length ? ` ${notes.join(' ')}` : ''} If permanent deletion is strictly required by the user, confirm via shell_reconsider(necessary=true).`,
    };
  }

  if (commands > compoundLimit) {
    return {
      type: 'compound',
      reason: `Compound command blocked: ${commands} separate operations in one bash call (limit ${compoundLimit}). Run them as separate calls so each step is visible and revertable in the transcript, one operation at a time. If the script genuinely must run as a unit, confirm via shell_reconsider(necessary=true).`,
    };
  }

  if (heads.some(head => READ_OPS.has(head))) {
    return {
      type: 'read',
      reason: 'Shell command blocked: for viewing file contents, use the native `read` tool instead of shell.',
    };
  }

  if (heads.some(head => LIST_OPS.has(head))) {
    return {
      type: 'list',
      reason: 'Shell command blocked: for exploring directories and listing files, use the native `list` (or `glob`) tool instead of shell.',
    };
  }

  if (heads.some(head => GREP_OPS.has(head))) {
    return {
      type: 'grep',
      reason: 'Shell command blocked: for searching file content, use the native `grep` tool instead of shell.',
    };
  }

  return null;
}

const fingerprint = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/**
 * Relaxes the description requirement on the bash tool:
 * 1. Removes 'description' from parameters.required so schema validation passes.
 * 2. Augments exec.arguments in tools/execute if description is omitted by the model.
 * 3. Wraps bash.execute as a fallback.
 */
export function apply(ctx, config = {}) {
  const patchBash = agent => {
    const bash = ctx.tools.get('bash', agent) ?? ctx.tools.get('bash');
    if (!bash) return;

    if (bash.parameters?.required && Array.isArray(bash.parameters.required)) {
      bash.parameters.required = bash.parameters.required.filter(key => key !== 'description');
    }

    if (!bash._descriptionRelaxed) {
      bash._descriptionRelaxed = true;
      const originalExecute = bash.execute;
      bash.execute = async function (args, exec) {
        const normalized = { ...args };
        if (typeof normalized.description !== 'string' || normalized.description.trim().length === 0) {
          normalized.description = typeof normalized.command === 'string' && normalized.command.trim()
            ? `Run: ${normalized.command.slice(0, 60)}`
            : 'Execute bash command';
        }
        return originalExecute.call(this, normalized, exec);
      };
    }
  };

  patchBash();
  ctx.on('tools/change', () => patchBash());

  // Hook tools/execute waterfall: populate description before dispatchToolBody runs tool.execute
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'bash') {
      patchBash(exec.agent);
      if (!exec.arguments?.description || typeof exec.arguments.description !== 'string' || !exec.arguments.description.trim()) {
        exec.arguments = {
          ...exec.arguments,
          description: typeof exec.arguments?.command === 'string' && exec.arguments.command.trim()
            ? `Run: ${exec.arguments.command.slice(0, 60)}`
            : 'Execute bash command',
        };
      }
    }
    return next();
  });

  // Retain config compatibility for existing profile overlays
  const interval = config.interval ?? 50;
  const unit = config.unit ?? 'steps';
  const compoundLimit = config.compoundLimit ?? DEFAULT_COMPOUND_LIMIT;
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('shell-reconsider: interval must be a positive integer.');
  if (!['steps', 'turns'].includes(unit)) throw new Error('shell-reconsider: unit must be steps or turns.');
  if (!Number.isSafeInteger(compoundLimit) || compoundLimit < 1) throw new Error('shell-reconsider: compoundLimit must be a positive integer.');
  const states = new WeakMap();
  const stateOf = session => {
    let state = states.get(session);
    if (!state) states.set(session, state = { ticks: 0, last: null, pending: null, permit: null, notices: new Map() });
    return state;
  };

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const state = stateOf(agent.session), key = unit === 'turns' ? turn : `${turn}:${step}`;
    if (state.turn !== turn) { state.turn = turn; state.pending = null; state.permit = null; }
    // Retries of the same request do not consume the interval again.
    if (key !== state.last) { state.last = key; state.ticks++; }
    return next();
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'bash') patchBash(exec.agent);
    // PTC subcalls cannot perform a separate model confirmation inside their program.
    if (exec.name !== 'bash' || !exec.agent || exec.parent || exec.signal.aborted) return next();
    const state = stateOf(exec.agent.session), key = fingerprint(exec.arguments);
    if (state.permit !== null) {
      const permitted = state.permit === key;
      state.permit = null; // A grant is single-use, not a general shell bypass.
      if (permitted) return next();
    }

    const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
    const check = classifyCommand(command, { compoundLimit });

    // Legitimate development commands (git, npm, build, test, python, etc.) pass straight through.
    if (!check) return next();

    // Destructive and oversized compound commands get the single-use permit
    // path; read/list/grep denials point at the native tool and need no permit.
    if (check.type === 'destructive' || check.type === 'compound') {
      state.pending = key;
      state.notices.set(exec.callId, { event: null, exposed: false });
      return { kind: 'deny', reason: check.reason };
    }

    // Read/list/grep operations: direct deny pointing to native tools (read, list, glob, grep).
    state.notices.set(exec.callId, { event: null, exposed: false });
    return { kind: 'deny', reason: check.reason };
  }, true);

  ctx.tools.register(defineTool({
    name: 'shell_reconsider',
    description: 'Answer a pending shell necessity check for a blocked destructive or oversized compound command. true allows one identical bash retry; false cancels it. No shell command is run by this tool.',
    parameters: { necessary: { type: 'boolean', required: true, description: 'Is shell necessary rather than a dedicated tool?' } },
    output: stringOutput,
    async execute({ necessary }, exec) {
      assertActive(exec);
      if (!exec.agent) throw new Error('An agent is required.');
      const state = stateOf(exec.agent.session);
      if (!state.pending) return 'No pending shell check.';
      state.permit = necessary ? state.pending : null;
      state.pending = null;
      return necessary ? 'true' : 'false';
    },
  }));

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return;
    const entry = states.get(session)?.notices.get(event.data.message.toolCallId);
    if (entry) entry.event = event;
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const state = states.get(agent.session);
    if (state) for (const [callId, entry] of state.notices) {
      if (!entry.event) continue;
      if (!entry.exposed) { entry.exposed = true; continue; }
      const event = entry.event;
      // Keep immutable audit history and tool-call pairing, but remove the instruction
      // from future model requests after the model has had one opportunity to see it.
      if (agent.session.surface.nodes.includes(event.seq)) agent.session.append('tool/result', {
        ...event.data,
        message: { ...event.data.message, content: [{ type: 'text', text: 'Shell was not executed.' }] },
      }, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
      state.notices.delete(callId);
    }
    return next();
  });
}
