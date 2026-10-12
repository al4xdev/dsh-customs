import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const fail = message => { throw new Error(message); };
const inside = (path, root) => path === root || path.startsWith(root + sep);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: expected object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}: unknown field ${key}`);
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) fail(`${label}: expected nonempty text`);
}
function pin(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) fail(`${label}: exact version required`);
}
function sourcePath(value, label, allowDot = false) {
  text(value, label);
  if (isAbsolute(value) || value.includes('\\') || value.split('/').some(part => part === '..' || part === '' || (part === '.' && !(allowDot && value === '.')))) fail(`${label}: relative path without traversal required`);
}
function commit(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail(`${label}: full lowercase commit required`);
}

export function validateManifest(manifest) {
  object(manifest, ['schemaVersion', 'runtime', 'prerequisites', 'components'], 'manifest');
  if (manifest.schemaVersion !== 1) fail('Unsupported schemaVersion');
  object(manifest.runtime, ['package', 'version'], 'runtime');
  if (manifest.runtime.package !== '@deepseek-ai/dsh') fail('Unexpected runtime package');
  pin(manifest.runtime.version, 'runtime.version');
  object(manifest.prerequisites, ['nodeMajorMinimum'], 'prerequisites');
  if (!Number.isSafeInteger(manifest.prerequisites.nodeMajorMinimum) || manifest.prerequisites.nodeMajorMinimum < 24) fail('nodeMajorMinimum must be >=24');
  if (!Array.isArray(manifest.components) || !manifest.components.length) fail('components must be nonempty');
  const ids = new Set();
  for (const component of manifest.components) {
    object(component, ['id', 'role', 'package', 'version', 'repository', 'commit', 'packageManager', 'patch', 'submodules', 'reproduction', 'build'], 'component');
    if (typeof component.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(component.id) || ids.has(component.id)) fail('Invalid/duplicate component id');
    ids.add(component.id);
    text(component.role, 'role');
    if (typeof component.package !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(component.package)) fail('Invalid package name');
    pin(component.version, 'component.version');
    text(component.repository, 'repository');
    let url;
    try { url = new URL(component.repository); } catch { fail('Invalid repository URL'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname === '/' || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) || /%40|%3a/i.test(url.pathname)) fail('Repository must be public HTTPS without credentials/query/fragment');
    commit(component.commit, 'commit');
    object(component.packageManager, ['name', 'version'], 'packageManager');
    if (!['npm', 'pnpm'].includes(component.packageManager.name)) fail('Unsupported package manager');
    if (component.packageManager.version !== undefined) pin(component.packageManager.version, 'packageManager.version');
    if (component.patch !== undefined) {
      object(component.patch, ['path', 'sha256'], 'patch');
      sourcePath(component.patch.path, 'patch.path');
      if (typeof component.patch.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(component.patch.sha256)) fail('Invalid patch sha256');
    }
    if (component.submodules !== undefined) {
      if (!Array.isArray(component.submodules)) fail('submodules must be an array');
      const paths = new Set();
      for (const submodule of component.submodules) {
        object(submodule, ['path', 'commit'], 'submodule');
        sourcePath(submodule.path, 'submodule.path');
        if (paths.has(submodule.path)) fail('Duplicate submodule path');
        paths.add(submodule.path);
        commit(submodule.commit, 'submodule.commit');
      }
    }
    object(component.reproduction, ['status', 'reason'], 'reproduction');
    if (!['ready', 'blocked'].includes(component.reproduction.status)) fail('Invalid reproduction status');
    if (component.reproduction.reason !== undefined) text(component.reproduction.reason, 'reproduction.reason');
    if (component.reproduction.status === 'blocked' && !component.reproduction.reason) fail('Blocked reproduction requires reason');
    object(component.build, ['commands', 'strategy'], 'build');
    text(component.build.strategy, 'build.strategy');
    if (!Array.isArray(component.build.commands) || (!component.build.commands.length && component.reproduction.status === 'ready')) fail('Ready recipes require build commands');
    for (const command of component.build.commands) {
      object(command, ['command', 'args', 'cwd'], 'build command');
      if (typeof command.command !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command.command)) fail('Build command must be executable basename');
      if (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string' || /[\x00-\x1f]/.test(arg))) fail('Build args must be text array');
      sourcePath(command.cwd, 'build.cwd', true);
    }
  }
  return manifest;
}

export function resolvePaths({ repo, home = process.env.HOME || homedir(), xdgDataHome, dshHome, destination } = {}) {
  if (!repo || !isAbsolute(repo) || !isAbsolute(home)) fail('repo and home must be absolute');
  const data = xdgDataHome ?? process.env.XDG_DATA_HOME ?? join(home, '.local/share');
  const dsh = dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh');
  if (!isAbsolute(data) || !isAbsolute(dsh) || (destination !== undefined && !isAbsolute(destination))) fail('Configured paths must be absolute');
  return { repo: resolve(repo), home: resolve(home), xdgDataHome: resolve(data), dshHome: resolve(dsh), runtime: join(resolve(data), 'dsh-cli'), destination: destination === undefined ? undefined : resolve(destination) };
}

export function inspectRecipe({ repo, manifest }) {
  validateManifest(manifest);
  const root = realpathSync(repo);
  const issues = [];
  const components = manifest.components.map(component => {
    const componentIssues = [];
    if (component.reproduction.status === 'blocked') componentIssues.push(component.reproduction.reason);
    if (component.patch) {
      const path = resolve(root, component.patch.path);
      try {
        const canonical = realpathSync(path);
        if (!inside(canonical, root)) fail('patch escapes repository through symlink');
        if (!lstatSync(canonical).isFile()) fail('patch is not a regular file');
        if (sha256(readFileSync(canonical)) !== component.patch.sha256) fail('patch SHA256 mismatch');
      } catch (error) { componentIssues.push(`patch: ${error.code ?? error.message}`); }
    }
    issues.push(...componentIssues.map(issue => `${component.id}: ${issue}`));
    return { id: component.id, ready: componentIssues.length === 0, issues: componentIssues };
  });
  return { ready: issues.length === 0, issues, components, attestation: 'Recipe integrity only; source cleanliness, public access and bit-for-bit reproduction are not verified.' };
}

export function reserveDestination(destination, forbiddenRoots = []) {
  if (typeof destination !== 'string' || !isAbsolute(destination) || destination.split(sep).includes('..')) fail('Destination must be absolute without traversal');
  const target = resolve(destination);
  // Existing links (including dangling ones) are occupied, never repairable targets.
  if (lstatSync(target, { throwIfNoEntry: false })) fail('Destination already exists');
  const home = resolve(process.env.HOME || homedir());
  if (inside(home, target)) fail('Destination cannot be HOME or an ancestor');
  for (const root of [join(home, '.dsh'), join(home, '.local/share/dsh-cli'), ...forbiddenRoots]) {
    if (typeof root !== 'string' || !isAbsolute(root)) fail('Forbidden roots must be absolute');
    const canonical = existsSync(root) ? realpathSync(root) : resolve(root);
    if (inside(target, canonical) || inside(canonical, target) || inside(target, resolve(root)) || inside(resolve(root), target)) fail(`Destination overlaps protected root: ${root}`);
  }
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) fail('Destination parent must be canonical non-symlink directory');
  // Non-recursive mkdir is the exclusive reservation; a competing creator wins
  // with EEXIST instead of having its directory reused or overwritten.
  mkdirSync(target, { mode: 0o700 });
  if (realpathSync(target) !== target || !lstatSync(target).isDirectory()) fail('Destination changed during reservation; inspect it manually');
  return target;
}
