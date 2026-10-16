#!/usr/bin/env node
// Prompt audit: compose, offline, what the model would receive on the first request of
// a fresh session for a DSH profile, then (a) fail on denylisted harness phrases and
// (b) compare the harness text with the committed baseline (baseline/<profile>.txt).
// Read AGENTS.md (repo root) before acting on its result.
//
//   node tools/prompt-audit/audit.mjs                       # dsh-tui
//   node tools/prompt-audit/audit.mjs --profile dsh-tui --profile companion
//   node tools/prompt-audit/audit.mjs --profile dsh-tui --update   # owner's OK only
//   node tools/prompt-audit/audit.mjs --full                 # local review dump in .dumps/
//
// No network, credentials or model calls: capture.mjs boots the profile in a child
// process behind guards.mjs. It boots a COPY of the profile inside a temporary
// DSH_HOME (sandbox.mjs), never ~/.dsh/profiles/<name> itself: dsh rewrites a
// profile's root cordis.yml on every boot or `--dump-config`, and live-reloading
// profiles (the lab Companion, running TUIs) react to that write — Companion latches
// a stale service state until restarted. The real ~/.dsh is only read. The sandbox is
// left under /tmp after the run. A profile absent on this machine is skipped.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DENYLIST, buildDocument, findDenylisted, findOwnerLeaks, renderDocument, skillOrigin, unifiedDiff } from './model.mjs';
import { createSandbox } from './sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../..');
export const BASELINE_DIR = join(here, 'baseline');
const DUMPS = join(REPO, '.dumps/prompt-audit');
const CAPTURE_TIMEOUT_MS = 120_000;
// The child gets a clean environment: no credentials (API keys, OAuth env refs), no
// DSH_TUI_* launch overrides, no NODE_OPTIONS; only what locates tools and locale.
const ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];
const SANITIZED_KINDS = new Set(['system-prompt', 'user', 'agent-instructions', 'runtime-context', 'skill-catalog']);

/** The installed dsh CLI anchor (its package.json), through this repo's node_modules link. */
export function resolveAnchor({ repo = REPO, home = homedir() } = {}) {
  const candidates = [join(repo, 'package.json')];
  const data = isAbsolute(process.env.XDG_DATA_HOME ?? '') ? process.env.XDG_DATA_HOME : join(home, '.local/share');
  candidates.push(join(data, 'dsh-cli/package.json'));
  for (const base of candidates) {
    try { return createRequire(base).resolve('@deepseek-ai/dsh/package.json'); } catch { /* next */ }
  }
  return undefined;
}

const tilde = (text, home) => text.replaceAll(`${home}/`, '~/');

/** Owner-authored files whose lines must never appear in a rendering. */
async function ownerFiles({ dshHome, capture, runtime }) {
  const paths = (await readdir(dshHome)).filter(name => /^(?:AGENTS|CLAUDE).*\.md$/.test(name)).map(name => join(dshHome, name));
  for (const skill of capture.skills ?? []) if (skill.path && skillOrigin(skill, { runtime, repo: REPO }) === 'owner') paths.push(skill.path);
  const files = [];
  for (const path of paths) {
    try { files.push({ path, text: await readFile(path, 'utf8') }); } catch { /* vanished or unreadable: nothing to compare */ }
  }
  return files;
}

/** Absolute home paths named by the profile files that do not exist here (e.g. a lab-only /home/alex). */
async function missingAbsolutePaths(profileDir) {
  const found = new Set();
  for (const name of await readdir(profileDir)) {
    if (!/\.(ya?ml|json)$/.test(name)) continue;
    const text = await readFile(join(profileDir, name), 'utf8');
    for (const match of text.matchAll(/(?<![\w.~])\/(?:home|Users)\/[^\s'"`,\]}]+/g)) found.add(match[0]);
  }
  return [...found].filter(path => !existsSync(path)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
}

function runCapture({ sandbox, anchor, profile, patches, home }) {
  const out = join(sandbox.root, 'capture.json');
  const env = Object.fromEntries(ENV_PASSTHROUGH.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, {
    HOME: home,
    DSH_HOME: sandbox.tempDshHome,
    TMPDIR: sandbox.tmp,
    DSH_TELEMETRY_DISABLED: '1',
    PROMPT_AUDIT_TEMP: sandbox.root,
    PROMPT_AUDIT_PROTECT: [...new Set([sandbox.realDshHome, join(home, '.dsh'), join(home, '.dsh-tui')])].join(':'),
  });
  const argv = ['--import', pathToFileURL(join(here, 'preload.mjs')).href, join(here, 'capture.mjs'),
    '--anchor', anchor, '--profile', profile, '--out', out, ...patches.flatMap(file => ['--patch', resolve(file)])];
  return new Promise(done => {
    // Own process group, so a timeout also kills whatever the plugins spawned.
    const child = spawn(process.execPath, argv, { cwd: sandbox.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stderr = '', stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      stderr += `\nprompt-audit: capture timed out after ${CAPTURE_TIMEOUT_MS} ms`;
    }, CAPTURE_TIMEOUT_MS);
    child.on('exit', async code => {
      clearTimeout(timer);
      let capture;
      try { capture = JSON.parse(await readFile(out, 'utf8')); } catch { /* reported by the caller */ }
      done({ code, capture, stderr, stdout });
    });
  });
}

/**
 * Audit one profile. Returns a structured result; never throws for audit failures.
 * status: 'ok' | 'fail' | 'skip' | 'updated'.
 */
export async function auditProfile(profile, { update = false, full = false, patches = [], baselineDir = BASELINE_DIR, dumps = DUMPS, home = homedir(), dshHome = process.env.DSH_HOME ?? join(home, '.dsh'), anchor = resolveAnchor({ home }) } = {}) {
  const result = { profile, status: 'ok', problems: [], notes: [], hits: [], diff: '', baselinePath: join(baselineDir, `${profile}.txt`) };
  if (!existsSync(join(dshHome, 'profiles', profile, 'package.json'))) {
    return { ...result, status: 'skip', notes: [`profile not found at ${tilde(join(dshHome, 'profiles', profile), home)}`] };
  }
  if (!anchor) return { ...result, status: 'fail', problems: ['installed DSH runtime not found (node_modules link or ~/.local/share/dsh-cli); run tools/clean-install/host.mjs'] };
  const started = Date.now();
  const sandbox = await createSandbox({ home, dshHome, profile });
  result.notes.push(`sandbox (left in place): ${sandbox.root}`);
  const missing = await missingAbsolutePaths(sandbox.profileDir);
  if (missing.length) {
    result.notes.push(`profile names ${missing.length} absolute path(s) absent on this machine (e.g. ${missing.slice(0, 3).join(', ')}): this composition differs from the machine the profile was written for`);
  }
  const run = await runCapture({ sandbox, anchor, profile, patches, home });
  result.seconds = (Date.now() - started) / 1000;
  const warnings = `${run.stderr}\n${run.stdout}`.split('\n').filter(line => line.trim() && !line.startsWith('    at ')).slice(0, 40);
  if (run.code !== 0 || !run.capture || run.capture.error) {
    return { ...result, status: 'fail', problems: [`capture failed (exit ${run.code})`, ...warnings] };
  }
  const capture = run.capture;
  const runtime = resolve(anchor, '../../../..');
  const doc = buildDocument(capture, { runtime, repo: REPO });
  result.summary = `preset ${doc.preset ?? '(none)'}, ${doc.messages.length} messages, ${doc.tools.length} tools`;
  result.hits = findDenylisted(doc);
  if (capture.requestCount !== 1) result.notes.push(`${capture.requestCount} model requests reached the audit route (expected 1)`);
  for (const call of capture.sideCalls) result.notes.push(`offline fence answered a side model call: ${call.provider}/${call.model}${call.purpose ? ` (${call.purpose})` : ''}`);
  for (const write of capture.guard.deniedWrites) result.notes.push(`blocked write (real state stays untouched): ${tilde(write, home)}`);
  for (const target of capture.guard.blockedNetwork) result.notes.push(`blocked network attempt: ${target}`);
  for (const write of capture.guard.outsideWrites) result.notes.push(`write outside the sandbox: ${tilde(write, home)}`);
  if (capture.guard.spawned.length) result.notes.push(`commands spawned by plugins: ${capture.guard.spawned.join(', ')}`);
  for (const message of doc.messages) {
    if (!SANITIZED_KINDS.has(message.kind)) result.notes.push(`message ${message.index} has a kind the audit does not sanitize (${message.kind}): review it before --update`);
  }
  if (sandbox.skippedProfileDirs.length) result.notes.push(`profile subdirectories not mirrored: ${sandbox.skippedProfileDirs.join(', ')}`);
  if (patches.length) result.notes.push(`overlay patches applied (experiment): ${patches.join(', ')}`);
  for (const line of warnings) result.notes.push(`runtime: ${line}`);

  const paths = [
    [sandbox.workspace, '<workspace>'], [sandbox.tempDshHome, '~/.dsh'], [sandbox.shadowHome, '~'], [sandbox.root, '<temp>'],
    [runtime, '<runtime>'], [REPO, '<repo>'], [sandbox.realDshHome, '~/.dsh'], [sandbox.realHome, '~'], [home, '~'],
  ];
  const text = renderDocument(doc, { paths });
  // Fail closed on privacy: no line of an owner file may reach the rendering.
  const leaks = findOwnerLeaks(text, await ownerFiles({ dshHome: sandbox.realDshHome, capture, runtime }));
  if (leaks.length) result.problems.push(`owner text would leak into the baseline (from ${leaks.map(path => tilde(path, home)).join(', ')}): the sanitizers do not know this layout; fix model.mjs before --update`);
  if (full) {
    await mkdir(dumps, { recursive: true });
    await writeFile(join(dumps, `${profile}.full.txt`), renderDocument(doc, { paths, full: true }));
    // Raw request, owner text included: local review only (.dumps is gitignored).
    await writeFile(join(dumps, `${profile}.capture.json`), `${JSON.stringify(capture, null, 2)}\n`);
    result.notes.push(`full dump: ${tilde(join(dumps, `${profile}.full.txt`), home)} (+ .capture.json, local only)`);
  }
  if (update) {
    if (leaks.length) return { ...result, status: 'fail' };
    if (capture.requestCount !== 1) return { ...result, status: 'fail', problems: ['capture did not reach exactly one model request: baseline NOT updated'] };
    if (result.hits.length) return { ...result, status: 'fail', problems: ['denylisted harness text present: baseline NOT updated (fix the regression first)'] };
    if (patches.length) return { ...result, status: 'fail', problems: ['--update refuses overlay patches: the baseline is the real profile composition'] };
    await mkdir(baselineDir, { recursive: true });
    await writeFile(result.baselinePath, text);
    return { ...result, status: 'updated' };
  }
  const baseline = existsSync(result.baselinePath) ? await readFile(result.baselinePath, 'utf8') : undefined;
  if (baseline === undefined) {
    result.problems.push(`no baseline at ${relative(REPO, result.baselinePath)}: review the current text, then create it with --update (owner's OK)`);
  } else if (baseline !== text) {
    result.diff = unifiedDiff(baseline, text, { from: relative(REPO, result.baselinePath), to: `current ${profile}` });
    result.problems.push('harness text differs from the baseline');
  }
  if (result.problems.length) {
    await mkdir(dumps, { recursive: true });
    await writeFile(join(dumps, `${profile}.current.txt`), text);
    result.notes.push(`current text: ${relative(REPO, join(dumps, `${profile}.current.txt`))}`);
  }
  if (result.hits.length || result.problems.length) result.status = 'fail';
  return result;
}

function report(result, write = text => process.stdout.write(text)) {
  const head = { ok: 'OK', fail: 'FAIL', skip: 'SKIP', updated: 'UPDATED' }[result.status];
  write(`\nprompt-audit ${result.profile}: ${head}${result.summary ? ` — ${result.summary}` : ''}${result.seconds ? ` (${result.seconds.toFixed(1)} s)` : ''}\n`);
  if (result.status === 'skip') { for (const note of result.notes) write(`  ${note}\n`); return; }
  if (result.summary) write(`  denylist (${DENYLIST.length} phrases): ${result.hits.length ? `${result.hits.length} HIT(S)` : 'clean'}\n`);
  for (const hit of result.hits) {
    write(`  DENYLISTED "${hit.phrase}" in ${hit.where}\n    …${hit.excerpt}…\n    known source: ${hit.source}\n    fix: ${hit.fix}\n`);
  }
  for (const problem of result.problems) write(`  ${problem}\n`);
  if (result.status === 'updated') write(`  baseline written: ${relative(REPO, result.baselinePath)}\n`);
  else if (result.summary && !result.problems.length) write(`  baseline: matches ${relative(REPO, result.baselinePath)}\n`);
  if (result.diff) write(result.diff.replace(/^/gm, '  '));
  for (const note of result.notes) write(`  note: ${note}\n`);
}

async function main() {
  const { values } = parseArgs({ options: {
    profile: { type: 'string', multiple: true }, update: { type: 'boolean', default: false }, full: { type: 'boolean', default: false },
    patch: { type: 'string', multiple: true, default: [] }, help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.help) {
    process.stdout.write('Usage: node tools/prompt-audit/audit.mjs [--profile NAME]... [--update] [--full] [--patch FILE]...\nSee AGENTS.md for what a failure means and who may accept a baseline change.\n');
    return 0;
  }
  const profiles = values.profile?.length ? values.profile : ['dsh-tui'];
  let audited = 0, failed = 0;
  for (const profile of profiles) {
    const result = await auditProfile(profile, { update: values.update, full: values.full, patches: values.patch });
    report(result);
    if (result.status !== 'skip') audited += 1;
    if (result.status === 'fail') failed += 1;
  }
  if (audited === 0) { process.stdout.write('\nprompt-audit: no profile audited\n'); return 1; }
  if (failed) process.stdout.write('\nprompt-audit: FAILED. A denylist hit is a regression to fix at its source; a baseline diff needs the owner\'s review before --update (AGENTS.md).\n');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
