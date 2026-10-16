#!/usr/bin/env node
// The SDK wraps the owner's AGENTS.md/CLAUDE.md files as optional guidance ("may be
// relevant… Use them as guidance when applicable… They do not override system,
// developer, or direct user instructions"). A literal model then weighs the owner's
// rules below harness boilerplate. The owner wants them as standing rules that only his
// direct messages outrank, so the three wrapper sentences are replaced. Like
// protocol.mjs this is hash-guarded: an unknown SDK build is refused, never guessed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const OLD_INTRO = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.';
const NEW_INTRO = "The following are the user's standing workspace instructions; follow them. More specific instructions take precedence over broader ones, and the user's direct messages in this conversation take precedence over these files.";
const OLD_SCOPED = 'Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.';
const NEW_SCOPED = "Follow them there; more specific instructions take precedence, and the user's direct messages take precedence over these files.";

export const agentInstructionsTarget = Object.freeze({
  package: '@deepseek-ai/dsh-agent-instructions',
  version: '0.2.0-rc.2',
  path: 'lib/index.js',
  before: 'e15b1a6340ea1cb7c64810a17049b7d930b89833fdf7b8d7868e46e7988a72e1',
  after: '4bc3822a47eda80b5f132439eb2aac5ce2799975d5f10b2e1921f533be6e2c67',
  // [old, new, exact occurrence count]: the intro also opens the replacement baseline.
  replacements: Object.freeze([[OLD_INTRO, NEW_INTRO, 2], [OLD_SCOPED, NEW_SCOPED, 1]]),
});

export function patchAgentInstructions(bytes, target = agentInstructionsTarget, { checkAfter = true } = {}) {
  assert.equal(hash(bytes), target.before, `Unsupported ${target.package} build: ${target.path}`);
  let text = bytes.toString('utf8');
  for (const [from, to, count] of target.replacements) {
    assert.equal(text.split(from).length - 1, count, `Unexpected wrapper text count in ${target.path}`);
    text = text.replaceAll(from, to);
  }
  const out = Buffer.from(text);
  if (checkAfter) assert.equal(hash(out), target.after, 'Patched agent-instructions hash differs from review');
  return out;
}

/** Patch the installed package in place; an already patched file is reported, not re-patched. */
export async function installAgentInstructions({ packageRoot }, { target = agentInstructionsTarget, read = readFile, write = writeFile } = {}) {
  assert.equal(packageRoot, resolve(packageRoot), 'packageRoot must be absolute and normalized');
  assert.equal(await realpath(packageRoot), packageRoot, 'Package must be canonical');
  const manifest = JSON.parse(await read(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, target.package);
  assert.equal(manifest.version, target.version, `Unsupported ${target.package} version ${manifest.version}`);
  const path = join(packageRoot, target.path);
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Regular library file required');
  const before = await read(path);
  if (hash(before) === target.after) return { path, state: 'already-patched', sha256: target.after };
  const after = patchAgentInstructions(before, target);
  assert.equal(hash(await read(path)), hash(before), 'Concurrent SDK edit');
  await write(path, after);
  assert.equal(hash(await read(path)), target.after, 'agent-instructions write verification failed');
  return { path, state: 'patched', beforeSha256: target.before, afterSha256: target.after };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, runtime] = process.argv.slice(2);
  if (flag !== '--apply' || !runtime) {
    console.log('Usage: node tools/clean-install/agent-instructions.mjs --apply <dsh-cli runtime root>');
    process.exitCode = flag ? 2 : 0;
  } else {
    try {
      const packageRoot = await realpath(join(resolve(runtime), 'node_modules', agentInstructionsTarget.package));
      console.log(JSON.stringify(await installAgentInstructions({ packageRoot }), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
