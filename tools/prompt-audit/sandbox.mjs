// Temporary layout the capture child boots in. The real profile directory is never
// booted: dsh rewrites a profile's root cordis.yml on every boot or `--dump-config`
// (even when identical), and profiles with `patchReload: live` (the lab Companion) or a
// running TUI hot-reload on that write; Companion then shows a stale service state
// until restarted. Everything the boot may write lands in this copy instead.
//
//   <root>/home/            shadow of $HOME for path resolution only (the child keeps the
//                           real HOME): one symlink per top-level entry, except the
//                           branch leading to DSH_HOME, which is rebuilt as real dirs;
//   <root>/home/.dsh/       temporary DSH_HOME: read-only inputs (AGENTS*.md, skills,
//                           .agent-presets…) symlinked, runtime state left out;
//   <root>/home/.dsh/profiles/<name>/  copy of the profile's top-level files, next to
//                           the profiles/ symlinks (node_modules → the runtime, or to a real pnpm tree);
//   <root>/workspace/       empty cwd, so no project AGENTS/CLAUDE/skills leak in;
//   <root>/tmp/             TMPDIR of the child.
//
// Why a shadow HOME: portable profiles name plugins relative to their own directory
// (`../../../git/my/dsh-customs/...`). The copy sits at the same depth below a
// HOME-shaped tree, so every such path resolves to the same real file, while nothing
// is created in the real HOME. <root> is a mkdtemp dir under the system temp dir
// (/tmp) and is left there after the run (inspectable; cleared with /tmp).
// guards.mjs refuses any write that would resolve back into the real DSH_HOME or
// ~/.dsh-tui; other writes outside <root> are reported, not blocked.
import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, realpath, stat as stat_, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const TEMP_PREFIX = 'dsh-prompt-audit-';

// DSH_HOME entries mirrored into the temporary DSH_HOME: only read-only inputs that
// shape the prompt (owner instruction files, skills, user presets). Everything else
// (sessions, storages, credentials, logs, the machine-local home cordis.patch.yml
// layer — corporate wiring on one machine, nothing on another) stays out.
const INPUT_ENTRY = /^(?:(?:AGENTS|CLAUDE)[^/]*\.md|skills|\.agent-presets)$/;

export const dshHomeInputs = names => names.filter(name => INPUT_ENTRY.test(name)).sort();

async function mirrorEntries(realDir, shadowDir, skip = new Set()) {
  for (const name of (await readdir(realDir)).sort()) {
    if (!skip.has(name)) await symlink(join(realDir, name), join(shadowDir, name));
  }
}

/**
 * Build the temporary layout for one profile.
 * @returns paths used by the capture child and by normalization, plus what was mirrored.
 */
export async function createSandbox({ home, dshHome, profile }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), TEMP_PREFIX)));
  const realHome = await realpath(home);
  const realDshHome = await realpath(dshHome);
  const realProfile = join(realDshHome, 'profiles', profile);
  const shadowHome = join(root, 'home');
  const workspace = join(root, 'workspace');
  const tmp = join(root, 'tmp');
  for (const dir of [shadowHome, workspace, tmp]) await mkdir(dir);

  // Rebuild the HOME → DSH_HOME branch as real dirs, mirroring each level's siblings.
  const rel = relative(realHome, realDshHome);
  const insideHome = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  let tempDshHome;
  if (insideHome) {
    let realLevel = realHome, shadowLevel = shadowHome;
    for (const part of rel.split(sep)) {
      await mirrorEntries(realLevel, shadowLevel, new Set([part]));
      realLevel = join(realLevel, part);
      shadowLevel = join(shadowLevel, part);
      await mkdir(shadowLevel);
    }
    tempDshHome = shadowLevel;
  } else {
    // A DSH_HOME outside HOME gets no shadow; profile-relative paths may then not resolve.
    await mirrorEntries(realHome, shadowHome);
    tempDshHome = join(root, 'dsh-home');
    await mkdir(tempDshHome);
  }

  const inputs = dshHomeInputs(await readdir(realDshHome));
  for (const name of inputs) await symlink(join(realDshHome, name), join(tempDshHome, name));

  // profiles/: the audited profile as a copy; shared symlinks (node_modules) recreated.
  const profiles = join(tempDshHome, 'profiles');
  await mkdir(profiles);
  for (const name of await readdir(join(realDshHome, 'profiles'))) {
    const entry = join(realDshHome, 'profiles', name);
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) await symlink(resolve(dirname(entry), await readlink(entry)), join(profiles, name));
    // A pnpm-installed (plugin-manager) tree is a real directory, not a runtime link.
    else if (stat.isDirectory() && name === 'node_modules') await symlink(entry, join(profiles, name));
  }
  const profileDir = join(profiles, profile);
  await mkdir(profileDir);
  const skippedProfileDirs = [];
  for (const name of (await readdir(realProfile)).sort()) {
    const source = join(realProfile, name), target = join(profileDir, name);
    const stat = await lstat(source);
    // Linked files are copied too, so a boot-time write cannot follow the link out.
    if (stat.isSymbolicLink() && (await stat_(source)).isFile()) await copyFile(source, target);
    else if (stat.isSymbolicLink()) await symlink(resolve(realProfile, await readlink(source)), target);
    else if (stat.isFile()) await copyFile(source, target);
    // Dependencies resolve through the real tree; writes there stay fenced by guards.mjs.
    else if (stat.isDirectory() && name === 'node_modules') await symlink(source, target);
    else skippedProfileDirs.push(name); // plugin state dirs; composition files are top-level
  }

  return { root, workspace, tmp, shadowHome, tempDshHome, profileDir, realHome, realDshHome, realProfile, inputs, skippedProfileDirs };
}
