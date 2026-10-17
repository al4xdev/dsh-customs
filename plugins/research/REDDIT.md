# Official Reddit: Reading, Navigation, and Concurrency

## Status

The `reddit` connector now exclusively uses the official Data API via OAuth. It performs no silent fallback to Google upon missing credentials, 403, 429, or timeout. The `web` source remains separately available to discover indexed pages.

Implementation and tests do not equal approved access by Reddit. During local validation, `credentialStatus` was `missing`: no actual authenticated tests were executed. API test suites use fixtures, not live posts obtained via OAuth.

## Credentials and Authorization

The owner must obtain permitted access from Reddit and an OAuth access token with appropriate read scope (`read`). Consult current processes directly on Reddit; do not assume creating an application waives approval or permits arbitrary agent usage.

Provide to the DSH process via protected environment variables:

- `REDDIT_ACCESS_TOKEN`: Valid OAuth token, never an account password.
- `REDDIT_USER_AGENT`: Descriptive application identifier without newlines; for example platform ID, name, version, and contact info following Reddit guidelines.

Never place tokens in tool arguments, `.agents`, Git, `.dumps`, screenshots, or chat messages. Configure in the environment of the service/launcher that actually executes the profile, not merely in a different terminal shell. Restart/reopen the process after modifying environment variables when required.

This version is **access-token-only**: the owner replaces expired tokens. There is no interactive login, password grant, automatic refresh, usage of personal cookies, or purchasing of access. Do not use tokens issued for unauthorized purposes.

API targeted: GET on `https://oauth.reddit.com`, redirects rejected, responses capped at 2MB. No posting, voting, messaging, or account modifications. Missing authentication returns `AUTH_REQUIRED`; blocking and quotas preserve results from other sources.

Official documentation:

- https://www.reddit.com/dev/api/
- https://www.reddit.com/dev/api/#GET_api_morechildren
- https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- https://redditinc.com/policies/data-api-terms

The Wiki was blocked in this environment and terms were not fully read during prior investigation. Before operating, verify applicable approvals, terms, agent usage, and retention policies; do not treat this README as Reddit authorization.

## Navigation with the Same Tool

Creating a Reddit-only configuration enables navigation without triggering meaningless searches across other sources:

```json
{"action":"config","config":{"sources":["reddit"],"maxComments":40,"readsPerSource":2}}
```

The identifiers below are placeholders, not real tokens or queries.

### Search inside a Subreddit

```json
{"action":"search","config_id":"<id>","query":"local models","reddit":{"mode":"search","subreddit":"LocalLLaMA","sort":"new","time":"week"}}
```

### List Recent Topics

```json
{"action":"search","config_id":"<id>","reddit":{"mode":"subreddit","subreddit":"LocalLLaMA","sort":"new"}}
```

`query` may be omitted in `subreddit` and `thread` modes. These modes mandate an exclusively Reddit configuration. Standard search accepts Reddit alongside other sources.

### Open Topic and Comments

```json
{"action":"continue","run_id":"<id>","reddit":{"mode":"thread","postId":"<post-id>","sort":"top"}}
```

`postId` accepts base36 ID or `t3_...` fullname. `commentId` accepts ID or `t1_...` to focus a reply. The tool verifies thread origin before merging comments returned by expansion.

### Inspect and Continue

```json
{"action":"inspect","run_id":"<id>","ref":"<ref>","section":"comments","limit":6000}
```

```json
{"action":"inspect","run_id":"<id>","ref":"<ref>","section":"navigation","limit":6000}
```

The index displays up to 10 pending IDs as a preview. **These are not the only persisted IDs**: `section:navigation` allows retrieving all stored IDs, paginating via `offset/limit` if needed. The archive stores up to 200 continuation IDs per evidence entry, indicating when more remain.

To list the next page, use `reddit.after` returned by the listing and repeat mode/subreddit/sort. To expand replies, use `reddit.mode:thread`, `postId`, and `children:[pending IDs]`. Never invent cursors or treat array indices as API cursors.

Initial read retrieves comments and attempts up to two `morechildren` expansions, up to 100 IDs per call, bounded by selected comment budget. Expansion failure preserves post, valid comments, errors, and pending items. Snapshots may contain removed/inaccessible/missing comments; there is no guarantee of complete threads or statistical representativeness.

## Concurrency

- `research` accepts concurrent calls; distinct runs are not serialized globally.
- The same research run remains protected by a lock and cumulative budget.
- Default: **2 workers per backend**, shared across plugin sessions/instances **within the same DSH process**.
- Owner can set `providerWorkers: 1` in plugin options. Values other than 1 or 2 are rejected. The agent cannot modify this ceiling via tool calls.
- Web backend is a shared queue for `web` and X fallback; it does not become independent queues per label.
- Reddit API: up to 2 operations; `morechildren`: **1**, including after cancellation while the actual underlying request has not completed.
- HTTP: limit per origin; MCPs: limit per provider.
- Bounded queues (64 waiting per key); cancellation clears waiters. In-flight operations only free slots when they actually terminate.
- 429 and rate-limit headers trigger shared cooldown; new attempts fail with wait hints rather than bombarding the service. Other sources continue.
- Deadlines include queue wait time. Concurrency control does not prevent 429 errors: external quotas may also restrict volume per minute/day.
- The queue is **per-process**, not a distributed sempahore across independent processes/profiles. Two distinct DSH instances may aggregate their limits. Global inter-process coordination is a separate evolution; in the interim, prefer a single backend process or tune workers to 1.
- Key registry caps at 512 entries per process, retaining the lowest configured limit until restart. Exhaustion returns an error, preventing unbounded memory growth.

## Data and Testing

Session permission policy applies to storage; `.dumps` must be gitignored. External content remains untrusted. Do not retain data archives beyond permitted terms/authorization; this version features no automatic pruning.

```sh
node --test plugins/research/*.test.mjs
```

Reddit/scheduler/concurrency suites cover OAuth headers, fixed hosts, IDs, pagination, chaining, partial expansion, missing credentials, non-leaking tokens, 429/cooldown, cancellation, worker limits, concurrent research runs, and selective archive inspection. They do not replace live authenticated testing after authorized configuration.
