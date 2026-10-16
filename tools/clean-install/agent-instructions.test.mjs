import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentInstructionsTarget, installAgentInstructions, patchAgentInstructions } from './agent-instructions.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const fixtureTarget = bytes => ({ ...agentInstructionsTarget, before: sha(bytes), after: sha(patchAgentInstructions(bytes, { ...agentInstructionsTarget, before: sha(bytes) }, { checkAfter: false })) });
const fixtureSource = () => Buffer.from([
  `const A = "${'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'}";`,
  `const B = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ${'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'}";`,
  'const C = `These instructions apply to work under \\`${scope}\\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`;',
].join('\n'));

test('wrapper sentences become standing rules; nothing else changes', () => {
  const bytes = fixtureSource();
  const out = patchAgentInstructions(bytes, fixtureTarget(bytes)).toString();
  assert.equal((out.match(/standing workspace instructions; follow them/g) ?? []).length, 2);
  assert.match(out, /Follow them there; more specific instructions take precedence/);
  assert.doesNotMatch(out, /guidance|do not override/);
  assert.match(out, /replaces all earlier workspace instruction baselines\. The following are/);
  assert.match(out, /\\`\$\{scope\}\\`\. Follow them there/, 'template placeholder kept');
});

test('unknown builds and unexpected counts are refused', () => {
  assert.throws(() => patchAgentInstructions(Buffer.from('foreign')), /Unsupported/);
  const twice = Buffer.concat([fixtureSource(), fixtureSource()]);
  assert.throws(() => patchAgentInstructions(twice, { ...agentInstructionsTarget, before: sha(twice) }), /Unexpected wrapper text count/);
});

test('install patches once, then reports already-patched; foreign package refused before writing', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-instructions-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: agentInstructionsTarget.package, version: agentInstructionsTarget.version }));
  const bytes = fixtureSource();
  await writeFile(join(root, 'lib/index.js'), bytes);
  const target = fixtureTarget(bytes);
  assert.equal((await installAgentInstructions({ packageRoot: root }, { target })).state, 'patched');
  assert.equal(sha(await readFile(join(root, 'lib/index.js'))), target.after);
  assert.equal((await installAgentInstructions({ packageRoot: root }, { target })).state, 'already-patched');
  await writeFile(join(root, 'lib/index.js'), 'foreign SDK');
  let writes = 0;
  await assert.rejects(installAgentInstructions({ packageRoot: root }, { target, write() { writes++; } }), /Unsupported/);
  assert.equal(writes, 0);
  await assert.rejects(installAgentInstructions({ packageRoot: 'relative' }), /absolute/);
});

test('reviewed hashes match the installed SDK build when present', t => {
  const lib = join(homedir(), '.local/share/dsh-cli/node_modules', agentInstructionsTarget.package, agentInstructionsTarget.path);
  if (!existsSync(lib)) return t.skip('no local runtime');
  const bytes = readFileSync(lib);
  if (sha(bytes) === agentInstructionsTarget.after) return; // already patched in place
  assert.equal(sha(patchAgentInstructions(bytes)), agentInstructionsTarget.after);
});
