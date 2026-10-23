// Regression for the local compaction policy handoff. The bug: the launcher looked for
// the preset's include by a plugin id one level up, while research activation had made
// every preset's plugin list a chain of include derivatives. The policy then never left
// the root row, so each local model kept compaction-basic's 65k default headroom and a
// 128k model compacted at ~32k. This boots the launcher against a stubbed `dsh` (a copy
// under the temp dir, never the real profile) and inspects the overlay it emits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve(import.meta.dirname, '../..');
const RUNTIME = process.env.DSH_INSTALL_ROOT ?? '/home/alex/.local/share/dsh-cli';
const runtimeModules = join(RUNTIME, 'node_modules');
const skip = !existsSync(join(runtimeModules, 'js-yaml')) && 'installed DSH runtime not found';

const dump = `# Fixture: root compaction plus a preset whose plugin list is an include chain.
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: true
    modelPolicies:
      - provider: openai-codex
        model: gpt-x
        thresholdRatio: 0.7
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: research-plugins
        name: '@deepseek-ai/cordis-plugin-include'
        config:
          path: ./research.yml
`;

// research.yml -> managed.yml -> the compaction group holding compaction-basic, the
// same shape `tools/research-activation.mjs` leaves in the real profile.
const research = `- id: managed-plugins
  name: '@deepseek-ai/cordis-plugin-include'
  config:
    path: ./managed.yml
`;
const managed = `- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        modelPolicies:
          - provider: openai-codex
            model: gpt-x
`;
const cycle = `- id: research-plugins
  name: '@deepseek-ai/cordis-plugin-include'
  config:
    path: ./research.yml
`;
const stub = `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "--dump-config" ]; then cat "$LAUNCH_TEST_DUMP"; exit 0; fi
done
cat /dev/fd/3 > "$LAUNCH_TEST_PATCH"
exit 0
`;

// files: profile-relative fixture files, so a test can replace an include with a cycle.
async function runLauncher(files = { 'research.yml': research, 'managed.yml': managed }) {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-launcher-test-'));
    const install = join(scratch, 'install');
    await mkdir(join(install, 'node_modules', '.bin'), { recursive: true });
    await copyFile(resolve(REPO, 'tools/dsh-launcher/local-model-launch.mjs'), join(install, 'local-model-launch.mjs'));
    await symlink(join(runtimeModules, 'js-yaml'), join(install, 'node_modules/js-yaml'));
    await symlink(join(runtimeModules, '@deepseek-ai'), join(install, 'node_modules/@deepseek-ai'));
    const executable = join(install, 'node_modules/.bin/dsh');
    await writeFile(executable, stub);
    await chmod(executable, 0o755);
    const dshHome = join(scratch, 'home/.dsh');
    const profileDir = join(dshHome, 'profiles/dsh-tui');
    await mkdir(profileDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(profileDir, name), text);
    const dumpPath = join(scratch, 'dump.yml');
    await writeFile(dumpPath, dump);
    const patchPath = join(scratch, 'patch.json');
    const run = spawnSync(process.execPath, [join(install, 'local-model-launch.mjs')], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, DSH_HOME: dshHome, DSH_LOCAL_URL: 'http://127.0.0.1:9/v1',
            LAUNCH_TEST_DUMP: dumpPath, LAUNCH_TEST_PATCH: patchPath },
    });
    assert.equal(run.status, 0, run.stderr || 'launcher exited non-zero');
    return JSON.parse(await readFile(patchPath, 'utf8'));
}

test('carries the local compaction policy down the preset include chain', { skip }, async () => {
    const patch = await runLauncher();
    const root = patch.find(row => row.id === 'compaction-basic');
    assert.deepEqual(root.config.modelPolicies.find(policy => policy.model === 'Ternary-Bonsai-2-27B-PQ2_0'),
        // A fifth of the 131072 window: with the 16k output reservation the session may
        // fill 88.474 tokens before the summarizer is invoked.
        { provider: 'strata-local', model: 'Ternary-Bonsai-2-27B-PQ2_0', headroomTokens: 26214, maxTokens: 16384 });
    assert.ok(root.config.modelPolicies.some(policy => policy.model === 'gpt-x'), 'existing root policies survive');

    const preset = patch.find(row => row.id === 'preset-standard');
    const [outer] = preset.config.plugins;
    assert.equal(outer.id, 'research-plugins');
    const [carried] = outer.config.patches;
    assert.equal(carried.id, 'managed-plugins');
    const [inner] = carried.config.patches;
    assert.equal(inner.id, 'compaction-basic');
    const bonsai = inner.config.modelPolicies.find(policy => policy.model === 'Ternary-Bonsai-2-27B-PQ2_0');
    assert.equal(bonsai.headroomTokens, 26214, 'policy reaches the row the preset actually mounts');
    assert.ok(inner.config.modelPolicies.some(policy => policy.model === 'gpt-x'), 'the scoped row keeps its own policies');
    // The 64k Gemma entry gets a fifth of its own window (13107), so the policy must
    // reach that route too.
    assert.ok(inner.config.modelPolicies.some(policy => policy.provider === 'strata-local' && policy.model.endsWith('.gguf') && policy.headroomTokens === 13107),
        'every local model gets a policy, not only the bonsai');
});

test('an include cycle ends the walk instead of recursing forever', { skip }, async () => {
    const patch = await runLauncher({ 'research.yml': research, 'managed.yml': cycle });
    assert.deepEqual(patch.map(row => row.id), ['llm-pi-ai', 'compaction-basic'], 'root policy only, no preset patch');
});

test('the bonsai catalog offers only reasoning levels its template accepts', { skip }, async () => {
    const patch = await runLauncher();
    const provider = patch.find(row => row.id === 'llm-pi-ai').config.providers['strata-local'];
    const bonsai = provider.models.find(model => model.id === 'Ternary-Bonsai-2-27B-PQ2_0');
    // The template resolves xhigh (its own default), medium and low, renders the
    // value into the prompt head, and raises on anything else. A rejected level is
    // a Jinja 500; a changed one costs the whole prefix cache.
    assert.deepEqual(Object.keys(bonsai.reasoningEfforts).sort(), ['high', 'low', 'medium', 'xhigh']);
    for (const [id, wire] of Object.entries(bonsai.reasoningEfforts)) {
        assert.ok(['xhigh', 'medium', 'low'].includes(wire), `level ${id} sends "${wire}", which the template rejects`);
    }
    assert.equal(bonsai.reasoningEfforts.low, 'low', 'low stays selectable: this model over-thinks at xhigh');
});

test('local routes reserve 16k of output and leave a fifth of the window to the summarizer', { skip }, async () => {
    const patch = await runLauncher();
    const provider = patch.find(row => row.id === 'llm-pi-ai').config.providers['strata-local'];
    const policies = patch.find(row => row.id === 'compaction-basic').config.modelPolicies;
    // The offline Gemma entry is a 64k window: a 16k reservation plus a 13k fifth
    // leaves 55% to the session, the best a small window can do. The ratio is
    // asserted on the model this rig actually boots.
    const booted = provider.models.filter(model => !model.id.endsWith('.gguf'));
    assert.ok(booted.length > 0, 'the fixture catalog has a booted route');
    for (const model of booted) {
        assert.ok(model.maxTokens <= 16384, `${model.name} reserves ${model.maxTokens} output tokens`);
        const policy = policies.find(candidate => candidate.model === model.id);
        assert.ok(policy, `${model.name} has a compaction policy`);
        // The harness reads the trigger as context - maxTokens - headroomTokens, so the
        // headroom is what is left for the summarizer: a fifth of the window, which
        // keeps the session well past the old 62% trigger without starving compaction.
        assert.equal(policy.headroomTokens, Math.floor(model.contextWindow / 5),
            `${model.name} keeps ${policy.headroomTokens} tokens for the summarizer`);
        const trigger = model.contextWindow - model.maxTokens - policy.headroomTokens;
        assert.ok(trigger >= model.contextWindow * 0.65,
            `${model.name} triggers compaction at ${trigger} of ${model.contextWindow}`);
    }
});

test('an include wrapped in a group is still reached', { skip }, async () => {
    const grouped = `- id: wrapper
  name: cordis:group
  group: true
  config:
    - id: managed-plugins
      name: '@deepseek-ai/cordis-plugin-include'
      config:
        path: ./managed.yml
`;
    const patch = await runLauncher({ 'research.yml': grouped, 'managed.yml': managed });
    const [carried] = patch.find(row => row.id === 'preset-standard').config.plugins[0].config.patches;
    assert.equal(carried.id, 'managed-plugins');
    assert.equal(carried.config.patches[0].id, 'compaction-basic');
});
