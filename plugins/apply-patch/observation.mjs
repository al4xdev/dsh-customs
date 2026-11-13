const owners = new WeakMap();
const pending = new Map();
const edits = new Map();
function state(session) { let map = owners.get(session); if (!map) owners.set(session, map = new Map()); return map; }
export function observed(exec, target) { return exec.agent?.session ? state(exec.agent.session).get(target.targetKey) : undefined; }
export function snapshot(exec) { return new Map(exec.agent?.session ? state(exec.agent.session) : []); }
export function requireCoverage(exec, target, indices, full = false, entry = observed(exec, target)) {
  if (!entry || (!entry.full && (full || indices.some(i => !entry.lines.has(i + 1))))) throw new Error(`Read ${full ? 'the entire file' : 'the changed lines and context'} before editing ${target.displayPath}; observation is absent or insufficient.`);
  return entry;
}
// Observed lines (1-based) after splicing `changes` ({ index: 0-based, count, length }, ascending, disjoint)
// into the file: lines outside them still hold what was read, shifted; replaced lines are dropped; and the
// replacement lines were just written by this session, so their content is known too.
export function carryLines(lines, changes) {
  const out = new Set();
  for (const line of lines) {
    let at = line - 1, shift = 0, gone = false;
    for (const c of changes) { if (at >= c.index + c.count) shift += c.length - c.count; else { gone = at >= c.index; break; } }
    if (!gone) out.add(at + shift + 1);
  }
  let shift = 0;
  for (const c of changes) { for (let k = 0; k < c.length; k++) out.add(c.index + shift + k + 1); shift += c.length - c.count; }
  return out;
}
export function rememberMutation(exec, target, version, full, lines = new Set()) {
  if (exec.agent?.session) state(exec.agent.session).set(target.targetKey, { version, full, lines });
}
// Only an overwrite needs a prior read. `write` replaces a file with no context check at
// all, so it still requires the whole file read at its current version. An `edit` (and
// apply_patch, see index.mjs) must match its literal context exactly, which is the proof
// that the model knows what it replaces; demanding a `read` on top of that only forced a
// round trip after the model had looked through bash (372 refusals in 200 sessions) or
// pushed it to edit through python, past every guard.
async function guard(ctx, target, exec) {
  const info = await ctx.fs.stat(target, exec.signal);
  if (!info) {
    // The official listener would answer "edit requires reading ... first" for a file that
    // does not exist; say what is actually wrong. A write creates it (createIfAbsent).
    if (exec.name === 'edit') throw new Error(`cannot edit "${target.displayPath}": not found`);
    return undefined;
  }
  if (exec.name === 'write') {
    const entry = requireCoverage(exec, target, [], true);
    if (entry.version !== info.version) throw new Error(`File changed since reading ${target.displayPath}; read it again.`);
    return undefined;
  }
  const entry = observed(exec, target);
  const fresh = entry !== undefined && entry.version === info.version;
  edits.set(exec.token ?? exec, { fresh, changes: undefined });
  if (fresh && !entry.full) trackEdit(exec, await ctx.fs.readText(target, exec.signal));
  // The current version is the compare-and-swap basis: the provider still refuses the
  // edit if the file changes between this stat and its write.
  return { version: info.version };
}
// Line bookkeeping only (no refusal): carry what this session read across the edit, so a
// later partial read can still complete the full-file coverage that `write` needs.
function trackEdit(exec, text) {
  const old = String(exec.arguments?.old_string ?? '');
  if (!old) return;
  const count = old.split('\n').length, length = String(exec.arguments?.new_string ?? '').split('\n').length;
  const changes = [];
  let start = 0, scanned = 0, line = 0;
  while ((start = text.indexOf(old, start)) !== -1) {
    for (; scanned < start; scanned++) if (text[scanned] === '\n') line++;
    changes.push({ index: line, count, length });
    start += Math.max(1, old.length);
  }
  if (!changes.length) return;
  // Two matches sharing a line (replace_all) don't map line by line: carry nothing, as before.
  const disjoint = changes.every((c, i) => i === 0 || c.index >= changes[i - 1].index + changes[i - 1].count);
  edits.set(exec.token ?? exec, { fresh: true, changes: disjoint ? changes : undefined });
}
export const name = 'alex-file-observation-coverage';
export const inject = ['tools', 'fs'];
export function apply(ctx) {
  ctx.on('fs/observed', (target, observation, exec) => {
    if (!exec?.agent?.session) return;
    if (observation.kind !== 'present') { state(exec.agent.session).delete(target.targetKey); return; }
    pending.set(exec.token ?? exec, { target, version: observation.version });
  });
  ctx.on('tools/result', (exec, result) => {
    const item = pending.get(exec.token ?? exec);
    const edit = edits.get(exec.token ?? exec);
    pending.delete(exec.token ?? exec);
    edits.delete(exec.token ?? exec);
    if (!item || result.isError || !exec.agent?.session) return;
    const map = state(exec.agent.session);
    if (exec.name === 'read') {
      const value = result.value;
      if (!value?.lines) return;
      let entry = map.get(item.target.targetKey);
      if (!entry || entry.version !== item.version) entry = { version: item.version, full: false, lines: new Set() };
      for (const line of value.lines) if (!line.text.includes('... (line truncated to ')) entry.lines.add(line.number);
      entry.full = entry.lines.size === value.totalLines;
      map.set(item.target.targetKey, entry);
    } else if (exec.name === 'write') {
      rememberMutation(exec, item.target, item.version, true);
    } else if (exec.name === 'edit') {
      // What was read survives the edit only if it was read at the version edited; an
      // edit made without (or after a stale) read leaves the rest of the file unseen.
      const before = edit?.fresh ? map.get(item.target.targetKey) : undefined;
      const full = before?.full === true;
      rememberMutation(exec, item.target, item.version, full, !full && before && edit.changes ? carryLines(before.lines, edit.changes) : undefined);
    }
  });
  // Prepended so this coverage layer wraps the official fs-observation-policy listener, which
  // never calls next() and supplies the provider's atomic version guard. An edit stops here
  // with its own guard: the official listener refuses any edit of a file not read first.
  for (const event of ['fs/write-intent', 'fs/edit-intent']) ctx.on(event, async (target, exec, next) => {
    if (exec?.name === 'edit') {
      const intent = await guard(ctx, target, exec);
      return intent ?? next();
    }
    if (exec?.name === 'write') await guard(ctx, target, exec);
    return next();
  }, true);
}
