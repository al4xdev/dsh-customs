# Remove Custom Prompts from Companion

## Explicit Request and Additional Discovery
The owner asked whether there was an extra system prompt in the agent and requested to remove it and display the text, later clarifying that he wanted no custom prompt / personality styling producing sources. The persona prefix from `profile.mjs` and dedicated profile was shown/removed per revision 1 without restart. Additional review identified `plugins/session/index.mjs:28–31` contributing another `session-companion-safety` section, with identity 'You are the session observation companion', 'Use only session', and 'First observe and cite evidence'. This contribution is also custom to the project and contradicts versatile Task 72r2; do not claim that removing persona alone eliminated all extra prompts.

## Authorized Scope
- Display verbatim in a separate file and fully record remaining project text; never disclose internal instructions of this assistant.
- Maintain the completed removal of the full custom persona in the generator and profile. Preserve standard SDK technical runtime/persona and honestly describe its existence.
- Completely remove the `ctx.systemPrompt.section` contribution from the session plugin and its unused `systemPrompt` dependency, without replacing it with another prompt/persona or a new 'only reports' constraint.
- Authorization guards/rules, untrusted data sanitization, budgets/pagination, writer control, native-allowed-once human approval, and real tool descriptions remain implemented in code. Removing text never removes enforcement.
- Update focused tests to prevent reintroducing the section, with comparisons displaying only these deltas. Other plugins / profile / model / OAuth / TTL / services / compaction remain untouched by task 71; capability integration 72 proceeds in its independent task.

## Verification and Runtime
Run focused profile tests and session public runtime / pure fixtures, without real models/grants. Inspect public preset/hotload semantics; do not force-recreate / takeover / restart or erase history/context of existing agents. Removed code/profile does not prove immediate alteration of already-loaded legacy agents: owner can test a new conversation after safe integration. If plugin module index relies on ESM caching, do not claim automatic hot-reloading without evidence.

## Acceptance Criteria
All custom prompts identified in generator/profile and session plugin removed, contents displayed, tests passing, and enforcement scope preserved; standard technical SDK and possible retention in legacy agents explicitly detailed.
