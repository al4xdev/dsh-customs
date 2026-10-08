# Plan 6 — Model route discovery (investigation)

## Problem

The agent needs exact provider/model identifiers for delegation, but the current exposed subagent tool schema has no selection fields or model-discovery tool. A workflow attempt using the unverified model id `gpt-luna` returned four null results; this does not establish the exact cause or correct route.

## Existing implementation found

The installed `@deepseek-ai/dsh-tool-subagent/lib/index.js` already implements `list_subagent_models`. It lists allowed registered providers, advertised models and reasoning efforts. Registration depends on a model-selection policy; `modelSelectionSettings` defaults to false. When selection is enabled, delegation tools gain provider/model/reasoning_effort fields.

Prefer exposing/configuring this existing mechanism over creating a redundant discovery tool.

## Investigation and future steps

1. Identify the actual runtime serving this session, not merely the installed CLI or another running DSH instance. Multiple installations/entrypoints exist on this machine.
2. Determine the current parent route and registered official-provider catalog through the live runtime, without revealing credentials.
3. Locate the model-selection settings and allowed-route policy, and determine why discovery/selection are absent from the current tool schema.
4. Enable the existing native discovery mechanism where appropriate; inspect whether a fresh session is required because policy is persisted per session.
5. Select Luna only using exact returned provider/model ids. Do not infer ids from display names or silently substitute another model.
6. If native discovery cannot supply the required information, propose a small English-language tool returning current parent route, delegation defaults, selectable routes and actionable diagnostics. Distinguish registered, advertised and allowed models; do not dump all catalogs by default.
7. Improve failed delegation diagnostics if practical: a null workflow result must not be mistaken for completed implementation.

## Status and scope

Investigation proposal recorded during implementation of Plans 1–4. No claim that Luna is unavailable, and no authorization to change the active session's model or credentials. Parent retains ownership of implementation review and tests.
