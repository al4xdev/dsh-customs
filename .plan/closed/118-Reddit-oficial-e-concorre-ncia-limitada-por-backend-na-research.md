# Official Reddit and backend-limited concurrency in research

## Authorization and objective

The owner requested implementing access via Reddit's official API and enabling multiple simultaneous searches, while maintaining one or at most two workers per provider/source to reduce 429 errors. Autonomous implementation authorized, without purchasing services, creating accounts, or obtaining credentials without specific authorization.

Goal: goal-7ea639f5-d373-4587-8165-8d5af2db9bcf.

## Scope

1. Read-only Reddit connector: search, listing by subreddit, opening thread and comments, limited expansion via morechildren. OAuth token provided by the owner; secure refresh token support if feasible. Do not use personal cookies, Reddit password, or blocking bypass.
2. Credentials via process environment, never tool arguments, snapshots, or logs. Fixed official HTTPS destinations, redirects rejected, bounded responses. Missing credentials returns explicit error; do not pretend API is functioning or perform silent fallback after 401/403/429.
3. Persist IDs, parent/link IDs, comments, pagination/pending items, and coverage in .dumps with selective retrieval. Preserve already read post/comments when expansion fails. Incremental navigation via typed tool parameters.
4. Shared scheduler across searches/instances in the same process: by default 2 workers per backend, option 1; morechildren 1. Web, Reddit fallback, and X share web backend key and do not receive six disguised workers. HTTP reads limited by origin and MCPs by provider. Limitation across independent processes must be made explicit, or implemented if necessary for integration without unduly expanding scope.
5. Enable tool concurrencySafe only after queues, run locks, and tests. Distinct searches can proceed; same run remains protected by lock. Bounded queues, cancellation and deadlines, 429 cooldown / Retry-After, and rate-limit headers when available. Do not block other sources during cooldown or discard existing results.
6. Tests with fixtures for OAuth / listings / comments / morechildren, 429, 403, missing token, redirection, secrets, cancellation, shared concurrency, multiple runs, and persistence.
7. Document required configuration/authorization and limitations. Do not claim authenticated validation if there are no approved credentials; any real testing only with explicitly available and authorized access.

## Acceptance criteria

- Official connector implemented, without account mutations, with clear error if unconfigured.
- Partial data preserved when page/expansion fails; threaded comments and real counts.
- Independent source continues when another reaches quota.
- Maximum 2 jobs on shared backend, 1 morechildren; concurrent tests prove this and do not release slot of still active operation due to premature timeout.
- Schema and documentation allow exploring subreddit and thread, not merely searching snippets on the web.
- Tool admits simultaneous calls for different runs and maintains budget/lock per run.
- No unnecessary alterations to backends/credentials/profiles; already activated version remains on the same path and requires reload for new code.

## Execution plan

Inspect current contracts → implement scheduler and Reddit in isolated modules → integrate engine/tool/store → test and review security → document evidence and access pending items. Use automated tests without LLM; delegate conversational smoke to Luna low if needed, returning short samples.
