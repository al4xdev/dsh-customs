#!/usr/bin/env node
// Opt-in integration checks: real provider calls, synthetic drafts only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, bridgeKey } from './index.mjs';
import { useLegacyCodex } from './live-auth.mjs';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const require = createRequire(join(home, 'profiles', process.env.GRAMMAR_PROFILE ?? 'dsh-tui', 'package.json'));
const load = async (id) => import(pathToFileURL(require.resolve(id)).href);
const reportPath = resolve(fileURLToPath(new URL('../../.dumps/grammar/', import.meta.url)), `${Date.now()}.json`);
const cases = [
  { name: 'pt', language: 'pt', input: 'Os dois arquivo está pronto.', expected: 'Os dois arquivos estão prontos.' },
  { name: 'auto-en', language: 'auto', input: 'She have two file.', expected: 'She has two files.' },
  {
    name: 'technical', language: 'pt-BR',
    input: 'Os dois arquivo está pronto.\nUse `git status` em src/main.ts e https://example.com/a?x=1.\nMantenha "user_id".',
    expected: 'Os dois arquivos estão prontos.\nUse `git status` em src/main.ts e https://example.com/a?x=1.\nMantenha "user_id".',
  },
];
const report = { startedAt: new Date().toISOString(), results: [] };
let ctx;
try {
  const [{ Context }, { default: runtime }, { default: credentials }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-credentials-local'),
  ]);
  ctx = new Context();
  await ctx.plugin(runtime);
  // OAuth refresh may update the existing credential store, just as in DSH.
  await ctx.plugin(credentials, { path: join(home, '.credentials.yaml'), watch: false });
  let restoreCredentials = () => {};
  const routes = [
    {
      name: 'gpt', model: process.env.GRAMMAR_GPT_MODEL ?? 'openai-codex/gpt-6-sol',
      async mount() {
        assert.ok(this.model.startsWith('openai-codex/'), 'GPT check requires the installed Codex OAuth route');
        const plugin = await load('@deepseek-ai/dsh-llm-pi-ai');
        restoreCredentials = await useLegacyCodex(ctx.credentials, plugin.recordKeyFor('openai-codex'), join(home, 'dsh-auth/credentials.json'));
        return ctx.plugin(plugin, { providers: { 'openai-codex': {} } });
      },
    },
    {
      name: 'gemini', model: process.env.GRAMMAR_GEMINI_MODEL ?? 'google-antigravity/gemini-3.8-flash-low',
      mount: async () => ctx.plugin(await load('@deepseek-ai/dsh-llm-pi-ai-antigravity'), {}),
    },
    {
      name: 'local', model: process.env.GRAMMAR_LOCAL_MODEL,
      async mount() {
        const plugin = await load('@deepseek-ai/dsh-llm-llamacpp');
        const baseURL = process.env.LLAMACPP_BASE_URL ?? 'http://127.0.0.1:8080';
        const models = await plugin.discoverModels(baseURL, AbortSignal.timeout(10_000));
        if (!this.model) {
          if (models.length !== 1) throw new Error('Set GRAMMAR_LOCAL_MODEL=llamacpp-local/<id> when server advertises zero or multiple models.');
          this.model = `llamacpp-local/${models[0].id}`;
        }
        return ctx.plugin(plugin, { baseURL, models });
      },
    },
  ];
  for (const route of routes) {
    let providerFiber;
    try {
      providerFiber = await route.mount();
      for (const fixture of cases) {
        let dispose;
        const result = { route: route.name, model: route.model, case: fixture.name, input: fixture.input };
        const started = Date.now();
        try {
          apply({ llm: ctx.llm, effect(register) { dispose = register(); } }, { model: route.model, language: fixture.language });
          result.output = await globalThis[bridgeKey].fix(fixture.input, undefined, AbortSignal.timeout(120_000));
          assert.equal(result.output, fixture.expected);
          result.passed = true;
          console.log(`PASS ${route.name}/${fixture.name} (${Date.now() - started} ms)`);
        } catch (error) {
          result.passed = false;
          // Do not dump provider error bodies: they can contain auth/request data.
          result.error = { name: error.name, code: error.code ?? 'CHECK_FAILED' };
          console.error(`FAIL ${route.name}/${fixture.name}: ${result.error.name} ${result.error.code}`);
        } finally {
          dispose?.();
          result.durationMs = Date.now() - started;
          report.results.push(result);
        }
      }
    } catch (error) {
      report.results.push({ route: route.name, model: route.model, passed: false, error: { name: error.name, code: error.code ?? 'PROVIDER_SETUP_FAILED' } });
      console.error(`FAIL ${route.name}: provider setup failed (${error.code ?? error.name})`);
    } finally {
      try {
        await providerFiber?.dispose();
      } finally {
        restoreCredentials();
        restoreCredentials = () => {};
      }
    }
  }
} catch (error) {
  report.results.push({ passed: false, error: { name: error.name, code: error.code ?? 'RUNTIME_SETUP_FAILED' } });
  console.error(`FAIL runtime setup (${error.code ?? error.name})`);
} finally {
  await ctx?.fiber.dispose();
  report.finishedAt = new Date().toISOString();
  report.passed = report.results.length === 9 && report.results.every((result) => result.passed);
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Report: ${reportPath}`);
  if (!report.passed) process.exitCode = 1;
}
