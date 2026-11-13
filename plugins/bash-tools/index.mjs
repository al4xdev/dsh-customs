// The stock bash tool (`@deepseek-ai/dsh-tool-bash`) with the frontier model's shell
// practice appended to its description, where every model reads it at the moment it
// decides how to call the shell.
//
// Why: a per-model study over 3 224 DSH sessions (two machines) against the reference Fable
// session in Claude Code. Fable bounds 83% of its bash output at the source; Codex and
// Gemini bound 0-5% and rely on the harness to cut the tail, so their dumps stay in the
// context for the rest of the session. Fable batches independent probes with `;` (89% of
// its calls; a probe that finds nothing exits 1 and must not stop the rest) and keeps `&&`
// for dependent steps; Codex runs one short command per step. Cross-tool habits (parallel
// calls, read for images, scripts for analysis) live in the owner's AGENTS.md instead.
//
// Everything else is the stock plugin: background jobs, timeout promotion, the sandbox
// escalation fields, the TUI cards and the `tool:bash` prompt section.
import { intercept, resolveHost } from '../common.mjs';

const stock = await import(resolveHost('@deepseek-ai/dsh-tool-bash'));

export const name = 'alex-bash-tools';
export const inject = stock.inject;
export const Config = stock.Config;

export const PRACTICE = 'Bound what you print at the source: `| head -40`, `sed -n 120,180p file`, `grep -m 20`, `2>&1 | tail -30` for builds and tests, `wc -l` first for a file of unknown size. Batch independent probes in one call separated by `;` (one that finds nothing exits 1 and must not stop the rest); use `&&` only when a step needs the previous one. Search with a path or glob filter and leave vendored and build directories out. Give long builds and tests `timeoutMs`; start servers with `run_in_background`.';

/** The stock definition with the practice appended to its description. */
export const withPractice = definition => (definition.name === 'bash' ? { ...definition, description: `${definition.description}\n\n${PRACTICE}` } : definition);

export function apply(ctx, config) {
  // The stock plugin registers through this same context, also from inside its
  // `inject(['jobs'])` callback (it closes over `ctx`), so one view covers both variants.
  const tools = intercept(ctx.tools, { register: definition => ctx.tools.register(withPractice(definition)) });
  return stock.apply(intercept(ctx, { tools }), config);
}
