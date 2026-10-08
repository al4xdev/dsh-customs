import { mkdtemp, chmod, writeFile, readFile } from 'node:fs/promises';

import { join, relative, isAbsolute, sep } from 'node:path';
import { defineTool, cwdOf, assertActive, resolveHost } from '../common.mjs';
import { parsePatch, applyChunks } from './parser.mjs';
import { requireCoverage, rememberMutation, snapshot } from './observation.mjs';
import { checkedSource, trashOne } from '../trash/index.mjs';
import { patchCallView, patchMeta, patchResultView, undoCallView, undoMeta, undoResultView } from './presentation.mjs';
const { writableRoots, sandboxDenialMarker } = await import(resolveHost('@deepseek-ai/dsh-sandbox'));
export const name = 'alex-apply-patch';
export const inject = ['tools', 'fs', 'sandboxPolicy'];
const receipts = new Map(), locks = new Map();
function sessionPolicy(ctx, exec) {
  const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
  if (policy.mode !== 'danger-full-access' && policy.mode !== 'workspace-write') throw new Error(`Access denied: ${sandboxDenialMarker(policy.mode)} apply_patch cannot modify files in this mode.`);
  return policy;
}
function permit(policy, target) {
  if (policy.mode === 'danger-full-access') return;
  for (const root of writableRoots(policy)) {
    const path = relative(root, String(target.targetKey));
    if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
  }
  throw new Error(`Access denied: ${sandboxDenialMarker(policy.mode)} ${target.displayPath} is outside the writable roots; apply_patch has no escalation (use edit/write with sandbox_permissions).`);
}
async function resolveTarget(ctx, path, exec, policy) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error(`Invalid path: ${JSON.stringify(path)}`);
  const cwd = cwdOf(exec);
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal });
  permit(policy, target);
  const entry = await ctx.fs.lstat(path, { cwd }, exec.signal);
  if (entry && entry.type !== 'file') throw new Error(`Invalid path: patch target must be a regular file, not a ${entry.type}: ${target.displayPath}`);
  return target;
}
async function versionOf(ctx, target) {
  // Deliberately not cancellable: failure classification must still observe the paths after an abort.
  try { return (await ctx.fs.stat(target))?.version ?? null; } catch { return undefined; }
}
async function assertVersion(ctx, target, version, exec) {
  if (await versionOf(ctx, target) !== version) throw new Error(`Conflict: ${target.displayPath} changed since it was read; read it again and rebuild the patch.`);
}
async function exclusive(keys, fn) {
  // All keys are claimed synchronously, so waiters always queue behind earlier claims: no deadlock.
  const { promise, resolve } = Promise.withResolvers();
  const prior = [...new Set(keys)].map(key => { const previous = locks.get(key); locks.set(key, promise); return previous; });
  await Promise.all(prior);
  try { return await fn(); } finally { resolve(); for (const key of keys) if (locks.get(key) === promise) locks.delete(key); }
}
function recordWrite(ctx, target, exec, version, full) {
  ctx.emit('fs/observed', target, { kind: 'present', version }, exec);
  rememberMutation(exec, target, version, full);
}
async function prepare(ctx, { operation, target, destination }, view, exec) {
  if (operation.kind === 'add') {
    if (await versionOf(ctx, target) !== null) throw new Error(`Conflict: Add target already exists: ${target.displayPath}`);
    return { operation, target, after: operation.content };
  }
  const full = operation.kind === 'delete' || !!destination;
  const entry = requireCoverage(exec, target, [], full, view.get(target.targetKey));
  await assertVersion(ctx, target, entry.version, exec);
  const before = await ctx.fs.readText(target, exec.signal);
  await assertVersion(ctx, target, entry.version, exec);
  let change = { after: '' };
  if (operation.kind === 'update') {
    try { change = applyChunks(before, operation.chunks); } catch (e) { throw new Error(`Context not found in ${target.displayPath}: ${e.message}`); }
    if (!full) requireCoverage(exec, target, change.covered, false, entry);
  }
  if (full) await checkedSource(target.displayPath, cwdOf(exec), { ctx, exec });
  if (destination && await versionOf(ctx, destination) !== null) throw new Error(`Conflict: Move destination exists: ${destination.displayPath}`);
  return { operation, target, destination, before, after: change.after, version: entry.version, full: entry.full };
}
async function settle(ctx, plan, record, exec) {
  const source = await versionOf(ctx, plan.target);
  const output = plan.destination ? await versionOf(ctx, plan.destination) : source;
  const written = record.version !== undefined && output === record.version;
  if (plan.operation.kind === 'add') return source === null ? 'unchanged' : written ? 'changed' : 'uncertain';
  if (!plan.destination && plan.operation.kind === 'update') return source === plan.version ? 'unchanged' : written ? 'changed' : 'uncertain';
  // Removal never edits the source: a present source was not removed, whatever its version now.
  const present = typeof source === 'string', removed = source === null && !!record.trash;
  if (plan.operation.kind === 'delete') return present ? 'unchanged' : removed ? 'changed' : 'uncertain';
  if (output === null && present) return 'unchanged';
  return written && present ? 'partial' : written && removed ? 'changed' : 'uncertain';
}
async function publish(ctx, plans, exec, policy) {
  const directory = await mkdtemp('/tmp/alex-dsh-patch-'); await chmod(directory, 0o700);
  const manifest = join(directory, 'manifest.json');
  const receipt = { manifest, atomic: false, status: 'applying', operations: [] };
  const save = () => writeFile(manifest, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  const note = error => { receipt.manifest_error = error.message; };
  await save();
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i], kind = plan.operation.kind;
    const record = { kind, path: plan.target.displayPath, status: 'prepared', full: kind === 'add' || !!plan.full };
    if (kind !== 'delete') record.output = (plan.destination ?? plan.target).displayPath;
    if (plan.destination) record.move = true;
    receipt.operations.push(record);
    try {
      assertActive(exec);
      if (plan.before !== undefined) {
        record.backup = join(directory, `${i}.original`);
        await writeFile(record.backup, plan.before, { flag: 'wx', mode: 0o600 });
      }
      await save();
      if (kind !== 'delete') {
        const output = plan.destination ?? plan.target;
        const intent = kind === 'add' || plan.destination ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: plan.version };
        const outcome = await ctx.fs.writeText(output, plan.after, intent, exec.signal, policy);
        record.version = outcome.version; record.status = 'written';
        recordWrite(ctx, output, exec, outcome.version, record.full);
      }
      if (kind === 'delete' || plan.destination) {
        await assertVersion(ctx, plan.target, plan.version, exec);
        record.trash = await trashOne(plan.target.displayPath, cwdOf(exec), exec.signal, { ctx, exec, expectedVersion: plan.version });
        ctx.emit('fs/observed', plan.target, { kind: 'absent' }, exec);
      }
      record.status = 'applied'; record.state = 'changed';
    } catch (error) {
      record.error = error.message; if (error.trash) record.trash_failure = error.trash;
      record.state = await settle(ctx, plan, record, exec);
      receipt.not_attempted = plans.slice(i + 1).map(p => p.target.displayPath);
      break;
    }
    await save().catch(note);
  }
  const failed = receipt.operations.find(r => r.error);
  if (failed?.state === 'unchanged' && receipt.operations.length === 1) {
    receipt.status = 'not_applied'; await save().catch(note);
    throw new Error(failed.error);
  }
  receipts.set(manifest, { receipt, session: exec.agent?.session });
  receipt.status = failed ? 'partial_failure' : 'applied';
  await save().catch(note);
  return JSON.stringify(receipt);
}
export async function executePatch(ctx, patch, exec) {
  // Any thrown error means nothing was published; partial outcomes are returned as receipts.
  try { return await runPatch(ctx, patch, exec); } catch (error) { throw new Error(`Patch not applied; no file changed. ${error.message}`, { cause: error }); }
}
async function runPatch(ctx, patch, exec) {
  assertActive(exec);
  // Observations are captured at call time: a concurrent patch from this session cannot refresh them.
  const view = snapshot(exec), policy = sessionPolicy(ctx, exec);
  let operations;
  try { operations = parsePatch(patch); } catch (e) { throw new Error(`Invalid patch format: ${e.message}`); }
  const resolved = [], seen = new Set();
  for (const operation of operations) {
    const target = await resolveTarget(ctx, operation.path, exec, policy);
    const destination = operation.move ? await resolveTarget(ctx, operation.move, exec, policy) : undefined;
    for (const { targetKey } of destination ? [target, destination] : [target]) {
      if (seen.has(targetKey)) throw new Error('Invalid path: patch aliases/duplicate paths overlap; split into separate calls.');
      seen.add(targetKey);
    }
    resolved.push({ operation, target, destination });
  }
  return exclusive([...seen], async () => {
    assertActive(exec);
    const plans = [];
    for (const item of resolved) plans.push(await prepare(ctx, item, view, exec));
    return publish(ctx, plans, exec, policy);
  });
}
async function undoOne(ctx, record, exec, policy) {
  const undo = record.undo ?? {};
  const original = await resolveTarget(ctx, record.path, exec, policy);
  const output = record.output === undefined ? undefined : await resolveTarget(ctx, record.output, exec, policy);
  const recreate = record.kind === 'delete' || (record.move && record.state === 'changed' && !undo.original_restored);
  const conflict = message => Object.assign(new Error(message), { conflict: true });
  try {
    if (output && await versionOf(ctx, output) !== record.version) throw conflict('File changed after the patch; undo refuses to overwrite newer work.');
    if (recreate) {
      if (await versionOf(ctx, original) !== null) throw conflict('Original path was recreated after the patch; undo refuses to overwrite it.');
      const outcome = await ctx.fs.writeText(original, await readFile(record.backup, 'utf8'), { kind: 'createIfAbsent' }, exec.signal, policy);
      recordWrite(ctx, original, exec, outcome.version, true);
      undo.original_restored = true;
    }
    if (record.kind === 'add' || record.move) {
      undo.trash = await trashOne(output.displayPath, cwdOf(exec), exec.signal, { ctx, exec, expectedVersion: record.version });
      ctx.emit('fs/observed', output, { kind: 'absent' }, exec);
    } else if (record.kind === 'update') {
      const outcome = await ctx.fs.writeText(output, await readFile(record.backup, 'utf8'), { kind: 'replaceIfVersion', version: record.version }, exec.signal, policy);
      recordWrite(ctx, output, exec, outcome.version, record.full);
    }
    return { ...undo, state: 'restored', error: undefined };
  } catch (error) {
    // Classify by re-observing the paths, not by assuming where the failure happened.
    const settled = { ...undo, error: error.message, state: undo.original_restored ? 'partial' : 'not_restored' };
    if (error.conflict) return settled;
    const outputKept = !output || await versionOf(ctx, output) === record.version;
    const originalKept = !recreate || undo.original_restored || error.code === 'FS_NOT_OBSERVED' || await versionOf(ctx, original) === null;
    return outputKept && originalKept ? settled : { ...settled, state: 'uncertain' };
  }
}
export async function undoPatch(ctx, manifest, exec) {
  assertActive(exec);
  const policy = sessionPolicy(ctx, exec);
  // Only receipts created by this runtime/session are accepted; no arbitrary manifest execution.
  const entry = receipts.get(manifest);
  if (!entry || entry.session !== exec.agent?.session) throw new Error('Unknown recovery receipt for this session/runtime; use the saved mapping for manual recovery after restart.');
  const { receipt } = entry;
  const cwd = cwdOf(exec);
  const keys = [];
  for (const record of receipt.operations) for (const path of [record.path, record.output]) if (path) keys.push(String((await ctx.fs.resolve(path, { cwd, signal: exec.signal })).targetKey));
  return exclusive(keys, async () => {
    for (const record of receipt.operations.toReversed()) {
      if (record.undo?.state === 'restored' || !record.state || record.state === 'unchanged') continue;
      if (record.state === 'uncertain' || record.undo?.state === 'uncertain') { record.undo = { ...record.undo, state: record.undo?.state ?? 'not_restored', error: record.undo?.error ?? 'Patch outcome was uncertain; recover manually from the backup or trash entry.' }; continue; }
      if (exec.signal?.aborted) { record.undo = { ...record.undo, state: record.undo?.state ?? 'not_attempted', error: 'Canceled' }; continue; }
      record.undo = await undoOne(ctx, record, exec, policy).catch(error => ({ ...record.undo, state: 'not_restored', error: error.message }));
    }
    const pending = receipt.operations.filter(r => r.state && r.state !== 'unchanged' && r.undo?.state !== 'restored');
    receipt.status = pending.length ? 'partial_undo' : 'undone';
    await writeFile(manifest, JSON.stringify(receipt, null, 2), { mode: 0o600 }).catch(error => { receipt.manifest_error = error.message; });
    return JSON.stringify(receipt);
  });
}
// The model still receives the untouched receipt text; the extra output hooks
// only tell a capable UI to render the change as a native diff card.
const receiptOutput = meta => ({
  schema: { type: 'string' },
  render: (_args, text) => [{ type: 'text', text }],
  presentationMeta: (args, text) => meta(args, text),
});
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'apply_patch', description: 'Apply Codex-format contextual patches to observed text files. Exact context only. Preflighted but NOT multi-file atomic. Returns a recovery receipt with per-file state (changed/unchanged/partial/uncertain).',
    parameters: { patch: { type: 'string', required: true, description: 'Read changed lines first; read entire files before moving/deleting. Example: *** Begin Patch\n*** Update File: path\n@@\n-old text\n+new text\n*** End Patch\n\nEach line starts with one marker (space, -, +); everything AFTER it is literal. -text matches text; - text matches a line beginning with a space. Preserve original indentation; do not add a space after - or + unless the file has it.' } },
    output: receiptOutput(patchMeta), presentCall: patchCallView, presentResult: patchResultView,
    execute: ({ patch }, exec) => executePatch(ctx, patch, exec) }));
  ctx.tools.register(defineTool({ name: 'apply_patch_undo', description: 'Undo a patch receipt from this session/runtime without overwriting post-patch edits. May partially succeed; returns per-file undo state (restored/not_restored/partial/uncertain).',
    parameters: { manifest: { type: 'string', required: true, description: 'Recovery manifest path returned by apply_patch.' } },
    output: receiptOutput(undoMeta), presentCall: undoCallView, presentResult: undoResultView,
    execute: ({ manifest }, exec) => undoPatch(ctx, manifest, exec) }));
}
