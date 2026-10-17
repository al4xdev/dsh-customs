# Fix questionnaires after /bg

## Authorization
User reproduced the issue: `ask_user_question` worked before `/bg`; after backgrounding it returned "no user-questions answerer accepted the request". Authorized autonomous fix and final commit, without push.

## Scope
1. Trace waterfall/answerer eligibility and TUI agent ownership, background handoff, and questionnaire projection upon returning. Do not conclude root cause without code/test evidence.
2. Fix only necessary routing/lifecycle: questions from sessions still owned by this TUI must be accepted/queued; questions from other terminals / unowned agents must remain delegated. Do not capture all agents globally.
3. Preserve ordering/cancellation/queue cleanup and agentless OAuth/legacy behavior. A pending question must reappear when returning to the session when applicable, without silent rejection.
4. Add regression tests with mocks and headless runner covering before/after `/bg`, returning, and isolation/disposal. Do not read credentials/real sessions or invoke providers/models/login.
5. Compile, run focused tests and relevant guards, review diff, commit only related files in custom fork. Preserve other agents' changes, no reset/stash/force/push, and do not restart TUIs.

## Acceptance
Regression demonstrates question from owned backgrounded session does not fail with terminal error, remains pending, and can be answered upon returning; foreign agent remains delegated, cleanup/cancellation preserved. Compilation and relevant tests pass; local commit delivered with instructions to reopen TUI.
