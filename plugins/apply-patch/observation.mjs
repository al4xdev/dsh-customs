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
async function guard(ctx, target, exec) {
  const info = await ctx.fs.stat(target, exec.signal);
  if (!info) return;
  const entry = requireCoverage(exec, target, [], exec.name === 'write');
  if (entry.version !== info.version) throw new Error(`File changed since reading ${target.displayPath}; read it again.`);
  if (exec.name !== 'edit' || entry.full) return;
  const text = await ctx.fs.readText(target, exec.signal), old = String(exec.arguments?.old_string ?? '');
  if (!old) throw new Error('Edit context is empty.');
  const count = old.split('\n').length, length = String(exec.arguments?.new_string ?? '').split('\n').length;
  const changes = [];
  let start = 0, scanned = 0, line = 0, found = false;
  while ((start = text.indexOf(old, start)) !== -1) {
    for (; scanned < start; scanned++) if (text[scanned] === '\n') line++;
    found = true;
    requireCoverage(exec, target, Array.from({ length: count }, (_, i) => line + i));
    changes.push({ index: line, count, length });
    start += Math.max(1, old.length);
  }
  if (!found) throw new Error('Edit context not found; read the relevant file content again.');
  // Two matches sharing a line (replace_all) don't map line by line: carry nothing, as before.
  const disjoint = changes.every((c, i) => i === 0 || c.index >= changes[i - 1].index + changes[i - 1].count);
  edits.set(exec.token ?? exec, disjoint ? changes : undefined);
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
    const changes = edits.get(exec.token ?? exec);
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
    } else if (exec.name === 'write' || exec.name === 'edit') {
      const before = map.get(item.target.targetKey);
      const full = exec.name === 'write' || before?.full === true;
      rememberMutation(exec, item.target, item.version, full, !full && before && changes ? carryLines(before.lines, changes) : undefined);
    }
  });
  // Prepended so this coverage layer wraps the official fs-observation-policy listener, which
  // never calls next() and supplies the provider's atomic version guard.
  for (const event of ['fs/write-intent', 'fs/edit-intent']) ctx.on(event, async (target, exec, next) => {
    if (exec?.name === 'write' || exec?.name === 'edit') await guard(ctx, target, exec);
    return next();
  }, true);
}
