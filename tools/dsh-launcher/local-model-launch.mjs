// Launcher do `dsh` (função fish do dotfiles): roda a TUI no perfil dsh-tui e injeta,
// por overlay em fd, o provider `strata-local` do servidor local (llama.cpp em
// DSH_LOCAL_URL, padrão 127.0.0.1:8080). Sem servidor, a TUI abre normalmente.
// Fica DENTRO do runtime (resolve ./node_modules a partir de si): host.mjs copia este
// arquivo para ~/.local/share/dsh-cli/; antes só existia no runtime do lab.
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';

const baseURL = (process.env.DSH_LOCAL_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const root = baseURL.replace(/\/v1$/, '');
// Os modelos conhecidos ficam selecionáveis mesmo com o servidor desligado; a
// descoberta atualiza esses cadastros ou acrescenta outro modelo na mesma rota
// `strata-local`. Nada aqui fixa o modelo padrão: quem
// decide é a config do profile, e trocar de modelo na TUI continua valendo.
// Para fixar um default só nesta sessão, exporte DSH_DEFAULT_MODEL (opcional:
// DSH_DEFAULT_PROVIDER, DSH_DEFAULT_EFFORT).
const pinnedModel = process.env.DSH_DEFAULT_MODEL;
const pinnedProvider = process.env.DSH_DEFAULT_PROVIDER ?? 'openai-codex';
const pinnedEffort = process.env.DSH_DEFAULT_EFFORT ?? 'low';
const executable = fileURLToPath(new URL('./node_modules/.bin/dsh', import.meta.url));
const args = ['--profile', 'dsh-tui', ...process.argv.slice(2)];
const profileDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'dsh-tui');

// Offline metadata matches run-bonsai2.fish's default deployment. Live metadata
// wins at launch; a server started later must use this context until TUI restart.
const bonsaiModel = {
    id: 'Ternary-Bonsai-2-27B-PQ2_0', name: 'Bonsai 2 27B (QW)',
    contextWindow: 131072, maxTokens: 16384, input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh' },
    compat: { supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: false },
};

// Confirmado no gen gmmed: /v1/models e /props, contexto por slot de 65536.
// O template não aceita reasoning_effort; não oferecer níveis artificiais.
const gemmaModel = {
    id: '/home/alex/.cache/huggingface/hub/models--EZForever--gemma-4-26B-A4B-it-qat-uncensored-heretic-UDmerge-GGUF/snapshots/9567a9ca99f1ee12c9d43082c7351f24b4feef63/gemma-4-26B-A4B-it-qat-uncensored-heretic-UDmerge-Q4_K_XXL.gguf',
    name: 'Gemma 4 26B Local (Q4_K_XXL)',
    contextWindow: 65536, maxTokens: 16384, input: ['text', 'image'],
    reasoningEfforts: false,
    compat: { supportsReasoningEffort: false, requiresReasoningContentOnAssistantMessages: false },
};

function findEntry(entries, id) {
    for (const entry of entries ?? []) {
        if (entry.id === id) return entry;
        if (entry.group && Array.isArray(entry.config)) {
            const nested = findEntry(entry.config, id);
            if (nested) return nested;
        }
    }
}

function readLaunchEntries() {
    // Loader overlays replace config wholesale, including modelPolicies. Read the
    // native offline composition so bundles, user policies and CLI patches survive.
    const dump = spawnSync(executable, [...args, '--dump-config'], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    });
    if (dump.error || dump.status !== 0) throw dump.error ?? new Error('Falha no dump da configuração da TUI.');
    return load(dump.stdout, { schema: entryListSchema });
}

const INCLUDE = '@deepseek-ai/cordis-plugin-include';

function isInclude(entry) {
    return entry?.name === INCLUDE && typeof entry?.config?.path === 'string';
}

// Include rows at any depth of one file: a group may wrap an include, and the parent's
// patch list reaches a group's children by id too.
function includeRows(rows) {
    return (rows ?? []).flatMap(row => [
        ...(isInclude(row) ? [row] : []),
        ...(row?.group && Array.isArray(row?.config) ? includeRows(row.config) : []),
    ]);
}

// One row patch for a compaction-basic entry. Default headroomTokens is 65536, so a
// routed request that reserves 32768 output tokens triggers at
// 131072 - 32768 - 65536 = 32768 tokens: ~32k on a 128k model. The headroom is
// computed below as half of the room left after the output reservation, which puts
// the trigger at 70% of the window: 98.304 on the 27B, 45.056 on a 64k model.
function compactionPolicy(entry) {
    if (!entry) throw new Error('compaction-basic não encontrado; políticas existentes não serão substituídas.');
    const config = entry.config ?? {};
    const policies = config.modelPolicies ?? [];
    if (!Array.isArray(policies)) throw new Error('modelPolicies não é uma lista; mantendo a configuração original.');
    let updated = [...policies];
    for (const model of localModels) {
        const matches = policy => policy.provider === 'strata-local' && policy.model === model.id;
        const existing = updated.find(matches) ?? {};
        updated = [
            ...updated.filter(policy => !matches(policy)),
            { ...existing, provider: 'strata-local', model: model.id,
                // The summarizer's own output budget; kept well under the headroom it
                // has to work in, and never the old fixed 16k ceiling on the headroom.
                maxTokens: Math.max(1, Math.min(16384, model.maxTokens)),
                headroomTokens: model.headroomTokens },
        ];
    }
    return { id: 'compaction-basic', config: { ...config, modelPolicies: updated } };
}

// Presets mount their own isolated compaction service, so a root patch never reaches
// a session. The row also sits behind more than one include now (research activation
// wraps every preset's plugin list in an alex-research-*.yml derivative), hence the
// walk instead of one known include id: carry the policy down to whichever include
// file owns compaction-basic.
function patchInclude(row, base, seen) {
    if (!isInclude(row)) return;
    const file = resolve(base, row.config.path);
    if (seen.has(file)) return; // include cycle on this chain only
    seen.add(file);
    try {
        let children;
        try {
            children = load(readFileSync(file, 'utf8'), { schema: entryListSchema });
        } catch {
            return; // unreadable include: the loader reports it and nothing here is ours
        }
        const scoped = applyEntryPatches(children, row.config.patches, () => {});
        const own = findEntry(scoped, 'compaction-basic');
        if (own) {
            return { ...row, config: { ...row.config, patches: [...(row.config.patches ?? []), compactionPolicy(own)] } };
        }
        const patches = [...(row.config.patches ?? [])];
        let carried = false;
        for (const child of includeRows(scoped)) {
            const nested = patchInclude(child, dirname(file), seen);
            if (!nested) continue;
            patches.push({ id: nested.id, config: nested.config });
            carried = true;
        }
        return carried ? { ...row, config: { ...row.config, patches } } : undefined;
    } finally {
        seen.delete(file);
    }
}

// Inline rows and includes, at any depth of a preset's plugin list.
function patchRows(rows, base, seen) {
    let changed = false;
    const updated = rows.map(row => {
        if (row?.id === 'compaction-basic') {
            changed = true;
            return { ...row, config: compactionPolicy(row).config };
        }
        const included = patchInclude(row, base, seen);
        if (included) {
            changed = true;
            return included;
        }
        if (row?.group && Array.isArray(row?.config)) {
            const inner = patchRows(row.config, base, seen);
            if (inner.changed) {
                changed = true;
                return { ...row, config: inner.rows };
            }
        }
        return row;
    });
    return { rows: updated, changed };
}

function localCompactionPatches(entries) {
    const patches = [];
    const root = findEntry(entries, 'compaction-basic');
    if (root) patches.push(compactionPolicy(root));
    for (const preset of entries) {
        if (!/^preset-/.test(preset?.id ?? '') || !Array.isArray(preset?.config?.plugins)) continue;
        const patched = patchRows(preset.config.plugins, profileDir, new Set());
        if (patched.changed) patches.push({ id: preset.id, config: { ...preset.config, plugins: patched.rows } });
    }
    if (!patches.length) throw new Error('compaction-basic não encontrado; políticas existentes não serão substituídas.');
    return patches;
}

async function read(url, required = true) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        if (required) throw new Error(`${url}: ${error.message}`);
        return {};
    }
}
const catalog = new Map([bonsaiModel, gemmaModel].map(model => [model.id, model]));
try {
    const [listing, props] = await Promise.all([read(`${baseURL}/models`), read(`${root}/props`, false)]);
    const models = listing.data ?? [];
    const chosen = process.env.DSH_LOCAL_MODEL ? models.find(model => model.id === process.env.DSH_LOCAL_MODEL) : models[0];
    if (!chosen?.id) throw new Error('Nenhum modelo disponível no servidor local.');
    if (models.length > 1 && !process.env.DSH_LOCAL_MODEL) throw new Error('Servidor com vários modelos: defina DSH_LOCAL_MODEL para selecionar um.');
    const caps = props.chat_template_caps ?? {};
    const context = props.default_generation_settings?.n_ctx ?? chosen.meta?.n_ctx ?? chosen.context_window;
    if (!Number.isInteger(context) || context < 2) throw new Error('Servidor não informou o contexto; não vou presumir um limite.');
    const known = catalog.get(chosen.id);
    const vision = typeof props.modalities?.vision === 'boolean'
        ? props.modalities.vision : known?.input.includes('image') === true;
    const effort = typeof caps.supports_reasoning_effort === 'boolean'
        ? caps.supports_reasoning_effort : known?.compat.supportsReasoningEffort === true;
    const bonsai = /ternary-bonsai-2-27b/i.test(chosen.id);
    const reasoningEfforts = bonsai
        // This template accepts exactly xhigh (its own default), medium and low,
        // and renders the chosen level into the prompt head. A level it rejects
        // fails the request with a Jinja 500, and a level that changes mid-session
        // costs the whole prefix cache. There is no 'off': thinking is switched
        // through enable_thinking, which this adapter cannot send.
        ? { low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh' }
        : { off: 'none', low: 'low', medium: 'medium', high: 'high' };
    const model = {
        id: chosen.id,
        name: known?.name ?? chosen.id.split('/').pop(),
        contextWindow: context,
        // 16k, not 32k: the output reservation is one of the two terms that decide the
        // compaction trigger (context - reservation - headroom). Halving it moves the
        // 27B from 82k to 98k, so a long session re-reads its own history far less
        // often; the longest generation observed on this model was 6.5k tokens. It
        // stays above the 8k headroom floor, so `budget >= 8192` keeps every route.
        maxTokens: Math.min(16384, context - 1),
        input: ['text', ...(vision ? ['image'] : [])],
        reasoningEfforts: effort ? reasoningEfforts : false,
        compat: { supportsReasoningEffort: effort,
            requiresReasoningContentOnAssistantMessages: !bonsai && caps.supports_preserve_reasoning === true },
    };
    catalog.set(model.id, model);
} catch {
    // Failed discovery never erases known models or prevents TUI startup.
}
let entries;
try {
    entries = readLaunchEntries();
} catch (error) {
    process.stderr.write(`dsht: configuração efetiva não lida: ${error.message}\n`);
}
const models = [...catalog.values()];
// Every local route gets a policy, not only the bonsai: the default 65k headroom
// makes any 128k local model compact at ~32k. A model whose window barely exceeds its
// output reservation keeps the default (and dsh warns) instead of compacting every
// turn; that pair needs a smaller catalog maxTokens, not a tiny headroom.
const localModels = models
    // The trigger is context - maxTokens - headroomTokens, so both terms are
    // subtracted once. A fixed 8k headroom is what the summarizer needs to work in
    // and puts the 27B trigger at 106.688 of 131.072 (was 81.920 with the shipped
    // 65k default, then 88.474 at a fifth of the window). Each compaction costs
    // roughly twice the context in prefill — one pass to summarize, one to warm the
    // compacted history — so a later trigger buys fewer of them. Half the remaining
    // room caps it for small windows, where 8k would starve the session.
    .map(model => ({
        ...model,
        headroomTokens: Math.min(8000, Math.max(1, Math.floor((model.contextWindow - model.maxTokens) / 2))),
    }));
const providerConfig = findEntry(entries, 'llm-pi-ai')?.config ?? {};
const patch = [{ id: 'llm-pi-ai', config: {
    ...providerConfig,
    providers: { ...providerConfig.providers, 'strata-local': {
        displayName: 'Local server', api: 'openai-completions', baseURL,
        apiKeyEnv: 'STRATA_API_KEY',
        compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
        models,
    } },
} }];
if (entries) {
    try {
        patch.push(...localCompactionPatches(entries));
    } catch (error) {
        // A policy failure must not hide an otherwise usable local catalog.
        process.stderr.write(`dsht: compactação local não ajustada: ${error.message}\n`);
    }
}
if (pinnedModel) {
    patch.push(
        { id: 'agent-default-model', config: { provider: pinnedProvider, model: pinnedModel, reasoningEffort: pinnedEffort } },
        { id: 'dsh-tui', config: { provider: pinnedProvider, model: pinnedModel, effort: pinnedEffort } },
    );
}
// Process substitution fornece um pipe herdado, mantendo stdin livre para a TUI.
// O overlay vive apenas no descritor 3; nenhum arquivo é criado em disco.
const child = patch.length
    ? spawn('bash', ['-c', 'patch=$1; shift; exec "$@" 3< <(printf "%s" "$patch")',
        'dsht', JSON.stringify(patch), executable, '--profile', 'dsh-tui',
        '--patch', '/dev/fd/3', ...process.argv.slice(2)], { stdio: 'inherit' })
    : spawn(executable, args, { stdio: 'inherit' });
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code;
});
