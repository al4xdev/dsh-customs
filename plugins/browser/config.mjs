import { constants } from 'node:fs';
import { open, realpath, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { projectRoot } from '../project-mcp/config.mjs';
import { fail } from './errors.mjs';

const MAX_CONFIG_BYTES = 1024 * 1024;
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const DEFAULT_CONFIG = freeze({
  enabled: true,
  browserCache: join(homedir(), '.cache', 'dsh-browser', 'playwright-1.64.0'),
  allowedEngines: ['chromium'],
  allowCss: false,
  allowDownloads: false,
  sensitiveOps: 'ask',
  rawRetentionMs: 86400000,
  deliveryRetentionMs: 604800000,
  limits: {
    sessions: 2, tabs: 4, actionMs: 5000, navigationMs: 30000, rootMs: 60000,
    finalizeMs: 15000, idleMs: 600000, pixels: 16000000,
    viewportWidth: 2560, viewportHeight: 1440, dpr: 3,
    videoDurationMs: 60000, videoFps: 30, videoBytes: 104857600,
    sessionBytes: 262144000, ownerBytes: 524288000, freeDiskBytes: 1073741824,
    inputBytes: 65536,
  },
});

const HARD_LIMITS = freeze({
  sessions: 16, tabs: 64, actionMs: 300000, navigationMs: 300000, rootMs: 300000,
  finalizeMs: 120000, idleMs: 86400000, pixels: 64000000,
  viewportWidth: 8192, viewportHeight: 8192, dpr: 8,
  videoDurationMs: 3600000, videoFps: 60, videoBytes: 2147483648,
  sessionBytes: 8589934592, ownerBytes: 34359738368, freeDiskBytes: 1099511627776,
  inputBytes: 1048576,
});
const PROFILE_FIELDS = new Set([...Object.keys(DEFAULT_CONFIG), 'browserCache']);
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('BROWSER_CONFIG_INVALID', `${label} must be a plain object.`);
  }
  return value;
}
function validateSection(section, label, project = false) {
  object(section, label);
  for (const [key, value] of Object.entries(section)) {
    if (!PROFILE_FIELDS.has(key)) fail('BROWSER_CONFIG_INVALID', `Unknown ${label} field: ${key}.`);
    if (project && key === 'browserCache') fail('BROWSER_CONFIG_INVALID', 'browserCache is an administrative setting, not a project override.');
    if (['enabled', 'allowCss', 'allowDownloads'].includes(key) && typeof value !== 'boolean') {
      fail('BROWSER_CONFIG_INVALID', `${label}.${key} must be boolean.`);
    }
    if (key === 'allowedEngines') {
      if (!Array.isArray(value) || value.length > 3 || value.some(engine => !ENGINES.has(engine)) || new Set(value).size !== value.length) {
        fail('BROWSER_CONFIG_INVALID', `${label}.allowedEngines must contain unique supported engine names.`);
      }
    }
    if (key === 'sensitiveOps' && !['ask', 'disabled'].includes(value)) fail('BROWSER_CONFIG_INVALID', `${label}.sensitiveOps must be ask or disabled.`);
    if (['rawRetentionMs', 'deliveryRetentionMs'].includes(key) && (!Number.isSafeInteger(value) || value < 1000 || value > 31536000000)) {
      fail('BROWSER_CONFIG_INVALID', `${label}.${key} must be a finite duration between one second and one year.`);
    }
    if (key === 'browserCache' && (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 4096)) {
      fail('BROWSER_CONFIG_INVALID', 'browserCache must be an administrative absolute path.');
    }
    if (key === 'limits') {
      object(value, `${label}.limits`);
      for (const [name, number] of Object.entries(value)) {
        if (!Object.hasOwn(HARD_LIMITS, name)) fail('BROWSER_CONFIG_INVALID', `Unknown browser limit: ${name}.`);
        if (!Number.isFinite(number) || number < (name === 'videoDurationMs' ? 1000 : name === 'dpr' ? 0.1 : 1) || number > HARD_LIMITS[name] || (name !== 'dpr' && !Number.isSafeInteger(number))) {
          fail('BROWSER_CONFIG_INVALID', `${label}.limits.${name} is outside its finite administrative bounds.`);
        }
      }
    }
  }
}

/** Projects can only narrow a profile's capabilities, budgets and retention. */
export function normalizeConfig(profile = {}, project = {}) {
  validateSection(profile, 'profile');
  validateSection(project, 'project', true);
  const admin = {
    ...DEFAULT_CONFIG, ...profile,
    allowedEngines: [...(profile.allowedEngines ?? DEFAULT_CONFIG.allowedEngines)],
    limits: { ...DEFAULT_CONFIG.limits, ...profile.limits },
  };
  for (const name of ['enabled', 'allowCss', 'allowDownloads']) {
    if (project[name] === true && admin[name] === false) fail('BROWSER_CONFIG_INVALID', `Project cannot enable administratively disabled ${name}.`);
  }
  if (project.allowedEngines?.some(engine => !admin.allowedEngines.includes(engine))) fail('BROWSER_CONFIG_INVALID', 'Project cannot add an engine not permitted by its profile.');
  if (admin.sensitiveOps === 'disabled' && project.sensitiveOps === 'ask') fail('BROWSER_CONFIG_INVALID', 'Project cannot re-enable sensitive operations.');
  for (const name of ['rawRetentionMs', 'deliveryRetentionMs']) {
    if (project[name] !== undefined && project[name] > admin[name]) fail('BROWSER_CONFIG_INVALID', `Project cannot increase ${name}.`);
  }
  for (const [name, number] of Object.entries(project.limits ?? {})) {
    // More free-space reserve narrows permission; every other resource budget narrows downward.
    if (name === 'freeDiskBytes' ? number < admin.limits[name] : number > admin.limits[name]) {
      fail('BROWSER_CONFIG_INVALID', `Project cannot widen browser limit ${name}.`);
    }
  }
  return freeze({
    ...admin, ...project,
    allowedEngines: [...(project.allowedEngines ?? admin.allowedEngines)],
    limits: { ...admin.limits, ...project.limits },
  });
}

function inside(base, target) {
  const part = relative(base, target);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function projectSection(root) {
  if (root === null) return {};
  const directory = join(root, '.agents');
  try { await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  // A dangling or unreadable link is invalid configuration, not permissive absence.
  const canonical = await realpath(directory);
  if (!inside(root, canonical) || !(await stat(canonical)).isDirectory()) fail('BROWSER_CONFIG_INVALID', 'Browser project configuration directory escapes its Git root.');
  let handle;
  try { handle = await open(join(canonical, 'config.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    if (!(await handle.stat()).isFile()) fail('BROWSER_CONFIG_INVALID', 'Browser project configuration must be a regular file.');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = await handle.read(buffer, total, buffer.length - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total > MAX_CONFIG_BYTES) fail('BROWSER_CONFIG_INVALID', 'Browser project configuration exceeds 1 MiB.');
    const document = object(JSON.parse(buffer.subarray(0, total).toString('utf8')), 'Project configuration');
    if (!Object.hasOwn(document, 'dshCustoms')) return {};
    const customs = object(document.dshCustoms, 'dshCustoms');
    return Object.hasOwn(customs, 'browser') ? object(customs.browser, 'dshCustoms.browser') : {};
  } finally { await handle.close(); }
}

/** This reads only the nearest opted-in Git project and never modifies its configuration. */
export async function resolveConfig(cwd, profile = {}) {
  try {
    const root = await projectRoot(cwd);
    const config = normalizeConfig(profile, await projectSection(root));
    // Policy revision is private broker metadata; it is not a hash of credentials.
    const revision = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    return { config, root, revision };
  } catch (error) {
    if (error.code === 'BROWSER_CONFIG_INVALID') throw error;
    fail('BROWSER_CONFIG_INVALID', 'Browser project configuration is unreadable or invalid. Coding tools remain independent of this browser configuration.');
  }
}
