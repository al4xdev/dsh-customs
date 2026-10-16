// Tests for the prompt audit. The pure rules (model.mjs) and the fences (guards.mjs,
// sandbox.mjs) run anywhere; the end-to-end cases boot the real installed runtime and
// skip when it or the profile is absent. None of them writes the committed baselines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentInstructionsTarget } from '../clean-install/agent-instructions.mjs';
import { auditProfile, resolveAnchor } from './audit.mjs';
import {
  DENYLIST, PROBE_TEXT, attribute, buildDocument, findDenylisted, findOwnerLeaks, normalize, renderDocument,
  sanitizeCatalog, sanitizeInstructions, unifiedDiff,
} from './model.mjs';
import { createSandbox, dshHomeInputs } from './sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = prefix => mkdtemp(join(tmpdir(), prefix));

// ── pure rules ───────────────────────────────────────────────────────────────

test('the denylist keeps every phrase the owner required (never weaken it)', () => {
  const required = ['playful', '[Status line]', 'powered by DeepSeek Harness', 'coding agent powered by', 'Use them as guidance', 'do not override system, developer'];
  const phrases = DENYLIST.map(entry => entry.phrase);
  for (const phrase of required) assert.ok(phrases.includes(phrase), `denylist lost "${phrase}"`);
  for (const entry of DENYLIST) assert.ok(entry.fix && entry.source, `"${entry.phrase}" needs a known source and fix`);
});

test('the pre-patch SDK wrapper sentences are denylisted', () => {
  // The hash-guarded SDK patch replaces exactly these sentences; if it is lost after a
  // reinstall the audit must name them.
  const [[oldIntro], [oldScoped]] = agentInstructionsTarget.replacements;
  const doc = buildDocument(fakeCapture({ instructionsIntro: oldIntro }));
  const found = new Set(findDenylisted(doc).map(hit => hit.phrase));
  assert.ok(found.has('Use them as guidance') && found.has('do not override system, developer'));
  const scoped = findDenylisted(buildDocument(fakeCapture({ systemExtra: oldScoped }))).map(hit => hit.phrase);
  assert.ok(scoped.includes('Use them as guidance'));
});

function fakeCapture({ instructionsIntro = "The following are the user's standing workspace instructions; follow them.", ownerBody = '# Owner rules\nBe playful. Use them as guidance.\n', systemExtra = '' } = {}) {
  const instructions = ['<system-reminder>', [instructionsIntro, 'Instructions from: $DSH_HOME/AGENTS.md', ownerBody].join('\n\n'), '</system-reminder>'].join('\n');
  const system = ['Harness rule one.', 'Harness rule two.', systemExtra].filter(Boolean).join('\n\n');
  return {
    profile: 'fixture', bundles: ['@deepseek-ai/dsh-base'], preset: 'standard', presets: [{ id: 'standard', broken: null }],
    systemSections: [{ name: 'empty', text: '' }, { name: 'one', text: 'Harness rule one.' }, { name: 'two', text: 'Harness rule two.' }],
    skills: [
      { name: 'mine', path: '/home/someone/.agents/skills/mine/SKILL.md', source: 'user-agents' },
      { name: 'shipped', path: '/opt/runtime/node_modules/x/skills/shipped/SKILL.md', source: 'custom' },
    ],
    request: {
      provider: 'prompt-audit', model: 'prompt-audit-model',
      messages: [
        { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: system }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: PROBE_TEXT }] },
        { role: 'user', source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: '$DSH_HOME/AGENTS.md' }] }, content: [{ type: 'text', text: instructions }] },
        { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: '<available_skills>\n- `mine`: Private description of a personal skill.\n- `shipped`: Shipped skill.\n</available_skills>' }] },
      ],
      tools: [
        { name: 'zeta', description: 'Last tool.', parameters: { type: 'object', properties: { a: { type: 'string', description: 'First\nsecond line' } }, required: ['a'] } },
        { name: 'alpha', description: 'First tool.', parameters: { type: 'object', properties: {} } },
      ],
    },
  };
}

test('system text is attributed to its sections; unexplained text cannot hide', () => {
  const { parts, empty } = attribute('A\n\nsurprise\n\nB', [{ name: 'a', text: 'A' }, { name: 'none', text: '' }, { name: 'b', text: 'B' }]);
  assert.deepEqual(parts.map(part => part.name), ['a', '<unattributed>', 'b']);
  assert.equal(parts[1].text, 'surprise');
  assert.deepEqual(empty, ['none']);
});

test('instruction bodies become placeholders with their exact byte count', () => {
  const body1 = 'línea uno\n', body2 = 'Instructions from: not-a-header\nsecond';
  const text = `<system-reminder>\nIntro.\n\nInstructions from: ~/.dsh/AGENTS.md\n\n${body1}\n\nInstructions from: /p/AGENTS.md\n\n${body2}\n</system-reminder>`;
  const { text: out, files } = sanitizeInstructions(text, ['~/.dsh/AGENTS.md', '/p/AGENTS.md']);
  assert.deepEqual(files, [{ path: '~/.dsh/AGENTS.md', bytes: Buffer.byteLength(body1) }, { path: '/p/AGENTS.md', bytes: Buffer.byteLength(body2) }]);
  assert.equal(out, `<system-reminder>\nIntro.\n\nInstructions from: ~/.dsh/AGENTS.md\n\n<instructions: ~/.dsh/AGENTS.md>\n\nInstructions from: /p/AGENTS.md\n\n<instructions: /p/AGENTS.md>\n</system-reminder>`);
});

test('nested "Additional instructions from" bodies are hidden too', () => {
  const text = '<system-reminder>\nAdditional instructions from: /p/sub/AGENTS.md\n\nsecret nested rules\n</system-reminder>';
  const { text: out } = sanitizeInstructions(text, []);
  assert.doesNotMatch(out, /secret nested rules/);
});

test('the leak scan names any owner file whose lines survive the sanitizers', () => {
  const owner = [{ path: '/h/.dsh/AGENTS.md', text: '# Rules\nNever deploy on Fridays without a rollback plan.\n' }, { path: '/h/skill.md', text: 'short\n' }];
  assert.deepEqual(findOwnerLeaks('…Never deploy on Fridays without a rollback plan.…', owner), ['/h/.dsh/AGENTS.md']);
  assert.deepEqual(findOwnerLeaks('<instructions: $DSH_HOME/AGENTS.md>', owner), []);
});

test('owner skills collapse to one line per root; shipped skills stay verbatim', () => {
  const skills = [
    { name: 'a', path: '/h/.agents/skills/a/SKILL.md', source: 'user-agents' },
    { name: 'b', path: '/h/.agents/skills/b/SKILL.md', source: 'user-agents' },
    { name: 'c', path: '/rt/node_modules/p/skills/c/SKILL.md', source: 'custom' },
  ];
  const out = sanitizeCatalog('<s>\n- `a`: secret A\n- `c`: shipped C\n- `b`: secret B\n- `x`: unknown\n</s>', skills, { runtime: '/rt' });
  assert.equal(out, '<s>\n<owner skills: /h/.agents/skills>\n- `c`: shipped C\n<owner skills: <unknown root>>\n</s>');
});

test('owner text is neither checked nor rendered; harness hits name their place', () => {
  const capture = fakeCapture({ systemExtra: 'Keep it optionally\n  PLAYFUL.' });
  capture.systemSections.push({ name: 'narrate', text: 'Keep it optionally\n  PLAYFUL.' });
  const doc = buildDocument(capture, { runtime: '/opt/runtime' });
  const hits = findDenylisted(doc);
  assert.deepEqual(hits.map(hit => [hit.phrase, hit.where]), [['playful', 'message 1 (system/system-prompt) › section narrate']]);
  const text = renderDocument(doc);
  assert.doesNotMatch(text, /Owner rules|Private description|Be playful/);
  assert.match(text, /<instructions: \$DSH_HOME\/AGENTS\.md>/);
  assert.match(text, /<owner skills: (?:\/home\/someone|~)\/\.agents\/skills>/);
  assert.match(text, /- `shipped`: Shipped skill\./);
  assert.match(text, /\(empty sections: empty\)/);
});

test('the rendering is stable: tools sorted, order recorded, schemas readable', () => {
  const doc = buildDocument(fakeCapture());
  const text = renderDocument(doc);
  assert.equal(text, renderDocument(buildDocument(fakeCapture())));
  assert.ok(text.indexOf('---- tool alpha') < text.indexOf('---- tool zeta'));
  assert.match(text, /^tool order: zeta, alpha$/m);
  assert.match(text, /  - a \(string, required\): First\n      second line/);
  assert.doesNotMatch(text, /raw parameters:/);
  assert.match(renderDocument(doc, { full: true }), /raw parameters:/);
});

test('volatile values are normalized', () => {
  const out = normalize('/tmp/x/workspace/a /tmp/x/b /home/alex/.dsh /home/u/git 5f0c3a8e-1b2c-4d5e-8f90-123456789abc 2026-10-16T17:00:00Z http://127.0.0.1:43123/', [['/tmp/x', '<temp>'], ['/tmp/x/workspace', '<workspace>'], ['/home/u', '~']]);
  assert.equal(out, '<workspace>/a <temp>/b ~/.dsh ~/git <uuid> <date> http://127.0.0.1:<port>/');
});

test('unified diff shows only the changed hunk', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const diff = unifiedDiff(before, before.replace('l10', 'L10'));
  assert.equal(diff, '--- baseline\n+++ current\n@@ -8,7 +8,7 @@\n l7\n l8\n l9\n-l10\n+L10\n l11\n l12\n l13\n');
  assert.equal(unifiedDiff('same', 'same'), '');
  // A trailing newline is not an extra line: hunks reaching EOF keep diff -u counts.
  assert.equal(unifiedDiff('a\nb\n', 'a\n'), '--- baseline\n+++ current\n@@ -1,2 +1,1 @@\n a\n-b\n');
});

// ── fences ───────────────────────────────────────────────────────────────────

test('guards refuse protected writes and network, rebind listeners, record the rest', async () => {
  const root = await scratch('prompt-audit-guard-');
  const guarded = join(root, 'real-dsh'), temp = join(root, 'temp');
  await mkdir(guarded); await mkdir(temp);
  await symlink(guarded, join(temp, 'link-to-real'));
  const script = `
    import { installGuards } from ${JSON.stringify(join(here, 'guards.mjs'))};
    import fs, { writeFileSync, mkdirSync } from 'node:fs';
    import { writeFile } from 'node:fs/promises';
    import net from 'node:net';
    const report = installGuards({ protectedRoots: [${JSON.stringify(guarded)}], tempRoot: ${JSON.stringify(temp)} });
    const out = {};
    const attempt = (key, fn) => { try { fn(); out[key] = 'ok'; } catch (error) { out[key] = error.code; } };
    attempt('direct', () => writeFileSync(${JSON.stringify(join(guarded, 'cordis.yml'))}, 'x'));
    attempt('throughLink', () => mkdirSync(${JSON.stringify(join(temp, 'link-to-real', 'state'))}));
    attempt('temp', () => writeFileSync(${JSON.stringify(join(temp, 'ok.txt'))}, 'x'));
    out.promises = await writeFile(${JSON.stringify(join(guarded, 'p.txt'))}, 'x').then(() => 'ok', error => error.code);
    out.callback = await new Promise(done => fs.open(${JSON.stringify(join(guarded, 'c.txt'))}, 'w', error => done(error?.code ?? 'ok')));
    out.fetch = await fetch('https://example.com').then(() => 'ok', error => error.code);
    out.tcp = await new Promise(done => net.connect(443, 'example.com').on('error', error => done(error.code)).on('connect', () => done('ok')));
    const server = net.createServer();
    out.listen = await new Promise(done => server.listen(3081, '0.0.0.0', () => { const a = server.address(); server.close(); done(a.address + ':' + (a.port !== 3081)); }));
    console.log(JSON.stringify({ out, report }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { out, report } = JSON.parse(run.stdout);
  assert.deepEqual(out, { direct: 'EROFS', throughLink: 'EROFS', temp: 'ok', promises: 'EROFS', callback: 'EROFS', fetch: 'ENETUNREACH', tcp: 'ENETUNREACH', listen: '127.0.0.1:true' });
  assert.equal(report.deniedWrites.length, 4);
  assert.equal(report.blockedNetwork.length, 2);
  assert.deepEqual(report.rebound, ['0.0.0.0:3081']);
  assert.equal(existsSync(join(guarded, 'cordis.yml')), false);
});

test('sandbox copies the profile below a shadow HOME; state and secrets stay out', async () => {
  const root = await realpath(await scratch('prompt-audit-home-'));
  const home = join(root, 'home'), dsh = join(home, '.dsh'), profile = join(dsh, 'profiles', 'p');
  await mkdir(join(home, 'git/my/repo/plugins'), { recursive: true });
  await writeFile(join(home, 'git/my/repo/plugins/x.mjs'), 'export {}');
  await mkdir(join(profile, 'state'), { recursive: true });
  await mkdir(join(dsh, 'sessions')); await mkdir(join(dsh, 'dsh-auth')); await mkdir(join(dsh, 'skills'));
  await writeFile(join(dsh, 'AGENTS.md'), 'owner');
  await writeFile(join(dsh, 'cordis.patch.yml'), '[]');
  await writeFile(join(profile, 'cordis.patch.yml'), '- insert: [{ id: x, name: ../../../git/my/repo/plugins/x.mjs }]');
  await writeFile(join(profile, 'package.json'), '{}');
  await mkdir(join(root, 'runtime'));
  await symlink(join(root, 'runtime'), join(dsh, 'profiles', 'node_modules'));
  await symlink('../node_modules', join(profile, 'node_modules'));
  const box = await createSandbox({ home, dshHome: dsh, profile: 'p' });
  assert.ok(box.root.startsWith(await realpath(tmpdir())), 'sandbox lives in the system temp dir');
  assert.equal(box.tempDshHome, join(box.shadowHome, '.dsh'));
  assert.deepEqual(box.inputs, ['AGENTS.md', 'skills']);
  assert.equal(existsSync(join(box.tempDshHome, 'sessions')) || existsSync(join(box.tempDshHome, 'dsh-auth')) || existsSync(join(box.tempDshHome, 'cordis.patch.yml')), false);
  assert.ok(lstatSync(join(box.profileDir, 'cordis.patch.yml')).isFile(), 'profile files are copies, never links into ~/.dsh');
  assert.equal(await readlink(join(box.profileDir, 'node_modules')), join(dsh, 'profiles', 'node_modules'));
  assert.equal(await readlink(join(box.tempDshHome, 'profiles', 'node_modules')), join(root, 'runtime'));
  assert.deepEqual(box.skippedProfileDirs, ['state']);
  // The profile-relative plugin path resolves to the same real file as from ~/.dsh.
  assert.equal(await realpath(resolve(box.profileDir, '../../../git/my/repo/plugins/x.mjs')), join(home, 'git/my/repo/plugins/x.mjs'));
  assert.deepEqual(dshHomeInputs(['AGENTS.md', 'CLAUDE.md', 'oauth-tokens', '.env', 'Companion', 'logs', 'skills', '.agent-presets', 'sessions']), ['.agent-presets', 'AGENTS.md', 'CLAUDE.md', 'skills']);
});

// ── end to end, against the installed runtime ────────────────────────────────

const anchor = resolveAnchor();
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const hasProfile = name => anchor !== undefined && existsSync(join(dshHome, 'profiles', name, 'package.json'));
const fingerprint = dir => Object.fromEntries(readdirSync(dir).map(name => {
  const path = join(dir, name), stat = lstatSync(path);
  return [name, stat.isFile() ? `${stat.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}` : `${stat.isSymbolicLink() ? 'link' : 'dir'}:${statSync(path).mtimeMs}`];
}));

for (const profile of ['dsh-tui', 'companion']) {
  test(`${profile}: offline capture never touches the real profile`, { skip: !hasProfile(profile) && `no ${profile} profile or runtime here`, timeout: 180_000 }, async () => {
    const realProfile = join(dshHome, 'profiles', profile);
    const before = fingerprint(realProfile);
    const scratchDir = await scratch('prompt-audit-test-');
    const result = await auditProfile(profile, { baselineDir: join(scratchDir, 'baseline'), dumps: join(scratchDir, 'dumps') });
    assert.deepEqual(fingerprint(realProfile), before, 'real profile files changed');
    assert.ok(result.summary, JSON.stringify(result.problems));
    assert.equal(result.notes.some(note => /model requests reached/.test(note)), false, 'exactly one request reached the audit route');
    for (const note of result.notes.filter(n => n.startsWith('blocked write'))) assert.doesNotMatch(note, /~\/\.dsh\//, `boot tried to write the real DSH_HOME: ${note}`);
    const sandbox = result.notes.find(note => note.startsWith('sandbox')).split(': ')[1];
    assert.ok(sandbox.startsWith(await realpath(tmpdir())), 'sandbox outside the system temp dir');
    const current = await readFile(join(scratchDir, 'dumps', `${profile}.current.txt`), 'utf8');
    assert.match(current, /<probe>/);
    assert.doesNotMatch(current, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'unnormalized HOME in the rendering');
  });
}

test('dsh-tui: re-created regressions are reported with their exact sections', { skip: !hasProfile('dsh-tui') && 'no dsh-tui profile or runtime here', timeout: 180_000 }, async () => {
  const scratchDir = await scratch('prompt-audit-test-');
  const result = await auditProfile('dsh-tui', { patches: [join(here, 'fixtures/regressions.patch.yml')], baselineDir: join(scratchDir, 'baseline'), dumps: join(scratchDir, 'dumps') });
  assert.equal(result.status, 'fail');
  const where = new Map(result.hits.map(hit => [hit.phrase, hit.where]));
  assert.match(where.get('playful'), /section working-activity:/);
  assert.match(where.get('[Status line]'), /section working-activity:/);
  assert.match(where.get('powered by DeepSeek Harness'), /section harness:identity/);
  assert.match(where.get('coding agent powered by'), /section deployment:persona-prefix/);
  const refused = await auditProfile('dsh-tui', { update: true, patches: [join(here, 'fixtures/regressions.patch.yml')], baselineDir: join(scratchDir, 'baseline'), dumps: join(scratchDir, 'dumps') });
  assert.equal(refused.status, 'fail');
  assert.equal(existsSync(join(scratchDir, 'baseline', 'dsh-tui.txt')), false, '--update never bakes a denylisted phrase into a baseline');
});

test('dsh-tui: a baseline mismatch fails with a unified diff of the changed line', { skip: !hasProfile('dsh-tui') && 'no dsh-tui profile or runtime here', timeout: 180_000 }, async () => {
  const scratchDir = await scratch('prompt-audit-test-');
  const committed = await readFile(join(here, 'baseline/dsh-tui.txt'), 'utf8');
  await mkdir(join(scratchDir, 'baseline'));
  await writeFile(join(scratchDir, 'baseline/dsh-tui.txt'), committed.replace(/^profile: dsh-tui$/m, 'profile: tampered'));
  const result = await auditProfile('dsh-tui', { baselineDir: join(scratchDir, 'baseline'), dumps: join(scratchDir, 'dumps') });
  assert.equal(result.status, 'fail');
  assert.match(result.diff, /^-profile: tampered\n\+profile: dsh-tui$/m);
});
