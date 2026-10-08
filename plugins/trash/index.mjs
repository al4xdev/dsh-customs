import { access, chmod, constants, lstat, lutimes, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rmdir, statfs, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defineTool, stringOutput, cwdOf, assertActive, resolveHost } from '../common.mjs';
const dshPackage = '/home/alex/.local/share/dsh-cli/package.json';
const { writableRoots, sandboxDenialMarker } = await import(resolveHost('@deepseek-ai/dsh-sandbox'));
export const name = 'alex-trash';
export const inject = ['tools', 'sandboxPolicy'];
const recoveryBase = '/tmp';
const home = homedir();
const broadTargets = new Set([home, ...['.cache', '.cargo', '.config', '.dsh', '.dsh/profiles', '.dsh/sessions', '.dsh/storages', '.gnupg', '.local', '.local/bin', '.local/share', '.local/state',
  '.mozilla', '.npm', '.nvm', '.pki', '.rustup', '.ssh', '.var', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos', 'git', 'git/my', 'snap'].map(p => join(home, p))]);
const sealedTrees = [join(home, '.ssh'), join(home, '.gnupg'), join(home, '.dsh', 'dsh-auth'), dirname(dshPackage)];
const { O_RDONLY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_EXCL, R_OK, W_OK, X_OK } = constants;
const under = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const present = path => lstat(path).then(() => true, () => false);
const times = st => [Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9];
const mib = n => `${(n / 2 ** 20).toFixed(1)} MiB`;
const kindOf = st => st.isFile() ? 'file' : st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'FIFO' : st.isSocket() ? 'socket' : 'device file';
const changed = (a, b) => a.dev !== b.dev || a.ino !== b.ino || a.mode !== b.mode || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs;
const unmoved = original => ({ original, recovery: null, manifest: null, status: 'failed', copy_fallback: false });
const failure = (message, record) => Object.assign(new Error(message), { trash: record });
const policyOf = (ctx, exec) => ctx.sandboxPolicy.resolve(exec?.agent ? { session: exec.agent.session } : {});
export function requireFullAccess(ctx, exec) {
  const policy = policyOf(ctx, exec);
  if (policy.mode === 'danger-full-access' || policy.mode === 'workspace-write') return policy;
  throw new Error(`${sandboxDenialMarker(policy.mode)} Removal is not allowed under ${policy.mode} mode; trash needs workspace-write (session workspace and /tmp only) or danger-full-access.`);
}
function assertSandboxAllows(policy, paths) {
  if (policy.mode === 'danger-full-access') return;
  const roots = policy.workspaceRoot ? writableRoots(policy) : [];
  for (const path of paths) if (!roots.some(root => under(path, root))) throw new Error(`${sandboxDenialMarker(policy.mode)} trash may only modify paths under ${roots.join(', ') || 'no writable root'}; ${path} is outside.`);
}
async function assertRemovable(parent, info) {
  try { await access(parent, W_OK | X_OK); } catch (e) { throw new Error(`Permission denied: cannot remove entries from ${parent} (${e.code}).`); }
  const uid = process.getuid(), dir = await lstat(parent);
  if (uid !== 0 && dir.mode & 0o1000 && dir.uid !== uid && info.uid !== uid) throw new Error(`Permission denied: ${parent} is sticky and the entry belongs to another user.`);
}
async function anchorsOf(cwd, options) {
  const roots = [cwd];
  if (options?.ctx) roots.push(policyOf(options.ctx, options.exec).workspaceRoot, options.ctx.sandboxPolicy.workspaceRoot);
  const anchors = [];
  for (const root of roots) if (typeof root === 'string' && root) anchors.push(resolve(root), await realpath(root).catch(() => resolve(root)));
  return anchors;
}
function protectionReason(path, anchors) {
  if (dirname(path) === '/') return 'filesystem root or top-level directory';
  if (dirname(path) === '/home' || broadTargets.has(path)) return 'home or broad user directory';
  if (sealedTrees.some(root => under(path, root))) return 'credential or DSH installation directory';
  if (anchors.some(anchor => under(anchor, path))) return 'working directory, session workspace or one of their ancestors';
}
export async function checkedSource(input, cwd, options) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw failure('Source path must be a non-empty explicit path.', unmoved(null));
  const lexical = resolve(cwd, input), anchors = await anchorsOf(cwd, options);
  const guard = path => { const reason = protectionReason(path, anchors); if (reason) throw failure(`Protected broad target: ${path} (${reason}).`, unmoved(path)); };
  guard(lexical);
  let parent, info;
  try { parent = await realpath(dirname(lexical)); }
  catch (e) { throw failure(['ENOENT', 'ENOTDIR'].includes(e.code) ? `Source not found: ${lexical}` : `Cannot resolve parent of ${lexical} (${e.code ?? e.message}).`, unmoved(lexical)); }
  // Resolve parents, not the last component: trashing a symlink must preserve its target.
  const source = join(parent, basename(lexical));
  guard(source);
  try { info = await lstat(source); }
  catch (e) { throw failure(e.code === 'ENOENT' ? `Source not found: ${source}` : `Cannot inspect ${source} (${e.code ?? e.message}).`, unmoved(source)); }
  if (/(\/\.?)+$/.test(input)) {
    if (info.isSymbolicLink()) throw failure(`Ambiguous trailing slash on symlink ${source}: omit the slash to trash the link itself, or pass the target's real path.`, unmoved(source));
    if (!info.isDirectory()) throw failure(`Not a directory: ${source}`, unmoved(source));
  }
  if (info.isDirectory()) {
    if (await present(join(source, '.git'))) throw failure(`Protected broad target: ${source} (git worktree root).`, unmoved(source));
    if ((await lstat(parent)).dev !== info.dev) throw failure(`Refusing mount point: ${source}.`, unmoved(source));
  }
  return source;
}
// Path-based checks are bounded hardening, not atomic fd-relative safety: an
// attacker can still change topology in the residual check-to-syscall window.
async function snapshotAncestors(path) {
  const entries = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const st = await lstat(parent, { bigint: true });
    entries.push({ path: parent, dev: st.dev, ino: st.ino, mode: st.mode, real: await realpath(parent) });
    if (parent === dirname(parent)) break;
  }
  return entries;
}
async function revalidateAncestors(entries) {
  for (const entry of entries) {
    const st = await lstat(entry.path, { bigint: true }).catch(() => undefined);
    if (!st || st.dev !== entry.dev || st.ino !== entry.ino || st.mode !== entry.mode || await realpath(entry.path).catch(() => undefined) !== entry.real)
      throw new Error(`Ancestor topology changed: ${entry.path}; removal refused.`);
  }
}
async function planTree(root, rootStat) {
  const entries = [], uid = BigInt(process.getuid());
  async function visit(rel, st, parentStat) {
    const path = rel ? join(root, rel) : root, type = kindOf(st);
    if (!['file', 'directory', 'symlink'].includes(type)) throw new Error(`Cannot copy ${type} ${path} across filesystems.`);
    if (st.dev !== rootStat.dev) throw new Error(`Refusing to copy across nested mount point ${path}.`);
    if (parentStat && uid !== 0n && parentStat.mode & 0o1000n && parentStat.uid !== uid && st.uid !== uid) throw new Error(`Permission denied: cannot remove ${path} from a sticky directory.`);
    const entry = { rel, type, stat: st, ancestors: await snapshotAncestors(path) };
    entries.push(entry);
    if (type === 'symlink') entry.link = await readlink(path);
    if (type === 'file') await access(path, R_OK).catch(e => { throw new Error(`Permission denied reading ${path} (${e.code}).`); });
    if (type !== 'directory') return;
    await access(path, R_OK | W_OK | X_OK).catch(e => { throw new Error(`Permission denied: cannot copy and empty ${path} (${e.code}).`); });
    entry.names = (await readdir(path)).sort();
    for (const name of entry.names) await visit(rel ? join(rel, name) : name, await lstat(join(path, name), { bigint: true }), st);
  }
  await visit('', rootStat);
  return entries;
}
async function checkSpace(directory, entries) {
  const fs = await statfs(directory), block = fs.bsize || 4096;
  const need = entries.reduce((n, e) => n + block + (e.type === 'file' ? Math.ceil(Number(e.stat.size) / block) * block : 0), 0);
  const available = fs.bavail * fs.bsize, reserve = Math.max(64 * 2 ** 20, Math.round(fs.blocks * fs.bsize * 0.05));
  if (need + reserve > available) throw new Error(`Not enough free space in ${recoveryBase} for a verified copy: need ${mib(need)} plus ${mib(reserve)} reserve, ${mib(available)} free.`);
}
async function hashFile(path, signal) {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
async function copyEntry(from, to, entry, signal) {
  if (entry.type === 'directory') return mkdir(to, { mode: 0o700 });
  if (entry.type === 'symlink') { await symlink(entry.link, to); return lutimes(to, ...times(entry.stat)); }
  const input = await open(from, O_RDONLY | O_NOFOLLOW);
  try {
    if (changed(await input.stat({ bigint: true }), entry.stat)) throw new Error(`Source changed during copy: ${from}.`);
    const output = await open(to, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    try {
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1 << 20);
      let total = 0;
      for (let n; (n = (await input.read(buffer, 0, buffer.length, null)).bytesRead);) {
        signal?.throwIfAborted();
        hash.update(buffer.subarray(0, n));
        for (let offset = 0; offset < n;) { signal?.throwIfAborted(); offset += (await output.write(buffer, offset, n - offset)).bytesWritten; }
        total += n;
      }
      if (total !== Number(entry.stat.size)) throw new Error(`Source changed during copy: ${from}.`);
      entry.sha256 = hash.digest('hex');
      await output.chmod(Number(entry.stat.mode) & 0o7777);
      await output.utimes(...times(entry.stat));
    } finally { await output.close(); }
  } finally { await input.close(); }
}
async function copyAcross(source, recovery, before, record, save, signal, onStep, validate) {
  const entries = await planTree(source, before);
  await checkSpace(dirname(recovery), entries);
  const at = (root, entry) => entry.rel ? join(root, entry.rel) : root;
  const uid = BigInt(process.getuid()), gid = BigInt(process.getgid());
  Object.assign(record, { status: 'copying', entries: entries.length, bytes: entries.reduce((n, e) => n + (e.type === 'file' ? Number(e.stat.size) : 0), 0),
    metadata_not_preserved: ['extended attributes/ACLs', 'inode change/birth times',
      ...entries.some(e => e.type === 'file' && e.stat.nlink > 1n) ? ['hard links (copied as separate files)'] : [],
      ...entries.some(e => e.stat.uid !== uid || e.stat.gid !== gid) ? ['ownership (copy belongs to the current user)'] : []] });
  await save();
  for (const entry of entries) {
    signal?.throwIfAborted();
    await validate();
    await revalidateAncestors(entry.ancestors);
    entry.recoveryAncestors = await snapshotAncestors(at(recovery, entry));
    await revalidateAncestors(entry.recoveryAncestors);
    await copyEntry(at(source, entry), at(recovery, entry), entry, signal);
    await onStep?.('copied', entry.rel);
  }
  for (const entry of entries) {
    const path = at(recovery, entry), st = await lstat(path);
    const ok = kindOf(st) === entry.type && (entry.type !== 'file' || st.size === Number(entry.stat.size) && await hashFile(path, signal) === entry.sha256)
      && (entry.type !== 'symlink' || await readlink(path) === entry.link) && (entry.type !== 'directory' || same((await readdir(path)).sort(), entry.names));
    if (!ok) throw new Error(`Copy verification failed at ${path}.`);
  }
  record.copy_verified = true;
  for (const entry of entries.toReversed()) if (entry.type === 'directory') {
    await validate();
    await revalidateAncestors(entry.recoveryAncestors);
    await chmod(at(recovery, entry), Number(entry.stat.mode) & 0o7777);
    await validate();
    await revalidateAncestors(entry.recoveryAncestors);
    await utimes(at(recovery, entry), ...times(entry.stat));
  }
  for (const entry of entries) {
    const path = at(source, entry), now = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!now || changed(now, entry.stat) || entry.type === 'directory' && !same((await readdir(path)).sort(), entry.names)) throw new Error(`Source changed during copy: ${path}.`);
  }
  record.status = 'removing_source';
  await save();
  const order = entries.toReversed();
  let removed = 0;
  try {
    for (const entry of order) {
      signal?.throwIfAborted();
      await onStep?.('removing', entry.rel);
      const path = at(source, entry), now = await lstat(path, { bigint: true });
      if (entry.type === 'directory' ? now.ino !== entry.stat.ino || now.dev !== entry.stat.dev : changed(now, entry.stat)) throw new Error(`Source entry changed before removal: ${path}`);
      await validate();
      await revalidateAncestors(entry.ancestors);
      await (entry.type === 'directory' ? rmdir(path) : unlink(path));
      removed++;
    }
  } catch (error) {
    Object.assign(record, { removed_entries: removed, remaining_entries: order.length - removed, remaining_sample: order.slice(removed, removed + 5).map(e => at(source, e)) });
    throw Object.assign(error, { stage: 'remove' });
  }
}
async function settleFailure(error, record, directory, save, recoveryAncestors) {
  const reason = error.message;
  record.error = reason;
  const leftovers = (await readdir(directory).catch(() => ['?'])).filter(name => name !== 'manifest.json');
  if (!leftovers.length) {
    await revalidateAncestors(recoveryAncestors);
    await unlink(record.manifest).catch(() => {});
    await revalidateAncestors(recoveryAncestors);
    if (await rmdir(directory).then(() => true, () => false)) return failure(`${reason} Source retained; nothing was moved.`, { ...record, status: 'failed', recovery: null, manifest: null });
  }
  let message;
  if (error.stage === 'remove' && record.removed_entries) {
    record.status = 'source_partially_removed';
    message = `Source partially removed after a verified copy: ${record.removed_entries} of ${record.entries} entries removed, ${record.remaining_entries} remain (e.g. ${record.remaining_sample.join(', ')}). Full verified copy: ${record.recovery}. Manifest: ${record.manifest}. Cause: ${reason}`;
  } else {
    record.status = record.copy_fallback ? 'copy_aborted' : 'failed';
    record.source_retained = true;
    message = `${reason} Source retained intact; ${record.copy_verified ? 'a complete verified' : 'an unverified, possibly partial'} copy is kept at ${record.recovery} (manifest ${record.manifest}), needed only if the source is lost.`;
  }
  await save().catch(() => {});
  return failure(message, { ...record });
}
const label = source => basename(source).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'item';
export async function trashOne(input, cwd, signal, options) {
  const policy = options?.ctx ? requireFullAccess(options.ctx, options.exec) : undefined;
  const source = await checkedSource(input, cwd, options);
  // checkedSource returned a canonical parent: do not adopt a swap before snapshotting it.
  if (await realpath(dirname(source)) !== dirname(source)) throw failure('Ancestor topology changed before preparation; removal refused.', unmoved(source));
  const sourceAncestors = [...await snapshotAncestors(resolve(cwd, input)), ...await snapshotAncestors(source)];
  // A patch/undo removal must retain its caller's observation, not adopt a newer source.
  const assertExpected = async () => {
    if (options?.expectedVersion === undefined) return;
    if (!options.ctx?.fs) throw new Error('Expected-version removal requires the DSH filesystem service.');
    const target = await options.ctx.fs.resolve(source, { cwd, signal });
    if ((await options.ctx.fs.stat(target, signal))?.version !== options.expectedVersion) throw new Error('Conflict: source changed since the patch observation; removal refused.');
  };
  let before;
  try {
    await assertExpected();
    if (policy) assertSandboxAllows(policy, [dirname(source), await realpath(recoveryBase)]);
    signal?.throwIfAborted();
    before = await lstat(source, { bigint: true });
    await assertRemovable(dirname(source), await lstat(source));
  } catch (e) { throw failure(e.message, unmoved(source)); }
  let directory;
  try { directory = await mkdtemp(join(recoveryBase, `alex-dsh-trash-${label(source)}-`)); await chmod(directory, 0o700); }
  catch (e) { if (directory) await rmdir(directory).catch(() => {}); throw failure(`Cannot create a private recovery directory under ${recoveryBase}: ${e.message}. Source retained; nothing was moved.`, unmoved(source)); }
  const recovery = join(directory, 'item'), manifest = join(directory, 'manifest.json');
  const record = { original: source, recovery, manifest, status: 'prepared', type: kindOf(before), method: 'rename', copy_fallback: false, temporary: true, created: new Date().toISOString() };
  const recoveryAncestors = await snapshotAncestors(recovery);
  const validate = async () => { await revalidateAncestors(sourceAncestors); await revalidateAncestors(recoveryAncestors); };
  const save = async flag => { await revalidateAncestors(recoveryAncestors); await writeFile(manifest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag }); };
  try {
    await save('wx');
    signal?.throwIfAborted();
    if (changed(await lstat(source, { bigint: true }), before)) throw new Error('Source changed before move; re-inspect it.');
    if (await present(recovery)) throw new Error(`Recovery path unexpectedly exists: ${recovery}`);
    await assertExpected();
    // Same-device preparation hook; EXDEV keeps its copied/removing hooks.
    if (before.dev === (await lstat(directory, { bigint: true })).dev) await options?.onStep?.('prepared', source);
    signal?.throwIfAborted();
    await validate();
    if (changed(await lstat(source, { bigint: true }), before)) throw new Error('Source changed before move; re-inspect it.');
    await assertExpected();
    try { await rename(source, recovery); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error.code === 'EACCES' || error.code === 'EPERM' ? new Error(`Permission denied moving ${source} (${error.code}).`) : error;
      record.method = 'copy'; record.copy_fallback = true;
      await copyAcross(source, recovery, before, record, save, signal, async (stage, path) => {
        await options?.onStep?.(stage, path);
        if (stage === 'removing' && path === '') await assertExpected();
      }, validate);
    }
  } catch (error) {
    try { await revalidateAncestors(recoveryAncestors); }
    catch (topologyError) { throw failure(`${topologyError.message} Recovery cleanup refused. Original failure: ${error.message}`, { ...record, status: 'failed' }); }
    throw await settleFailure(error, record, directory, save, recoveryAncestors);
  }
  record.status = 'moved';
  const result = { ...record };
  await save().catch(e => { result.warning = `Manifest update failed: ${e.message}`; });
  return result;
}
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'trash', description: 'Recoverably remove explicit files/directories (symlinks as links): move each into a private dir under /tmp. Cross-filesystem sources are copied, verified, then removed. /tmp is tmpfs here: RAM-backed, cleared on reboot; not a backup. No permanent delete.',
    parameters: { paths: { type: 'array', items: { type: 'string' }, required: true, description: 'Explicit paths, absolute or relative to the session working directory (resolved lexically, no globs).' } }, output: stringOutput,
    async execute({ paths }, exec) {
      requireFullAccess(ctx, exec); assertActive(exec);
      if (!Array.isArray(paths) || !paths.length) throw new Error('Supply at least one explicit path.');
      const results = [];
      for (const path of paths) {
        if (exec.signal?.aborted) { results.push({ input: path, ...unmoved(null), status: 'not_attempted', error: 'Canceled' }); continue; }
        try { results.push({ input: path, ...await trashOne(path, cwdOf(exec), exec.signal, { ctx, exec }) }); }
        catch (e) { results.push({ input: path, ...e.trash ?? unmoved(null), status: e.trash?.status ?? 'failed', error: e.message }); }
      }
      const moved = results.filter(r => r.status === 'moved').length;
      return JSON.stringify({ atomic: false, moved, not_moved: results.length - moved, results,
        note: 'To restore, move the recovery path back only if the original path is free; never overwrite. /tmp is cleared on reboot.' });
    } }));
}
