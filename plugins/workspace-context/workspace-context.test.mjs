import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { apply, machineEnvironment, workspaceContext, workspacePaths } from './index.mjs';

function promptFixture() {
  const sections = [], contexts = [];
  // Only registrations are emulated: native assembly/dedup belongs to DSH.
  const systemPrompt = {
    getSectionOrder(name) { assert.equal(name, 'TOOL_BASH'); return 100; },
    getContextOrder(name) { assert.equal(name, 'SANDBOX_POLICY'); return 200; },
    section(value) { sections.push(value); },
    context(value) { contexts.push(value); },
  };
  apply({ systemPrompt });
  return { sections, contexts };
}

const agentAt = (cwd) => ({ session: { header: { cwd } } });
const parseContext = (text) => {
  assert.ok(text.startsWith('Workspace paths: '));
  return JSON.parse(text.slice('Workspace paths: '.length));
};

test('cwd and prompt contracts with isolated local Git fixtures', async (t) => {
  const dumps = fileURLToPath(new URL('../../.dumps/', import.meta.url));
  mkdirSync(dumps, { recursive: true });
  const base = realpathSync.native(mkdtempSync(join(dumps, 'workspace-context-test-')));
  const dumpsCanonical = realpathSync.native(dumps);
  // The suite changes only its own process environment; never inherit user Git overrides.
  const inheritedGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, inheritedGit);
    // Verify the exact owned path before recursive cleanup.
    assert.equal(dirname(base), dumpsCanonical);
    assert.ok(basename(base).startsWith('workspace-context-test-'));
    rmSync(base, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    // .dumps is inside this repository: stop discovery before reaching its real .git.
    GIT_CEILING_DIRECTORIES: base,
  });
  const root = join(base, 'repo'), sub = join(root, 'sub'), outside = join(base, 'outside');
  mkdirSync(sub, { recursive: true });
  mkdirSync(outside);
  const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(init.error);
  assert.equal(init.status, 0, init.stderr);
  const logical = join(base, 'logical-sub');
  symlinkSync(sub, logical);

  await t.test('root and subdirectory retain cwd and canonical Git-relative paths', () => {
    assert.deepEqual(workspacePaths(root), {
      working_directory: root, git_root: root, working_directory_relative_to_git_root: '.',
    });
    assert.deepEqual(workspacePaths(sub), {
      working_directory: sub, git_root: root, working_directory_relative_to_git_root: 'sub',
    });
  });

  await t.test('outside the fixture worktree means confirmed absence, not an error', () => {
    assert.deepEqual(workspacePaths(outside), {
      working_directory: outside, git_root: null, working_directory_relative_to_git_root: null,
    });
  });

  await t.test('symlink keeps logical cwd while Git root and relative path are canonical', () => {
    assert.deepEqual(workspacePaths(logical), {
      working_directory: logical, working_directory_canonical: sub,
      git_root: root, working_directory_relative_to_git_root: 'sub',
    });
    assert.deepEqual(parseContext(workspaceContext(logical)), workspacePaths(logical));
  });

  await t.test('missing cwd reports discovery error rather than confirmed absence', () => {
    const missing = join(base, 'missing');
    assert.deepEqual(workspacePaths(missing), {
      working_directory: missing, git_root: null, working_directory_relative_to_git_root: null,
      git_discovery_error: 'working directory not found',
    });
  });

  await t.test('machine facts are static; paths are a runtime provider without persona replacement', () => {
    const { sections, contexts } = promptFixture();
    assert.deepEqual(sections, [{
      name: 'alex-workspace:machine', order: 101, text: machineEnvironment, interpolate: false,
    }]);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].name, 'alex-workspace:paths');
    assert.equal(contexts[0].order, 190);
    assert.equal(typeof contexts[0].text, 'function');
  });

  await t.test('session providers stay separate and describe session cwd, not per-call workdir', () => {
    const { contexts: [{ text }] } = promptFixture();
    const first = agentAt(sub), second = agentAt(outside);
    const firstSnapshot = text({ agent: first, workdir: outside });
    assert.deepEqual(parseContext(firstSnapshot), workspacePaths(sub));
    assert.deepEqual(parseContext(text({ agent: second })), workspacePaths(outside));
    assert.equal(text({ agent: first }), firstSnapshot);
  });

  await t.test('provider emits no workspace block without a session cwd', () => {
    const { contexts: [{ text }] } = promptFixture();
    assert.equal(text({}), '');
    assert.equal(text({ agent: agentAt(undefined) }), '');
  });
});
