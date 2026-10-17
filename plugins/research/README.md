# Research

Native research orchestrator tool with parallel collection, mandatory reading, partial failure handling, and disk-persisted evidence. It is not a secondary agent: the turn's agent investigates and interprets evidence.

## Lifecycle

1. `research({action:"config", config:{sources:["web","reddit","x","hackernews"]}})` creates an immutable snapshot of strategy and reports capabilities.
2. `research({action:"search", config_id:"…", query:"…"})` executes searches and automatically reads selected results.
3. `research({action:"inspect", run_id:"…", ref:"…", limit:6000})` retrieves only necessary evidence.
4. `research({action:"inspect", run_id:"…", ref:"…", section:"comments", limit:6000})` retrieves comments separately.
5. `research({action:"continue", run_id:"…", query:"more specific follow-up"})` drills deeper using the same budget and deduplication.

`config.sources` accepts `web`, `reddit`, `x`, `hackernews`, `grep`, `context7`. Technical sources are opt-in. `context7` requires explicit `library` in search; confirm library identity and version in metadata. `grep` receives code patterns, not universal semantic search; `filters` can specify `repo`, `path`, `language`, `matchCase`, and `useRegexp` to avoid homonyms.

**Reddit:** Official read-only API using owner-supplied OAuth tokens; subreddit search/listing, topics, comments, and serial expansion. Without credentials returns `AUTH_REQUIRED`, without silent fallback. See [REDDIT.md](REDDIT.md) for configuration, navigation/cursors, and limits. Real authenticated validation was not performed: credentials were absent during test runs.

**Other limitations:** X continues using web index and public reads, without guarantee of full threads. HN uses Algolia exclusively for discovery (minimal fields, no highlights) and official Firebase API to fetch individual posts/comments, avoiding the giant tree JSON. Up to two requests per batch, sharing source limit across searches; `maxComments` bounds attempts (default 40, cap 200). A truncated comment or blocked article does not discard the post or valid replies. Comment text is explicit HTML; reported count is HN's `descendants`, not an exhaustive enumeration. Queue is bounded to 1000 and up to 200 pending IDs are preserved in storage; reading/storage remain partial. External search deadline may still interrupt full reads. Browser automation and arbitrary link expansion remain out of scope. Reddit pagination uses `reddit.after`; pending replies can be retrieved via `inspect` with `section:navigation`.

## Limits and Failures

Defaults: 180 cumulative execution seconds, 24 reads, 20 searches, four rounds, up to four results / two selected reads per source, 40 comments, and 60 seconds per web operation. MCP connectors also have an internal 25-second deadline. Live testing showed 15 seconds may be insufficient for Google backend. The agent may reduce limits, never raise plugin ceilings. Time budget measures execution time, not user thinking intervals.

Per-provider/stage errors (quota, 429, auth, block, timeout) appear in `errors`. Other sources continue and their results are preserved. Execution may complete with partial coverage or zero evidence; this does not prove the subject does not exist. Sources are never declared fully read based on snippets alone. No infinite retries.

Distinct research runs can execute concurrently. Shared in-process scheduler bounds each backend to 2 workers (owner can lower `providerWorkers` to 1), `morechildren` to 1, with bounded queue and quota cooldown. Web/X share backend; they do not get two workers per label. Limits are not distributed across independent DSH processes. Cancelled operations do not free slots until actual underlying work completes.

## Storage and Context

`.dumps/research/` must be gitignored in the project; the tool refuses to write if it cannot verify this. It does not automatically edit `.gitignore`. Session must permit `workspace-write` for its cwd or `danger-full-access`; no automatic escalation. In this version, even `inspect` requires this permission because opening storage prepares directories.

```text
.dumps/research/
├── configs/c-<uuid>.json
├── allocations/<counter>/
└── runs/r-<counter>-<topic>-<suffix>/
    ├── manifest.json
    ├── index.md
    ├── events/<id>.json
    └── evidence/e-<uuid>.json
```

Manifest aggregates configuration, budget, and coverage; each evidence entry stores text and metadata. Local files avoid dumping storage archives into conversation context. Search returns contain refs/index and bounded errors; `inspect` enforces its own limits. IDs are immutable and isolated per session. No implicit sharing across sessions or auto-cleanup. The folder is ephemeral, not a backup.

Continuation locks prevent two concurrent operations on the same research run. A stale lock after a crash requires manual recovery after confirming no active operation; the tool does not blindly remove locks.

## Security and Guarantees

- External URLs are read via DSH's secure HTTP service; MCP connectors use fixed targets and allowed tools.
- External data remains untrusted even when saved to local files.
- Never use browser credentials or bypass security blocks. Never enable paid APIs without owner configuration and authorization.
- Private files/directories, path validation, symlink rejection, atomic writes. Node does not offer portable openat/renameat: this is not a sandbox against a hostile local process racing ancestor directory swaps.
- Completed state signifies completion of a collection round, not factual verification or exhaustive coverage.
- `web` search reuses the profile-configured backend, which may be Google/Antigravity or another. Do not claim Google search in profiles where that backend is not installed.

## Activation

Replacement uses `tool-web.config.search:false`, preserving `fetch` and required `ctx.web` service. Profiles with presets require configuration inside the presets, not just on the host. Dedicated migrator records snapshots/recovery receipts and must not touch unrelated plugins.

Reopening DSH/profile may be required to load the new tool; saving YAML does not guarantee hot reload. Consult final activation report for verified profiles.

## Testing

`node --test plugins/research/*.test.mjs`

Connector tests use mocks; distinguish real execution from fixtures. Valid configuration does not prove live remote API access.
