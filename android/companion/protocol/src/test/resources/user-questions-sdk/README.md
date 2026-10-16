# Public SDK question-wire goldens

These JSON files were emitted by an isolated real SDK Gateway / Connection / AgentLoop / UserQuestionService fixture using the installed `0.2.0-rc.2` packages. All questions, sessions, credentials, model output and answers are synthetic; the only model adapter is in-memory, with no provider network calls.

The private generator and evidence are under `.dumps/tasks/task122-question-sdk-stage/`. `timed.test.mjs` captures the actual forwarded request and public `session/projections` userQuestions values. Goldens are portable resources; JVM tests do not require that private directory or an SDK installation.

- `timed-request.json`: actual `user-questions/request` request after Agent ownership/signal are projected out.
- `open.json`: the live timed tool call, before timeout; projection alone grants no waterfall response right.
- `continued.json`: actual Host-deadline expiry/typed timeout has produced the pending tool result.
- `settled.json`: the continued reply has actually been admitted as a typed `user-question-reply` user message.

The SDK's `settled[].answers` is an **array**, not a nested answer-batch object. Kotlin already decoded this correctly; its batch wrapper is an internal DTO convenience. These resources guard against future shape confusion, not a claimed prior Android parser bug.

SDK `AskUserQuestionAnswerItem.selected` is required, including `[]` for a custom-only answer; `custom` is optional. SDK contracts do not promise this application's bounded strings/arrays, nonblank text, known option labels or single-choice canonicality. Android budgets/validation intentionally fail closed. A real service counterexample shows the continued endpoint accepts an undeclared label and multiple selected values on a single-choice question, so clients must not delegate canonical answer validation to it.
