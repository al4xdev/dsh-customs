import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, symlink, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const apis = Object.freeze(['openai-completions', 'mistral-conversations', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'anthropic-messages', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex', 'pi-messages']);
export const prefixes = [...apis.map(api => `dist/api/${api}`), 'dist/api/openai-responses-shared', 'dist/index', 'dist/utils/provider-failure'];
export const suffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
export function once(source, before, after) {
  assert.equal(source.split(before).length, 2, `Reviewed context changed: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}
export function patchApi(api, original) {
  let source = original;
  let expression = 'error';
  let imports = 'reportProviderFailure';
  if (['openai-completions', 'openai-responses', 'azure-openai-responses', 'anthropic-messages'].includes(api)) {
    const sdk = api === 'anthropic-messages' ? '@anthropic-ai/sdk' : 'openai';
    source = `import { APIConnectionTimeoutError, APIUserAbortError, APIConnectionError } from "${sdk}";\n` + source;
    // These SDK subclasses inherit Error.name and can have no own machine code.
    // instanceof stays at the dependency boundary; the portable seam never imports SDKs.
    expression = 'error instanceof APIUserAbortError ? { code: "abort_error", cause: error } : error instanceof APIConnectionTimeoutError ? { code: "timeout_error", cause: error } : error instanceof APIConnectionError ? { code: "transport_error", cause: error } : error';
  }
  if (api === 'openai-codex-responses') {
    source = once(source, 'classifyCodexFailure, codexHttpFailureFacts, reportCodexFailure', 'classifyCodexFailure, codexHttpFailureFacts, reportProviderFailure');
    source = once(source, 'reportCodexFailure(error, model.provider, options?.signal?.aborted);', 'reportProviderFailure(error, model.provider, model.api, options?.signal?.aborted);');
    source = once(source, 'readonly providerRetryAfterMs?: number;', 'readonly providerRetryAfterMs?: number;\n\treadonly requestId?: string;');
    source = once(source, 'status?: number; providerRetryAfterMs?: number; payload?: Record<string, unknown>', 'status?: number; providerRetryAfterMs?: number; requestId?: string; payload?: Record<string, unknown>');
    source = once(source, 'this.providerRetryAfterMs = options?.providerRetryAfterMs;', 'this.providerRetryAfterMs = options?.providerRetryAfterMs;\n\t\tthis.requestId = options?.requestId;');
    source = once(source, 'type?: string; status: number; providerRetryAfterMs?: number;', 'type?: string; status: number; requestId?: string; providerRetryAfterMs?: number;');
    return source;
  }
  if (api === 'mistral-conversations') {
    imports += ', codexHttpFailureFacts';
    source = once(source, 'throw new MistralHttpError(response.status, body, response.statusText);', 'throw Object.assign(new MistralHttpError(response.status, body, response.statusText), codexHttpFailureFacts(response.status, response.headers, body));');
  }
  if (api === 'anthropic-messages') {
    source = once(source, 'throw new Error(sse.data);', 'let payload: unknown;\n\t\t\ttry { payload = sse.data.length <= 1_048_576 ? JSON.parse(sse.data) : undefined; } catch {}\n\t\t\tthrow Object.assign(new Error(sse.data), { payload });');
  }
  if (api === 'bedrock-converse-stream') {
    expression = '{ cause: error, requestId: responseRequestId }';
    for (const [property, name] of [['internalServerException','InternalServerException'], ['modelStreamErrorException','ModelStreamErrorException'], ['validationException','ValidationException'], ['throttlingException','ThrottlingException'], ['serviceUnavailableException','ServiceUnavailableException']]) {
      source = once(source, `throw item.${property};`, `throw Object.assign(new Error(formatBedrockError(item.${property})), { code: "${name}", cause: item.${property} });`);
    }
  }
  if (api === 'pi-messages') {
    imports += ', codexHttpFailureFacts';
    source = once(source, 'throw createPiMessagesResponseError(model, url, response, body);', 'throw Object.assign(createPiMessagesResponseError(model, url, response, body), codexHttpFailureFacts(response.status, response.headers, body));');
    source = once(source, 'const convertEvent = createEventConverter(model);', 'const convertEvent = createEventConverter(model);\n\tconst reportFailure = (error: unknown, aborted = false) => reportProviderFailure(error, model.provider, model.api, aborted);');
    // The wire protocol has only display text, usage and reason, not a typed failure DTO.
    // Cancellation is explicit. All other wire errors stay unknown; never parse errorMessage.
    source = once(source, '\t\t\t\teventStream.push(event);', '\t\t\t\tif (event.type === "error" && event.reason === "aborted") {\n\t\t\t\t\treportFailure({ code: "abort_error" }, true);\n\t\t\t\t}\n\t\t\t\teventStream.push(event);');
    source = once(source, '\t\t} catch (error) {\n\t\t\teventStream.push(createErrorEvent', '\t\t} catch (error) {\n\t\t\treportFailure(error, options?.signal?.aborted);\n\t\t\teventStream.push(createErrorEvent');
  } else {
    const marker = '\t\t\toutput.stopReason = options' + (api === 'bedrock-converse-stream' ? '.signal' : '?.signal') + '?.aborted ? "aborted" : "error";';
    source = once(source, marker, `${marker}\n\t\t\t// Terminal only: preserve machine evidence before formatting for display.\n\t\t\treportProviderFailure(${expression}, model.provider, model.api, options?.signal?.aborted);`);
    // Permanent stop reasons must survive the display-only Error conversion.
    const needle = ['google-generative-ai', 'google-vertex'].includes(api) ? 'throw new Error(errorMessage);' : 'throw new Error(output.errorMessage || "An unknown error occurred");';
    if (source.includes(needle)) source = once(source, needle, needle.replace('throw new Error(', 'throw Object.assign(new Error(').replace(/\);$/, '), { code: output.rawStopReason });'));
    if (api === 'openai-completions') source = once(source, 'throw new Error(output.errorMessage || "Provider returned an error stop reason");', 'throw Object.assign(new Error(output.errorMessage || "Provider returned an error stop reason"), { code: output.rawStopReason });');
  }
  return `import { ${imports} } from "../utils/provider-failure.ts";\n` + source;
}
export function patchShared(original) {
  let source = once(original, 'throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");', 'throw Object.assign(new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error"), { payload: event });');
  source = once(source, 'throw new Error(msg);', 'throw Object.assign(new Error(msg), { payload: event });');
  return source;
}
/** Pure clean-install seam: call after reconstructing Task38 in a fresh source tree,
 * before compilation. Inputs are {path,content} records relative to packages/ai.
 * No .dumps, installed SDK, filesystem output, compiler or network is required.
 * Clean-install already copies today's helper, whereas historical Task38 used the
 * reviewed old helper. Accept only those two exact helper states, never arbitrary drift.
 */
export async function generalizeTask38Sources(inputs) {
  const baseline = JSON.parse(await readFile(join(here, 'generalized-failure-baseline.json'), 'utf8'));
  const helper = await readFile(join(here, 'provider-failure.ts'), 'utf8');
  assert(Array.isArray(inputs), 'Reconstructed source records must be an array');
  const byPath = new Map();
  for (const file of inputs) {
    assert(file && typeof file.path === 'string' && typeof file.content === 'string', 'Invalid source record');
    assert(!byPath.has(file.path), `Duplicate reconstructed source: ${file.path}`);
    byPath.set(file.path, file.content);
  }
  assert.deepEqual([...byPath.keys()].sort(), Object.keys(baseline).map(path => 'src/' + path).sort(), 'Reconstructed source inventory differs from reviewed generalized scope');
  const files = [];
  for (const [relative, hash] of Object.entries(baseline)) {
    const path = 'src/' + relative, original = byPath.get(path), beforeSha256 = sha(original);
    if (relative === 'utils/provider-failure.ts') assert(beforeSha256 === hash || beforeSha256 === sha(helper), 'Reconstructed helper is neither reviewed Task38 nor maintained current helper');
    else assert.equal(beforeSha256, hash, `Reconstructed Task38 baseline changed: ${path}`);
    const api = relative.startsWith('api/') ? relative.slice(4, -3) : undefined;
    const content = relative === 'utils/provider-failure.ts' ? helper : api === 'openai-responses-shared' ? patchShared(original) : apis.includes(api) ? patchApi(api, original) : original;
    const afterSha256 = sha(content);
    files.push({ path, content, beforeSha256, afterSha256, changed: beforeSha256 !== afterSha256 });
  }
  const sourceFiles = files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 }));
  const digest = entries => sha(JSON.stringify(entries.slice().sort((a, b) => a.path.localeCompare(b.path))));
  return { files, sourceFiles, sourceDigest: digest(sourceFiles),
    // Compare reconstructed *outputs* against the historical candidate's provenance
    // without falsely claiming its helper-before bytes were the clean-install input.
    reviewedSourceDigest: digest(sourceFiles.map(file => ({ ...file, beforeSha256: baseline[file.path.slice(4)] }))) };
}
/** Fresh canonical-source copy, cached compiler, thin compiled overlay. Never installs or promotes. */
export async function prepareGeneralizedFailureCandidate({ sourceRoot, dependencyRoot, installedRoot, output }) {
  for (const [key, path] of Object.entries({ sourceRoot, dependencyRoot, installedRoot, output })) assert.equal(path, resolve(path), `${key} must be absolute`);
  const source = await realpath(sourceRoot), dependencies = await realpath(dependencyRoot), installed = await realpath(installedRoot);
  assert(!output.startsWith(installed + '/') && !output.startsWith(source + '/') && output !== installed && output !== source, 'Candidate must be isolated');
  const baseline = JSON.parse(await readFile(join(here, 'generalized-failure-baseline.json'), 'utf8'));
  const files = [];
  for (const [path, hash] of Object.entries(baseline)) {
    const original = await readFile(join(source, 'packages/ai/src', path), 'utf8');
    assert.equal(sha(original), hash, `Canonical reviewed source baseline changed: ${path}`);
    const api = path.startsWith('api/') ? path.slice(4, -3) : undefined;
    const content = path === 'utils/provider-failure.ts' ? await readFile(join(here, 'provider-failure.ts'), 'utf8') : api === 'openai-responses-shared' ? patchShared(original) : apis.includes(api) ? patchApi(api, original) : original;
    files.push({ path: 'src/' + path, original, content });
  }
  const sourceFiles = files.map(f => ({ path: f.path, beforeSha256: sha(f.original), afterSha256: sha(f.content) }));
  const sourceDigest = sha(JSON.stringify(sourceFiles.slice().sort((a, b) => a.path.localeCompare(b.path))));
  await mkdir(output, { mode: 0o700 });
  const build = join(output, 'source'), ai = join(build, 'packages/ai');
  await mkdir(ai, { recursive: true });
  await cp(join(source, 'packages/ai/src'), join(ai, 'src'), { recursive: true });
  for (const name of ['package.json', 'tsconfig.build.json']) await cp(join(source, 'packages/ai', name), join(ai, name));
  await cp(join(source, 'tsconfig.base.json'), join(build, 'tsconfig.base.json'));
  await symlink(dependencies, join(build, 'node_modules'), 'dir');
  for (const file of files) await writeFile(join(ai, file.path), file.content);
  execFileSync(process.execPath, [join(dependencies, '@typescript/native-preview/bin/tsgo.js'), '-p', 'tsconfig.build.json'], { cwd: ai, stdio: 'inherit' });
  const candidate = join(output, 'package');
  await cp(installed, candidate, { recursive: true, dereference: false });
  await symlink(dirname(dirname(installed)), join(candidate, 'node_modules'), 'dir');
  const generated = [];
  for (const prefix of prefixes) for (const suffix of suffixes) {
    const path = prefix + suffix, bytes = await readFile(join(ai, path));
    let before;
    try { before = await readFile(join(installed, path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(join(candidate, path)), { recursive: true });
    await writeFile(join(candidate, path), bytes);
    generated.push({ path, beforeSha256: before === undefined ? null : sha(before), afterSha256: sha(bytes), changed: before === undefined || !before.equals(bytes) });
  }
  const owned = new Set(generated.map(f => f.path)), protectedFiles = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/');
      else if (entry.isFile() && !owned.has(path)) {
        const before = await readFile(join(installed, path)), after = await readFile(join(candidate, path));
        assert(before.equals(after), `Protected output changed: ${path}`);
        protectedFiles.push({ path, sha256: sha(before) });
      }
    }
  }
  await walk(installed);
  const manifest = { schema: 1, kind: 'generalized-failure-categories-candidate', promoted: false, sourceRoot: source, dependencyRoot: dependencies, installedRoot: installed, candidate, sourceDigest,
    proposedVersion: `0.87.1+alex.generalized-failures.${sourceDigest.slice(0,12)}`, apis,
    sourceFiles, generated, protectedFiles };
  await writeFile(join(output, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 6, 'Usage: node generalized-failure-categories.mjs sourceRoot dependencyRoot installedSdk output');
  const [sourceRoot, dependencyRoot, installedRoot, output] = process.argv.slice(2).map(p => resolve(p));
  const result = await prepareGeneralizedFailureCandidate({ sourceRoot, dependencyRoot, installedRoot, output });
  console.log(JSON.stringify({ candidate: result.candidate, sourceDigest: result.sourceDigest, generated: result.generated.length, protected: result.protectedFiles.length }, null, 2));
}
