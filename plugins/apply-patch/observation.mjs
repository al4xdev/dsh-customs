const owners = new WeakMap();
const pending = new Map();
function state(session) { let map = owners.get(session); if (!map) owners.set(session, map = new Map()); return map; }
export function observed(exec, target) { return exec.agent?.session ? state(exec.agent.session).get(target.targetKey) : undefined; }
export function snapshot(exec) { return new Map(exec.agent?.session ? state(exec.agent.session) : []); }
export function requireCoverage(exec, target, indices, full = false, entry = observed(exec, target)) {
  if (!entry || (!entry.full && (full || indices.some(i => !entry.lines.has(i + 1))))) throw new Error(`Read ${full ? 'the entire file' : 'the changed lines and context'} before editing ${target.displayPath}; observation is absent or insufficient.`);
  return entry;
}
export function rememberMutation(exec, target, version, full) {
  if (exec.agent?.session) state(exec.agent.session).set(target.targetKey, { version, full, lines: new Set() });
}
async function guard(ctx, target, exec) {
  const info = await ctx.fs.stat(target, exec.signal);
  if (!info) return;
  const entry = requireCoverage(exec, target, [], exec.name === 'write');
  if (entry.version !== info.version) throw new Error(`File changed since reading ${target.displayPath}; read it again.`);
  if (exec.name !== 'edit' || entry.full) return;
  const text = await ctx.fs.readText(target, exec.signal), old = String(exec.arguments?.old_string ?? '');
  if (!old) throw new Error('Edit context is empty.');
  const count = old.split('\n').length;
  let start = 0, scanned = 0, line = 0, found = false;
  while ((start = text.indexOf(old, start)) !== -1) {
    for (; scanned < start; scanned++) if (text[scanned] === '\n') line++;
    found = true;
    requireCoverage(exec, target, Array.from({ length: count }, (_, i) => line + i));
    start += Math.max(1, old.length);
  }
  if (!found) throw new Error('Edit context not found; read the relevant file content again.');
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
    pending.delete(exec.token ?? exec);
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
      const full = exec.name === 'write' || map.get(item.target.targetKey)?.full === true;
      rememberMutation(exec, item.target, item.version, full);
    }
  });
  // Prepended so this coverage layer wraps the official fs-observation-policy listener, which
  // never calls next() and supplies the provider's atomic version guard.
  for (const event of ['fs/write-intent', 'fs/edit-intent']) ctx.on(event, async (target, exec, next) => {
    if (exec?.name === 'write' || exec?.name === 'edit') await guard(ctx, target, exec);
    return next();
  }, true);
}
