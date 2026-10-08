import { realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
export const name = 'alex-workspace-context';
export const inject = ['systemPrompt'];
export const machineEnvironment = 'Machine environment: the user\'s interactive shell is fish, so commands handed to the user use fish syntax; the bash tool runs `bash -c`, so commands executed there use bash syntax. Python projects use uv; the virtual environment convention is `.venv/` (not every project has one), activated in fish with `source .venv/bin/activate.fish`. Installed utilities: uv, jq, az. Home: /home/alex; projects: /home/alex/git/my.';
const reasons = { ENOENT: 'working directory not found', ENOTDIR: 'working directory is not a directory', EACCES: 'permission denied', EPERM: 'permission denied', ELOOP: 'symbolic link loop' };
function gitRoot(dir) {
  // Git owns discovery (including gitfiles, ceilings, ownership and environment).
  // Never run a shell, hooks, status scans or an unbounded subprocess in assembly.
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
    encoding: 'utf8', timeout: 250, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) throw new Error(result.error.code === 'ETIMEDOUT' ? 'git discovery timed out' : `git discovery failed (${result.error.code ?? 'unknown error'})`);
  const lines = result.stdout.trimEnd().split('\n');
  if (result.status === 0 && ['true', 'false'].includes(lines[0]) && lines.length === 2) return realpathSync.native(lines[1]);
  // Only Git's explicit absence and bare-repository answers mean no worktree.
  const stderr = result.stderr.trim();
  // Git can silently skip inaccessible markers. Confirm absence is observable;
  // these probes never decide repository validity, which remains Git's job.
  if (result.status === 128 && stderr.startsWith('fatal: not a git repository')) {
    for (let current = dir, depth = 0; ; current = dirname(current), depth++) {
      if (depth >= 128) throw new Error('git absence verification limit exceeded');
      try { statSync(join(current, '.git', 'HEAD')); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      if (current === dirname(current)) break;
    }
  }
  if (result.status === 128 && (/^fatal: not a git repository \(or any of the parent directories\): \.git$/.test(stderr) || /^fatal: not a git repository \(or any parent up to mount point /.test(stderr) || (lines[0] === 'false' && stderr === 'fatal: this operation must be run in a work tree'))) return null;
  // Keep diagnostics compact and avoid unstable full stderr/path dumps in context.
  if (/detected dubious ownership/.test(stderr)) throw new Error('git discovery failed (dubious ownership)');
  if (/invalid gitfile format/.test(stderr)) throw new Error('git discovery failed (invalid gitfile)');
  if (/Permission denied/.test(stderr)) throw new Error('git discovery failed (permission denied)');
  throw new Error(`git discovery failed (exit ${result.status ?? 'signal'})`);
}
export function workspacePaths(cwd) {
  let canonical, root = null, error;
  try {
    canonical = realpathSync.native(cwd);
    if (!statSync(canonical).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    root = gitRoot(canonical);
  } catch (e) {
    error = reasons[e.code] ?? e.message ?? 'unknown error';
  }
  return { working_directory: cwd,
    ...(canonical && canonical !== resolve(cwd) ? { working_directory_canonical: canonical } : {}),
    git_root: root, working_directory_relative_to_git_root: root === null ? null : relative(root, canonical) || '.',
    ...(error ? { git_discovery_error: error } : {}) };
}
export function workspaceContext(cwd) {
  return 'Workspace paths: ' + JSON.stringify(workspacePaths(cwd));
}
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'alex-workspace:machine', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
    text: machineEnvironment, interpolate: false });
  // Cache only assembly, not the exported explicit discovery functions. Weak keys
  // avoid retaining sessions; a short TTL bounds stale results after git init/move.
  const cache = new WeakMap();
  ctx.systemPrompt.context({ name: 'alex-workspace:paths', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') - 10,
    text: ({ agent }) => {
      const cwd = agent?.session.header.cwd;
      if (cwd === undefined) return '';
      const now = performance.now(), previous = cache.get(agent);
      const environment = JSON.stringify(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_') || ['PATH', 'HOME', 'XDG_CONFIG_HOME'].includes(key)));
      if (previous && previous.cwd === cwd && previous.environment === environment && now - previous.at < 1000) return previous.text;
      const text = workspaceContext(cwd);
      cache.set(agent, { cwd, environment, at: performance.now(), text });
      return text;
    } });
}
