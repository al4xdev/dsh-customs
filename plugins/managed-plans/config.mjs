import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
async function configDirectory(workspace, create = false) {
  const directory = join(workspace, '.agents');
  if (create) await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let canonical;
  try { canonical = await realpath(directory); }
  catch (error) { if (error.code === 'ENOENT' && !create) return null; throw error; }
  const part = relative(workspace, canonical);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Project config directory resolves outside the workspace');
  return canonical;
}
async function readDocument(directory) {
  if (!directory) return {};
  let handle;
  // Config symlinks are rejected instead of importing or replacing another file.
  try { handle = await open(join(directory, 'config.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Project config must be a regular file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error('Project config exceeds 1 MiB');
    return object(JSON.parse(buffer.subarray(0, total).toString('utf8')), 'Project config');
  } finally { await handle.close(); }
}
function section(document) {
  if (document.dshCustoms === undefined) return null;
  const customs = object(document.dshCustoms, 'dshCustoms');
  if (customs.managedPlans === undefined) return null;
  return object(customs.managedPlans, 'dshCustoms.managedPlans');
}

/** Our project preference, not a native DSH Plan/permission mode. */
export async function readPlanConfig(workspace) {
  const document = await readDocument(await configDirectory(workspace));
  const value = section(document)?.autoApprove;
  if (value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error('dshCustoms.managedPlans.autoApprove must be boolean');
  return value;
}

/** Authenticated /plan command callers enforce writable roots before this call. */
export async function writePlanConfig(workspace, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('autoApprove must be boolean');
  const directory = await configDirectory(workspace, true);
  const document = await readDocument(directory);
  section(document); // Never discard a malformed namespace to make the toggle succeed.
  document.dshCustoms ??= {};
  document.dshCustoms.managedPlans ??= {};
  document.dshCustoms.managedPlans.autoApprove = enabled;
  const content = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Project config exceeds 1 MiB');
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    // Publish whole JSON, never a truncated preference after an interrupted write.
    await rename(temporary, join(directory, 'config.json'));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return enabled;
}
