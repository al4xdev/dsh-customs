# Research — revised base plan for the orchestrator tool

## 1. Status and scope

**Awaiting human review. Do not implement, install, connect accounts, or begin additional surveys because of autoApprove.** The owner clarified that project approval is automatic and will still examine the plan. The next step depends on explicit human guidance.

Revision 3: incorporates grep.app and Context7 into technical architecture. Consolidates previous architecture, simulation of a question about Gemini 4, and selective persistence in `.dumps`. Nothing has been implemented.

Objective: a public `research` tool for prior configuration, parallel discovery, mandatory reading, persistent collection, and incremental investigation conducted by the turn's agent.

## 2. Confirmed preferences

- A public tool encapsulates specialized connectors.
- `config` precedes `search`; configured reads are executed by code, not merely recommended to the agent.
- Independent sources are queried in parallel.
- **Hacker News (`news.ycombinator.com`), Reddit, and X are central sources**, potentially taking priority over Google depending on the question.
- The desired forum is Hacker News; Lobsters/Slashdot are not initial requirements.
- Research persists in the project's `.dumps`, with tree pattern, counter, identifier, and readable name.
- The agent receives a compact index and retrieves content selectively, avoiding dumping documents into the context.
- Owner proposed **grep.app and Context7 instead of generic search on GitHub**. Refined proposal: grep.app to discover code, Context7 for documentation; direct GitHub remains only as reader/fallback for sources those services do not replace, especially issues, PRs, and discussions. This refinement awaits review.

## 3. Known state and preliminary verification

Local configuration previously inspected in `/home/alex/.dsh/profiles/dsh-tui/cordis.patch.yml`: search `google-antigravity`, auxiliary model `gemini-3.8-flash-low`, provider `web-search-deepseek` disabled, reader `http`. There is a separate browser. Using a local primary model does not make this search backend local.

Reuse current provider before considering a fork. Effective implementation, interface, license, and quotas still need to be verified.

### New candidates

- **grep.app:** there is an official Vercel publication titled “Grep a million GitHub repositories via MCP”. Direct query to the grep.app website returned HTTP 429/checkpoint; do not confuse this site block with an MCP availability test. Endpoint, schema, authentication, quotas, and coverage of the MCP have not yet been validated.
- **Context7:** official README confirms MCP, tools `resolve-library-id` and `query-docs`, documentation oriented toward libraries/versions, and remote endpoint `https://mcp.context7.com/mcp`. It is necessary to resolve library identity before querying, unless ID is already known. API key is recommended for higher limits. Do not assume coverage or available version without checking the result.
- Context7's README reports that backend, parser, and crawler are not part of the public MCP server repository. **A local MCP server is not equivalent to an entirely local service or one independent of an external backend.**

Sources consulted for this revision:
- https://vercel.com/blog/grep-a-million-github-repositories-via-mcp
- https://raw.githubusercontent.com/upstash/context7/master/README.md

No installation or real calls to the MCPs were performed.

## 4. Responsibilities

### Owner policy

Defines providers, credentials, access/browser permissions, retention, and time/cost ceilings. The agent cannot raise permissions or budget via `config`.

### Strategy chosen by the agent

Defines subject, intent, time window, sources, comments, and depth within the existing policy. Simple questions should not require technical decisions from the user for every search.

### Orchestrator

Searches, selects by explicit criteria, reads, paginates, expands links, persists, deduplicates, and accounts for budget. In the initial proposed version there is no mandatory hidden second LLM. The current Google provider may use its own auxiliary model, explicitly.

### Turn agent

Judges meaning, contradictions, independence of sources, and sufficiency of answer; decides new queries and selective retrieval. Internal LLM planner is an optional evolution, not a requirement.

## 5. Architecture

```text
Turn agent
├── research.config
│   ├── Owner policy + query strategy
│   ├── Capabilities and degradations per connector
│   └── config_id + immutable revision
├── research.search
│   └── Orchestrator with continuous queue
│       ├── Discovery in parallel, according to intent
│       │   ├── Google/Antigravity → web, news, and official sources
│       │   ├── Reddit → threads and reports
│       │   ├── X → accessible posts and conversations
│       │   ├── Hacker News → news and technical discussion
│       │   ├── grep.app/MCP → indexed code occurrences
│       │   └── Context7/MCP → library/version documentation
│       ├── Reads as soon as results become available
│       │   ├── Web → HTTP; optional authorized browser
│       │   ├── Reddit/X/HN → threads, comments, and pagination
│       │   ├── Code → file/repository context when needed
│       │   └── Direct GitHub → raw, issues, PRs, and discussions when pertinent
│       ├── Incremental persistence in .dumps/research/
│       └── Compact return: index, refs, coverage, and budget
├── research.inspect → retrieve parts of local collection
├── research.continue → deepen same research and budget
└── Response with citations and limitations
```

MCP is a transport/integration interface, not an additional source in itself. MCP connectors remain encapsulated; the agent does not need to receive dozens of public tools. Reuse of DSH MCP client and interception/persistence of response before entering context require technical validation.

Context7 has internal dependency `resolve-library-id → query-docs`; do not pretend these two operations are independent. The different connectors can run in parallel.

## 6. Proposed contract

Names below are proposals, not implemented schemas.

### `config`

Registers effective configuration within policy, returning `config_id`, revision, capabilities, degradations, and limits. Does not unexpectedly test paid APIs or store secrets. Missing/invalid configuration causes explicit error in `search`.

Distinguish discovery and reading capability: searching Reddit via Google does not mean being able to collect comments. Mandatory source requires verifiable attempt and accountability, not guaranteed access.

### `search`

Creates `run_id` and persistent directory; adapts query to each source, its filters, and syntax. Runs continuous pipeline without waiting for the slowest source to begin reading. Reserves budget across sources so a fast source does not consume everything.

Do not trigger grep.app/Context7 indiscriminately in every search. A question about Gemini news does not require code search; a question about SDK/API may require documentation and usage examples.

### Mandatory reading depends on result type

- Search result with snippet: open selected source.
- Discussion: collect post and comments according to policy.
- grep.app code excerpt: persist repo/path/lines/ref when available; expand context when insufficient. Excerpt does not represent full file analysis or coverage across all repositories.
- Context7: documentary content effectively returned may be persisted as read, without mandatory redundant scraping. Resolve source and version, record limits; open original documentation when needed for confirmation/context.

Mandatory reading means accessed evidence, not always a second HTTP request. Schema must indicate `snippet`, `document_excerpt`, `full_document`, `thread_partial`, or equivalent, without declaring false completeness.

### `inspect`

Local query by reference, source, round, text search, or excerpt with offset/limit. Returns provenance and truncation. Native reading/search tools can also access authorized files. Embeddings are not an initial requirement.

### `continue`

Receives `run_id`, queries, and/or references to deepen. Inherits configuration revision, evidence, cache, and remaining budget; does not reset limits. Type evidence references and pagination cursors separately.

### Progress / cancellation

Prefer existing DSH jobs after evaluating integration. Report compact progress, allow cancellation of pending tasks, and preserve valid evidence. Do not rely on frequent polling. Expanding budget requires proper policy/authorization; do not bypass limit by creating a new search automatically.

## 7. Persistence in `.dumps/research`

### Proposed identification

`r-<counter>-<slug>-<unique-suffix>`; fictional example: `r-000042-novidades-gemini-4-a81f2c`.

Monotonic counter per project, atomic allocation across processes/sessions, unique suffix, and sanitized/short slug without secrets. Immutable ID; title may change in manifest. Evidence items have stable references independent of index order.

```text
<project>/.dumps/research/
├── registry.json                   # counter and minimal catalog
└── r-000042-novidades-gemini-4-a81f2c/
    ├── manifest.json               # identity, session, state, and paths
    ├── config.json                 # effective snapshot, without credentials
    ├── index.md                    # compact and bounded map
    ├── coverage.json               # coverage and limitations per source
    ├── budget.json                 # accumulated consumption and reserves
    ├── events.jsonl                # events/checkpoints, not private reasoning
    ├── rounds/
    │   ├── 001/
    │   │   ├── queries.json
    │   │   └── results.jsonl
    │   └── 002/
    ├── evidence/
    │   ├── e-000001/
    │   │   ├── metadata.json       # URL, origin, dates, hash, refs, and coverage
    │   │   ├── content.md          # normalized content
    │   │   └── comments.jsonl      # optional; IDs and reply relationships
    │   └── e-000002/
    └── reports/
        └── answer.md               # optional derived synthesis, not primary source
```

The tree is a proposed standard; do not create it operationally in this revision. Optional, sanitized, and bounded raw payload. Technical metadata may include library/version, repository, file, lines, commit/ref, and original URL, when genuinely made available.

### Return to model

Only `run_id`, revision, state, index ref/path, coverage, budget, and short evidence list with title/URL/type/reading state. Explicitly limit items and return size; paginate index by source/round. No mandatory global summary generated by another LLM.

MCP content must also pass through this storage/limitation before entering context, rather than arriving in full to the agent only to be saved afterward.

### Local integrity and security

- Verify `.dumps/` ignored by Git and kept local; do not commit searches.
- Isolate project/session; sharing and resuming across sessions must be explicit.
- Confine paths to authorized root; prevent traversal and escapes via symlink.
- Atomic snapshots, checkpoints, and detection of incomplete files; write failure is not success.
- Sanitize tokens, cookies, headers, and URLs with secrets.
- Define retention and cleanup; never delete active search. `.dumps` is not backup.
- Removed file must produce missing evidence, not fictitious retrieval.
- Cache records collection date and validity. New events may require revalidation; do not mix old and recent content without identification.

## 8. Loops, limits, and states

Separate agent investigative rounds, connector pagination, and link expansion. Define each counter without mixing them into a single ambiguous `max_rounds`.

Budget per research: time, calls, attempts/retries, pages, comments, bytes, depth, rounds, and cost when measurable. Limited retry with backoff; no infinite waiting.

Independent axes:

- Execution: created, in progress, completed, cancelled, or failed.
- Coverage: met, partial, or unavailable per source/criterion.
- Answer sufficiency: agent assessment, not document count.

Zero results, missing credentials, timeout, and blocking are different conditions. Not finding an announcement does not prove non-existence of product.

## 9. Evidence and source selection

Discovery provider and content origin are distinct fields. Google is not an authority in itself; grep.app is not the code author; Context7 does not automatically replace original documentation.

- Announcement / availability: prioritize official evidence.
- Experience / failures / perception: prioritize Reddit, X, and HN when pertinent.
- Real API / code usage: grep.app.
- Library / version documentation: Context7.
- Bugs and project decisions: original issue/PR/discussion when needed.

Preserve publication, update, occurrence when identifiable, and collection; missing/uncertain dates are not invented. Differentiate report, rumor, and confirmation through agent evaluation linked to sources.

Deduplicate URLs/content while preserving provenance. Multiple sites repeating the same origin do not represent independent confirmations; semantic detection depends on agent, not just hashes.

Comments preserve IDs, parents/roots, dates, and public author when necessary. Declare selection by votes/recency/relevance and truncation; sample does not represent entire community. Indexed content and documented versions have no guaranteed coverage.

## 10. Preliminary connector matrix

| Connector | Function | Pending items |
|---|---|---|
| Google/Antigravity | Current web discovery | Interface, license, quotas, and structured return |
| Reddit | Threads and comments | API / authorized access, terms, limits, pagination, and fallback |
| X | Posts and conversations | Exact provider/API, costs, and coverage; app does not imply API |
| Hacker News | Items and discussions | Search/reading, limits, dates, and removed items |
| grep.app MCP | Search in indexed code | Endpoint/schema, authentication, quotas, terms, and returned context |
| Context7 MCP | Library identification and documentation | Quotas, key, available versions, provenance, and external dependency |
| Direct GitHub | Specific reading / fallback | API/raw, pagination, quotas, and access to issues/PRs/discussions |
| HTTP/browser | Generic reading | Security, extraction, blocking, and browser authorization |

Discourse/RSS/other forums are future extensions, not initial requirements.

## 11. Acceptance simulation

Hypothetical question: “Check news about Gemini 4”. Does not assume existence or real release.

1. Agent chooses intent / time window; `config` reports limits and availability.
2. `search` creates collection, queries appropriate sources in parallel, and begins reading progressively.
3. Communities have priority according to intent; grep.app/Context7 do not trigger without technical necessity.
4. Evidence is persisted; only compact index enters context.
5. `inspect` retrieves useful evidence; agent distinguishes official sources from reports/rumors.
6. Unverified claim triggers `continue`, using remaining budget, not a new disconnected search.
7. Answer cites sources and limitations.
8. Question “did folks on Reddit like it?” resumes existing comments and expands selectively, without asserting undue representativeness.
9. Question “how do I use this in the SDK?” may activate Context7/grep.app according to configuration/permissions; any change requires explicit configuration revision, never silent mutation of ongoing research. Define whether it will be linked search or derived revision before implementing.
10. After compaction/interruption, explicit reference and checkpoints allow recovery without re-injecting entire collection.

## 12. Future survey, not yet authorized to begin

- Inspect interfaces/licenses of current provider and decide reuse/fork with justification.
- Map plugins, MCP client, jobs, cancellation, persistence, and DSH limits.
- Confirm official documentation and source costs; test connectors only within authorized scope.
- Verify how to capture MCP response in orchestrator before exposing to context.
- Define configuration, evidence, reference, cursors, library/version identity, and state schemas.
- Validate concurrent counter, atomic storage, isolation, and selective retrieval.
- Define SSRF, redirects, URLs, browser, and permission boundaries.
- Submit phased implementation, tests, and estimated cost in new human review.

## 13. Pending decisions

1. X provider/access/cost and authorized Reddit credentials.
2. Confirm source profiles: always try HN/Reddit/X or select by intent; Google and technical sources by context.
3. Confirm grep.app + Context7 as technical discovery and direct GitHub only as reader/fallback.
4. Confirm first version without mandatory internal LLM planner.
5. Approve action names, tree/counter, isolation, and research sharing.
6. Define time, cost, storage, comments, concurrency, and return size.
7. Define retention, cache update, and cleanup.
8. Browser/authentication and jobs integration.
9. Define access/key/quota for Context7 and grep.app after verification, without requesting secrets in chat.

## 14. Future acceptance criteria

- Agent does not expand owner policy; config is validated/versioned.
- Planned reads are executed in tool; snippets do not count as complete documents.
- Documentary content returned by connector may satisfy typed partial reading, without mandatory redundant scraping.
- Parallel pipeline respects limits and source diversity.
- Content from any transport, including MCP, is persisted and bounded before context.
- Continuation preserves references, budget, and provenance.
- Partial failures, dates, and coverage limits are explicit.
- External content remains untrusted including in local files; no embedded instructions are executed.
- Secrets do not appear in logs/collection/returns; paths/URLs are validated.
- Concurrent IDs do not collide; interruption and cancellation preserve valid evidence without orphaned work.
- Tests cover timeout, blocking, empty sources, duplicates, pagination, comments, budget, context limits, prompt injection, SSRF, traversal, concurrency, and recovery.
- Specific tests cover ambiguous library resolution, missing version, insufficient code excerpt, MCP quota, and incomplete origin metadata.
- Real future validation reports effective access/cost/coverage, without promising automatic equivalence to commercial services.

## 15. Next action

**Deliver this revision and await reading and explicit human guidance. AutoApprove does not authorize proceeding against this guidance.**
