#!/usr/bin/env node
// Child process of audit.mjs (never run by hand): boot one DSH profile in-process with
// the installed runtime, create a fresh agent the way dsh-tui and dsh-web do (default
// preset resolved first, mounted in the agent factory's setup), send one probe message
// and record what the first model request carries.
//
// Never boots the real profile directory. dsh rewrites a profile's root cordis.yml on
// every boot (and `--dump-config`), even when identical; profiles with
// `patchReload: live` (Companion) and running TUIs hot-reload on that write, and the
// lab Companion then latches a stale service state until restarted. The profile is a
// copy inside the sandbox DSH_HOME (sandbox.mjs); the check below refuses to start
// if that ever resolves into the real DSH_HOME.
//
// Offline by construction: the agent's route is a fake adapter that answers "OK"; any
// other model call (grammar fix, titles, side queries) is answered with an error by an
// `llm/stream` fence before its adapter runs; guards.mjs refuses outbound TCP/fetch and
// writes into the real DSH_HOME.
//
//   node capture.mjs --anchor <dsh package.json> --profile <name> --out <file.json> [--patch <yml>]...
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalTarget, installGuards, isUnder } from './guards.mjs';
import { PROBE_TEXT } from './model.mjs';

const { values: args } = parseArgs({ options: { anchor: { type: 'string' }, profile: { type: 'string' }, out: { type: 'string' }, patch: { type: 'string', multiple: true, default: [] } } });
// audit.mjs preloads the fences (preload.mjs) so workers get them too; install here if not.
const guard = globalThis.__promptAuditGuard ?? installGuards({ protectedRoots: (process.env.PROMPT_AUDIT_PROTECT ?? '').split(':'), tempRoot: process.env.PROMPT_AUDIT_TEMP });

const BIN = 'prompt-audit';
export const AUDIT_PROVIDER = 'prompt-audit';
export const AUDIT_MODEL = 'prompt-audit-model';
const IDLE_TIMEOUT_MS = 60_000;

// Host rows that are side channels, never model-facing text: LLM titles, telemetry
// export, Companion's push, private link and OAuth adapter (built from the TUI fork,
// absent on hosts without that build), and the dsh-tui session bridge. A patch naming
// an absent id is only a Loader warning, so one list serves every profile. hmr and
// plugin-manager stay mounted: they have no side effect here, and the `cordis` preset
// reports itself broken without plugin-manager.
export const SURFACE_ROWS = ['session-title-llm', 'session-telemetry-otel', 'companion-oauth', 'companion-native-host',
  'companion-private-link', 'alex-session-bridge'];

const requireHost = createRequire(args.anchor);
const load = name => import(pathToFileURL(requireHost.resolve(`@deepseek-ai/${name}`)).href);
const detach = value => JSON.parse(JSON.stringify(value, (key, item) => (key === 'signal' ? undefined : item)));

async function capture() {
  const temp = process.env.PROMPT_AUDIT_TEMP;
  const home = process.env.DSH_HOME;
  const [boot, llm, cmdline, prompt] = await Promise.all(['dsh-app-boot', 'dsh-llm', 'dsh-cmdline', 'dsh-system-prompt'].map(load));
  const dir = join(home, 'profiles', args.profile);
  const protectedRoots = (process.env.PROMPT_AUDIT_PROTECT ?? '').split(':').filter(Boolean).map(canonicalTarget);
  if (!process.env.PROMPT_AUDIT_TEMP || protectedRoots.some(root => isUnder(canonicalTarget(dir), root))) {
    throw new Error(`refusing to boot ${dir}: only a sandbox copy of the profile may be booted`);
  }
  // dsh rewrites the profile root to an empty entry list before every boot; this is
  // the sandbox copy, so do the same (a Loader write-back baked into the real file
  // must not change what the audit composes).
  const rootConfig = join(dir, 'cordis.yml');
  writeFileSync(rootConfig, '# prompt-audit: empty profile root, as dsh writes it before boot.\n[]\n');
  const profile = boot.loadProfileDirectory(BIN, dir, args.anchor);
  const overlays = [
    ...SURFACE_ROWS.map(id => ({ id, disabled: true })),
    { id: 'session-persistence-jsonl', config: { root: join(temp, 'sessions'), compression: 'none' } },
    ...args.patch.flatMap(file => boot.loadOverlayPatches(BIN, resolve(file))),
  ];
  const origin = {
    name: args.profile, dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: args.anchor,
    cwd: process.cwd(), home, startedBundles: profile.layers.map(layer => layer.packageName), overlays, telemetryDisabledEnv: '1',
  };
  const resolution = await boot.createRuntimeResolution({ installAnchor: args.anchor, profile, home });
  const ctx = await boot.boot(BIN, rootConfig, boot.readProfilePatches(BIN, origin, profile), async host => {
    host.provide('profileContext', origin);
    await host.plugin(boot.PluginPackages, { resolution });
    // Readiness is never committed: surfaces waiting on it stay idle.
    cmdline.provideCmdline(host, { args: [], exit: () => {}, ready: { onReady: () => () => {} } });
  });

  const requests = [];
  const sideCalls = [];
  ctx.llm.registerAdapter([AUDIT_PROVIDER], new class extends llm.LlmAdapter {
    async listModels() { return [{ id: AUDIT_MODEL, name: 'Prompt audit', contextWindow: 272000, maxTokens: 32000, input: ['text', 'image'], output: ['text'] }]; }
    async *stream(options) {
      requests.push(detach(options));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'OK' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
  ctx.on('llm/stream', async function* offlineFence(options, next) {
    if (options.provider === AUDIT_PROVIDER) { yield* next(); return; }
    sideCalls.push({ provider: options.provider, model: options.model, purpose: options.purpose ?? null });
    yield { type: 'finish', reason: { kind: 'error', error: { code: 'PROMPT_AUDIT_OFFLINE', message: 'prompt-audit: model calls are offline' } } };
  });

  const presets = ctx.get('agentPresets');
  const preset = presets === undefined ? undefined : await presets.resolve(undefined);
  let assembly;
  const { agent } = await ctx.agents.create({
    sessionId: crypto.randomUUID(),
    meta: { cwd: process.cwd(), ...(preset ? { agentPreset: preset.id } : {}) },
    agentOptions: { provider: AUDIT_PROVIDER, model: AUDIT_MODEL },
    setup: async agentCtx => {
      if (preset) await presets.mount(agentCtx, preset.id);
      // Section names only label the final system text; the request stays the source of truth.
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next();
        assembly = detach(assembled);
        return assembled;
      });
    },
  });
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: PROBE_TEXT }], source: { kind: 'user' } }));
  let timer;
  await Promise.race([agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`agent not idle after ${IDLE_TIMEOUT_MS} ms`)), IDLE_TIMEOUT_MS); })]);
  clearTimeout(timer);

  const skillRegistry = presets?.serviceFor?.(agent, 'skills') ?? ctx.get('skills');
  const skills = skillRegistry === undefined ? [] : (await skillRegistry.list({ cwd: process.cwd(), scope: agent }))
    .map(skill => ({ name: skill.name, path: skill.path ?? null, source: skill.source, provider: skill.provider }));
  const render = section => prompt.renderPrompt({ sections: [section], contexts: [], tools: [], variables: assembly.variables });
  return {
    profile: args.profile,
    bundles: origin.startedBundles,
    preset: preset ? preset.id : null,
    presets: presets ? (await presets.list()).map(row => ({ id: row.id, broken: row.broken ?? null })) : [],
    request: requests[0] ?? null,
    requestCount: requests.length,
    systemSections: assembly ? assembly.sections.map(section => ({ name: section.name, text: render(section) })) : [],
    skills,
    sideCalls,
  };
}

try {
  const result = await capture();
  writeFileSync(args.out, JSON.stringify({ ...result, guard }, null, 2));
  // Teardown is skipped on purpose: the capture is complete and disposal only adds
  // plugin side effects (flushes, write-backs) the audit has no use for.
  process.exit(0);
} catch (error) {
  process.stderr.write(`prompt-audit capture failed: ${error?.stack ?? error}\n`);
  try { writeFileSync(args.out, JSON.stringify({ error: String(error?.stack ?? error), guard }, null, 2)); } catch { /* the parent reports the missing file */ }
  process.exit(1);
}
