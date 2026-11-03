---
name: manage-subagents
description: Add, remove, list, or reorder models on the dsh-tui subagent picker. Use when asked to change the sub-agent list, allowedModels, subagent routes, or which models list_subagent_models may offer.
---

# Manage the subagent model list

The picker is one profile patch row, not a code catalog. Array order is picker order. Keep `deepseek-flash` first unless the owner asks to reorder.

## Where it lives

Edit only `~/.dsh/profiles/dsh-tui/cordis.patch.yml`, row id `dsh-tui-subagent-model-selection-settings`:

```yaml
- id: dsh-tui-subagent-model-selection-settings
  config:
    enabled: true
    allowedModels:
      - provider: deepseek-official
        model: deepseek-flash
```

A config patch replaces the whole block. Read the row before editing and keep `enabled` plus every route you are not changing. Do not edit `cordis.yml`. Do not run `dsh --profile … --dump-config` or any live profile dump: that rewrites `cordis.yml` and reloads running profiles, including Companion.

`frontend/dsh-tui/cordis.patch.yml` only mounts the settings service. It is not the allowlist. Companion, headless, and web do not have this row; do not copy it there unless that profile already mounts the service and the owner asked.

## How a session compiles the list

1. `dsh-hmr` watches `cordis.patch.yml` and recomposes the profile. A valid edit reloads the setting. A broken edit can fail that reload, so re-read the row after writing.
2. Only a fresh root session samples the setting and records `subagent/model-selection-policy`. Child sessions inherit that record. Later edits do not change a session that already recorded a policy, including the one doing the edit.
3. `list_subagent_models` returns the intersection of that recorded policy, registered providers, and advertised model ids. An allowlisted id that is not registered or not advertised is hidden.
4. Tell the owner the new list appears only in a fresh root session.

The settings plugin rejects a repeated `provider` + `model`, an empty id, and `enabled: true` with an empty `allowedModels`.

## Resolve ids before writing

Never invent an id. Do not read `~/.dsh/dsh-auth/credentials.json`.

- `google-antigravity`: effort is the model id. Read `plugins/dsh-antigravity/src/models.ts` (`maintainedModels`) in this checkout. A family name such as "Gemini Flash 3.8" means every matching effort (`-high`, `-medium`, `-low`) unless the owner names one. Do not add `gemini-4-pro`; the catalog uses `gemini-4-argon-*`.
- `xai`, `openai-codex`, `anthropic`: read the installed pi-ai catalog at `~/.local/share/dsh-cli/node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json`. If the owner names a product without a version and `~/.dsh-tui/model.json` uses that provider, use that model id and say so.
- `deepseek-official`: the installed `dsh-llm-deepseek` catalog advertises `deepseek-flash` and `deepseek-v4-pro` unless that package's model list says otherwise. Unlisted ids can still be sent, but the picker only shows advertised ids.
- Do not add a provider login, compaction policy, or default session model as part of an allowlist edit.

## Add, remove, reorder, list

List: read the row and report `provider` / `model` in file order. Do not claim the current session's `list_subagent_models` matches the file.

Add: insert resolved routes beside the same provider, after that provider's existing routes. One short comment for a new family or provider, explaining a non-obvious id. Do not comment each effort variant.

Remove: delete only the named routes and their now-orphaned comment. If that would empty `allowedModels`, set `enabled: false` and say so instead.

Reorder: move entries only. Keep comments that explain a non-obvious id.

## After a profile edit

From the dsh-customs checkout run `npm run prompt:audit`. A denylist hit is a regression. Report a baseline diff and do not pass `--update` unless the owner explicitly says yes. The allowlist is not harness text, so a match is the expected result. Do not audit by booting the live profile.
