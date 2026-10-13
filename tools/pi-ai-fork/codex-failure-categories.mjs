import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, symlink, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const baselineCodexHash = '206545bfd51ee0284248e00b39fa5736e212d6b4ff8394bbf27013d1353c089b';
const here = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function once(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Reviewed source context changed');
  return source.replace(before, after);
}
export function patchCodexSource(original) {
  assert.equal(sha(original), baselineCodexHash, 'Codex source is not the immutable reviewed baseline');
  let source = once(original,
    'import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";',
    'import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";\nimport { classifyCodexFailure, codexHttpFailureFacts, reportCodexFailure } from "../utils/provider-failure.ts";');
  source = once(source,
    '\t\t\toutput.errorMessage = formatProviderError(normalizeProviderError(error));',
    '\t\t\t// Final only: recovered WebSocket/SSE attempts must not report stale failures.\n\t\t\treportCodexFailure(error, model.provider, options?.signal?.aborted);\n\t\t\toutput.errorMessage = formatProviderError(normalizeProviderError(error));');
  source = once(source, '\t\t\t\t\t\tstatusText: response.statusText,', '\t\t\t\t\t\tstatusText: response.statusText,\n\t\t\t\t\t\theaders: response.headers,');
  source = once(source, '\t\t\t\t\tthrow new Error(info.friendlyMessage || info.message);', '\t\t\t\t\tthrow new CodexApiError(info.friendlyMessage || info.message, info);');
  source = once(source, 'class CodexApiError extends Error {\n\treadonly code?: string;\n\treadonly payload?: Record<string, unknown>;',
    'class CodexApiError extends Error {\n\treadonly code?: string;\n\treadonly type?: string;\n\treadonly status?: number;\n\treadonly providerRetryAfterMs?: number;\n\treadonly payload?: Record<string, unknown>;');
  source = once(source, 'options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }',
    'options?: { code?: string; type?: string; status?: number; providerRetryAfterMs?: number; payload?: Record<string, unknown>; cause?: unknown }');
  source = once(source, '\t\tthis.name = "CodexApiError";\n\t\tthis.code = options?.code;', '\t\tthis.name = "CodexApiError";\n\t\tthis.code = options?.code;\n\t\tthis.type = options?.type;\n\t\tthis.status = options?.status;\n\t\tthis.providerRetryAfterMs = options?.providerRetryAfterMs;');
  // Preserve transport fallback eligibility: these remain ordinary Errors, not API errors.
  for (const text of ['Codex SSE response headers timed out after ${httpTimeoutMs}ms', 'WebSocket connect timeout after ${connectTimeoutMs}ms', 'WebSocket idle timeout after ${idleTimeoutMs}ms']) {
    source = once(source, 'new Error(`' + text + '`)', 'Object.assign(new Error(`' + text + '`), { code: "timeout_error" })');
  }
  // Preserve the existing display string, but determine quota presentation only from machine facts.
  const start = source.indexOf('async function parseErrorResponse(response: Response):');
  const end = source.indexOf('\n// ============================================================================\n// Auth & Headers', start);
  assert(start > 0 && end > start);
  source = source.slice(0, start) + `async function parseErrorResponse(response: Response): Promise<{
  message: string; friendlyMessage?: string; code?: string; type?: string; status: number; providerRetryAfterMs?: number;
}> {
  const raw = await response.text();
  const facts = codexHttpFailureFacts(response.status, response.headers, raw);
  let message = raw || response.statusText || "Request failed";
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (typeof parsed?.error?.message === "string") message = parsed.error.message;
  } catch {}
  const quota = classifyCodexFailure(facts)?.code === "QUOTA";
  return { ...facts, message, ...(quota ? { friendlyMessage: "You have hit your ChatGPT usage limit." } : {}) };
}
` + source.slice(end);
  return source;
}

/** Fresh source copy + cached compiler; never install, fetch, touch historical source or promote. */
export async function prepareCodexFailureCandidate({ sourceRoot, dependencyRoot, installedRoot, output }) {
  for (const [key, path] of Object.entries({ sourceRoot, dependencyRoot, installedRoot, output })) assert.equal(path, resolve(path), `${key} must be absolute`);
  const source = await realpath(sourceRoot), dependencies = await realpath(dependencyRoot), installed = await realpath(installedRoot);
  assert(!output.startsWith(installed + '/') && !output.startsWith(source + '/'), 'Candidate must be separate from source/install');
  const original = await readFile(join(source, 'packages/ai/src/api/openai-codex-responses.ts'), 'utf8');
  const codex = patchCodexSource(original);
  const helper = await readFile(join(here, 'provider-failure.ts'), 'utf8');
  const indexOriginal = await readFile(join(source, 'packages/ai/src/index.ts'), 'utf8');
  const index = indexOriginal + '\nexport * from "./utils/provider-failure.ts";\n';
  const digest = sha(JSON.stringify({ baseline: baselineCodexHash, codex: sha(codex), helper: sha(helper), index: sha(index) }));
  await mkdir(output, { mode: 0o700 }); // Exclusive output; preserve interrupted candidates.
  const build = join(output, 'source'), ai = join(build, 'packages/ai');
  await mkdir(ai, { recursive: true });
  await cp(join(source, 'packages/ai/src'), join(ai, 'src'), { recursive: true });
  for (const name of ['package.json', 'tsconfig.build.json']) await cp(join(source, 'packages/ai', name), join(ai, name));
  await cp(join(source, 'tsconfig.base.json'), join(build, 'tsconfig.base.json'));
  await symlink(dependencies, join(build, 'node_modules'), 'dir');
  await writeFile(join(ai, 'src/api/openai-codex-responses.ts'), codex);
  await writeFile(join(ai, 'src/utils/provider-failure.ts'), helper);
  await writeFile(join(ai, 'src/index.ts'), index);
  const compiler = join(dependencies, '@typescript/native-preview/bin/tsgo.js');
  execFileSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], { cwd: ai, stdio: 'inherit' });
  const candidate = join(output, 'package');
  await cp(installed, candidate, { recursive: true, dereference: false });
  await symlink(dirname(dirname(installed)), join(candidate, 'node_modules'), 'dir');
  const prefixes = ['dist/api/openai-codex-responses', 'dist/index', 'dist/utils/provider-failure'];
  const generated = [], suffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
  for (const prefix of prefixes) for (const suffix of suffixes) {
    const path = prefix + suffix, bytes = await readFile(join(ai, path));
    let previous;
    try { previous = await readFile(join(installed, path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(join(candidate, path)), { recursive: true });
    await writeFile(join(candidate, path), bytes);
    generated.push({ path, beforeSha256: previous === undefined ? null : sha(previous), afterSha256: sha(bytes), changed: previous === undefined || !bytes.equals(previous) });
  }
  // Keep all non-owned outputs (including task32 OAuth generated bytes) identical to active install.
  const owned = new Set(generated.map(entry => entry.path));
  const protectedFiles = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative + '/');
      else if (entry.isFile() && !owned.has(relative)) {
        const before = await readFile(join(installed, relative)), after = await readFile(join(candidate, relative));
        assert(before.equals(after), `Protected SDK output changed: ${relative}`);
        protectedFiles.push({ path: relative, sha256: sha(before) });
      }
    }
  }
  await walk(installed);
  const manifest = { schema: 1, kind: 'codex-failure-categories-candidate', promoted: false,
    sourceRoot: source, dependencyRoot: dependencies, installedRoot: installed, candidate,
    baselineCodexHash, sourceDigest: digest, proposedVersion: `0.87.1+alex.codex-failures.${digest.slice(0, 12)}`,
    sourceFiles: [{ path: 'src/api/openai-codex-responses.ts', beforeSha256: sha(original), afterSha256: sha(codex) },
      { path: 'src/index.ts', beforeSha256: sha(indexOriginal), afterSha256: sha(index) }, { path: 'src/utils/provider-failure.ts', beforeSha256: null, afterSha256: sha(helper) }],
    generated, protectedFiles };
  await writeFile(join(output, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 6, 'Usage: node codex-failure-categories.mjs sourceRoot dependencyRoot installedSdk output');
  const [sourceRoot, dependencyRoot, installedRoot, output] = process.argv.slice(2).map(path => resolve(path));
  const result = await prepareCodexFailureCandidate({ sourceRoot, dependencyRoot, installedRoot, output });
  console.log(JSON.stringify({ candidate: result.candidate, sourceDigest: result.sourceDigest, generated: result.generated }, null, 2));
}
