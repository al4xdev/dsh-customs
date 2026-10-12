# Plan 6 — Enable native subagent model selection

## Investigation results

The actual shell owner is PID 237795, running `/home/alex/.local/share/dsh-cli/node_modules/.bin/dsh --profile dsh-tui`, not the separately running npx web installation. The current session is `5156aaa5-d2de-4521-ae79-bc1303948a4e`, preset `standard`.

The current session's authoritative compressed event log reports the parent route `openai-codex/gpt-6.1-sol`, effort `medium`. It contains no `subagent/model-selection-policy` event; the latest request header has no `list_subagent_models` tool and the subagent schema exposes only description, prompt and run_in_background.

`~/.dsh/profiles/dsh-tui/standard-managed-plugins.yml` already sets `modelSelectionSettings: true`. The TUI bundle mounts the Host service under entry id `dsh-tui-subagent-model-selection-settings`, but does not override its defaults. The native service defaults to `enabled: false` and `allowedModels: []`. These are separate from the delegation plugin's capability flag.

The installed native delegation plugin captures this policy only for a fresh root session, records exact allowed routes durably, and lets children inherit it. An existing root session without a durable policy does not adopt a subsequently enabled Host setting. Restarting/resuming this same session is therefore insufficient.

The credential-gated OAuth adapter was queried in a separate diagnostic process using its installed catalog/profile builders and credential store, without printing credentials or making inference requests. OpenAI Codex has a stored credential and advertises: `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`. Anthropic, xai and meta have no stored credential in this store and advertise no models through this gate. This is the installed adapter catalog, not a claim that the current process's entire live registry was inspected. Catalog membership is advisory: the current parent uses `gpt-6.1-sol`, which is absent from this advertised list. No request to Luna has been tested; `gpt-luna` remains an unverified id.

## Minimal remaining implementation

1. Add one override to `~/.dsh/profiles/dsh-tui/cordis.patch.yml`, preserving other edits:

   ```yaml
   - id: dsh-tui-subagent-model-selection-settings
     config:
       enabled: true
       allowedModels:
         - provider: openai-codex
           model: gpt-6.1-sol
         - provider: openai-codex
           model: gpt-6-luna
   ```

   Keep the current parent/default route unchanged. This narrowly permits the confirmed current route and an exact advertised Luna route; do not silently substitute a model if either route is refused. Broader provider/model policies and reusable scout/critic profiles are separate work.

2. Validate the patched composition/schema without restarting any active process or exposing credentials. Use the existing goal to guide the approved implementation.
3. Start a fresh root session under the updated profile/Host. Confirm that its durable policy contains these routes, `list_subagent_models` appears, and the subagent schema has provider/model/reasoning_effort fields. Do not manually inject policy events into this existing session.
4. Query native discovery for `openai-codex` and the exact `gpt-6-luna` route, then perform one bounded subagent smoke request on that route using the exposed native selection fields. Collect its real result; a null/error is not success. Retain actionable diagnostics on failure.
5. Close this task only after native discovery and an explicitly selected Luna delegation are verified. If the fresh-session interaction needs the owner, report that boundary explicitly rather than claiming success.

## Non-goals and decision

Do not create a redundant discovery/selection plugin. Do not change credentials, the active parent model, or unrelated profiles. Do not use workflow as a workaround for unavailable selection fields. No production configuration was changed during the investigation.

## Acceptance criteria

- Native discovery is available in a fresh eligible session.
- Exact allowed routes are durable and distinguish advertised catalog entries from selectable routes.
- A native selected-model subagent completes a bounded smoke test and its result is collected.
- This existing plan is closed with evidence; no replacement backlog task or duplicate plugin is created.
