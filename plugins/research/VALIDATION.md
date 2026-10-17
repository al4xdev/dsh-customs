# Research — Validation

## Fix: HN with Truncated JSON (Plan 123)

- Reproduced root cause: Algolia's `/api/v1/items/35154527` returns entire tree; native HTTP transport truncates at 100000 characters before local comment selection. The parser correctly rejected incomplete JSON, leaving only title/snippet.
- Fix: Algolia queried with minimal fields strictly for discovery; post and comments read individually via official Firebase API. Attempts bounded by maxComments, batches of 2, shared worker limit; without increasing maxBodyChars or attempting to parse truncated JSON.
- Live smoke on https://news.ycombinator.com/item?id=35154527: HN reported 2507 descendants. Post + 4 comments recovered (5 Firebase JSON payloads), largest single JSON 2444 characters. Legacy comparison: truncated:true, 100000 characters. External article returned 403, recorded as partial without discarding conversation.
- Evidence: `.dumps/hackernews-incremental-smoke.json` and research run `r-7-hn-incremental-large-topic-regression-7c0c57d525ec`; full selected comments reside in archive, not compact report. Four comments do not equal the entire thread.
- **105/105 tests passed**, including 11 new HN tests: `.dumps/hackernews-fix-tests.log`. Tests cover truncated node, large tree, budget 0, parent relations, cycles/IDs, deleted items, cancellation, blocked article, and concurrency.
- Opt-in smoke (public network, not run by offline suite): `node plugins/research/hackernews-live-check.mjs`. Keeps 100000 characters per response and max 4 comments; creates research/report under `.dumps`.
- Reopen DSH process to load the fresh connector. Update does not modify credentials, profiles, or global HTTP limits.

## Update: Official Reddit and Concurrency (Plan 118)

- Read-only OAuth connector: search/subreddit/thread, threaded comments, serial expansion, and cursors. Without valid token/UA returns AUTH_REQUIRED, without silent fallback.
- Token available in test process: **no** (`credentialStatus:missing`). No live authenticated validation was performed; refresh/login/purchase was not enabled. API tests use fixtures.
- Tool permits concurrent research runs, with shared per-backend scheduler in the same process: up to 2 workers (owner can lower to 1), morechildren 1, bounded queue, quota cooldown, and cancellation without premature slot release.
- Reading missing comments attempts expansion; replies with new `more` markers can progress; processed tree and text are bounded, preserving pending items and coverage.
- Compact cursor displays 10 IDs; inspect section:navigation retrieves all persisted IDs (up to 200), with pagination and context limits.
- **94/94 tests passed**, zero failures: `.dumps/research-reddit-tests-final.log`. Includes Reddit, scheduler, concurrent integration with real archive in Git fixtures, native registry, activation, and Companion regression.
- `research-activation --check`: `changes:[]` across all five profiles; no forced restarts. Reopen process to load new code/environment.
- Worker limit is not distributed across independent DSH processes; configure a central backend/process or tune workers down pending distributed coordination.
- Setup, examples, and limitations in [REDDIT.md](REDDIT.md).

## Historical First Release

The sections below record the prior version (when Reddit still used web index); they do not describe the current official connector.

## Code and Integration

- Public tool `research`: config/search/inspect/continue.
- Configuration within owner ceilings; filesystem permissions verified before opening storage.
- Parallel search and reads, per-source errors, snippets preserved when reading fails.
- Local evidence and selective retrieval; inspection capped at 16 KB, comments outside standard index.
- Continuation with cumulative budget and research lock; failed read can be retried in fresh round.
- HN with bounded comment tree and node count; grep.app with filters; Context7 with explicit identity/provenance.

## Automated Tests

Command:

```sh
node --test plugins/research/*.test.mjs tools/research-activation.test.mjs tools/session-companion/profile.test.mjs
```

57 tests passed in final verification with zero failures; evidence in `.dumps/research-tests-final.log`. Tests use fixtures/mocks, except registry integration which uses real DSH modules without network. Read-only policy test denies archive opening without permission escalation.

## Live Network Tests

Local archives (unversioned):

- `r-1-research-public-connector-smoke-a370bfbc5125`: HN preserved; grep.app returned service error; Context7 reported ID shift. Failures did not purge other sources.
- `r-2-research-public-connector-smoke-edfa3ae151e3`: HN, grep.app, and Context7 returned and were persisted/inspecified. Web backend deliberately unavailable in this isolated runner to test partial failure.
- `r-3-smoke-conversacional-gemini-4-2ef25445a9c6`: Real tool invocation by GPT-6 Luna low; three web/index searches timed out with reduced 15s limit; HN returned zero results. No evidence faked.
- `r-4-smoke-web-real-deadline-9c51e8824eae`: Real tool by Luna low; web backend located source but read was rejected on cross-origin redirect; HN returned speculative discussion. Two evidence entries persisted, including snippet of failed read. Does not prove product launch.

Luna low samples confirmed HN article text against public page and comments with threaded replies. Review identified Flutter homonym in grep and React documentation identity ambiguity: code filters and library metadata were added. HN comments are raw HTML, not guaranteed clean text; article and comments are retrieved separately.

## Activation

Selective migrator applied across web, headless, tui, dsh-tui, and companion. 14 configuration/derived files altered. `web_search` disabled where present; `web_fetch` and web backend preserved. Minimal/Companion did not gain `web_fetch` implicitly.

Reversible local receipt:

`.dumps/research-activation/3ab8d72f-20d4-407e-a761-01cb5bf3b262/receipt.json`

`node tools/research-activation.mjs --check` following application returned `changes: []` across all five profiles.

No running servers/profiles were forcibly restarted. Conversational test confirmed an already-open runtime retained prior 25s deadline, although new code allows 60s per web operation and 180s cumulative. **Reopen DSH/profile to fully load final version.** Configuration across all profiles does not imply independent network smoke testing in each; existing backends may differ.

## Deliberate Constraints

- Reddit/X: discovery via web index and public HTTP fetch. No authenticated API, exhaustive reply scraping, or purchased access to X.
- MCP/Google remain external services even with local primary model.
- Quota errors, blocking, ambiguous libraries, and rejected redirects are reported; never bypassed.
- No browser fallback, manual comment cursors, arbitrary link crawl, or internal LLM planner in this version.
- `.dumps` must be gitignored and located in authorized cwd; read-only sessions are rejected, including inspect in this version.
- No exhaustive comment harvesting, proof of representativeness, automatic archive pruning, or implicit cross-session sharing.
- Budget tracks logical search/read operations, not precise remote billing. No additional paid APIs enabled.
