# Companion: Recent Files and Event Navigation

Current contract for public tool `session` (Plan 125). Does not require SQLite or scan content of all sessions. `send`/`resume` and their controls follow previous paths.

## Discovery

- `list` uses POSIX file metadata from the configured public root of `session-persistence-jsonl`. Selects highest physical generation per directory and sorts by descending `mtime`.
- Headers are read with bounded prefixes, including zstd compressed files. `origin:subagent` or `delegationDepth>0` exclude subagents prior to slot counting; `agentPreset:companion` excludes Companion. Depth 0 admits root/continuation even with `parentSession`.
- Insufficient metadata yields `unknown`, never invented root sessions. `skipped` reports exclusions. Future versions do not silently fall back to older generations.
- Default 10 root sessions, `limit` up to 100. Proven empty sessions, lacking title and messages, do not occupy slots. A partially readable file is not declared empty.
- Only selected entries are read for title and preview. Title is latest observed `session/title`, including renames with origin `user`. Titles are not unique identifiers; actions use ID.
- `mtime`, title/last message, and bridge are distinct facts. Recent file does not prove living agent. `writer:held` and `state:alive` preserve separate meanings.
- Listing pages freeze selection/ordering, not state of the world: mutations in other files do not invalidate cursors. Displayed metadata may refresh upon visiting the page.

```json
{"operation":"list"}
{"operation":"list","project":"/home/USER/git/my/dsh-customs","limit":10}
{"operation":"list","cursor":"<nextCursor>","project":"/home/USER/git/my/dsh-customs","limit":10}
```

## Literal Search

`find` and `search` locate literal text, not regex or SQL. Default: latest 100 root files **after classification**, tunable via `maxFiles` up to 1000. `scope` accepts `messages`, `tools`, or `all` (default). Permitted text/args/results are redacted prior to search; internal envelopes and attachment bodies are excluded.

```json
{"operation":"find","query":"Hacker News","maxFiles":100,"limit":10}
{"operation":"find","sessionId":"<id>","query":"exit code: 1","scope":"tools"}
```

`candidateBudget` bounds files per call (default 10, up to 100), including failed ones. `durationMs` is a cooperative budget (default 5000, up to 30000); host cancellation is respected. Responses indicate selected files, examined files, errors, coverage, and `nextCursor`. To continue, retain query/filters/scope. A page that stopped mid-file maintains its snapshot; appends do not shift hits for that continuation.

`complete-selected-files` strictly means the chosen set, never the full history. Direct search by `sessionId` opens an exact session; Companion remains forbidden. Subagents lack dedicated operations and do not pollute the global list, but exact ID enables drill-down when needed.

## Reading and Inspection

```json
{"operation":"read","sessionId":"<id>"}
{"operation":"inspect","sessionId":"<id>","view":"head"}
{"operation":"context","sessionId":"<id>"}
{"operation":"read","sessionId":"<id>","seq":120,"before":3,"after":3}
```

- `read` starts at the end; `inspect` at the beginning. `context` displays distinct start/end windows by default, without claiming to represent the entire conversation.
- `seq` identifies exact logical event; `offset` starts at that sequence or the next existing one. These are not physical line numbers.
- Messages, tool calls/results, titles, and relevant execution records are navigable. Unknown records may appear as metadata only, with explicit `omitted`.
- `previousCursor`/`nextCursor` navigate within captured snapshot. A new call without cursor refreshes the file; `revision` enables polling without returning identical content.
- Cursors retain selection and captured content in bounded cache: expire after 15min idle or under memory/quantity pressure. When expired, restart operation; no global invalidation on arbitrary workspace appends.

### Deep Dive into a Tool Call or Result

```json
{"operation":"read","sessionId":"<id>","seq":120,"section":"arguments","format":"json"}
{"operation":"read","sessionId":"<id>","seq":121,"section":"result","format":"json"}
{"operation":"read","sessionId":"<id>","seq":121,"section":"event","format":"json","textLimit":4096}
```

Permitted JSON is serialized into `events[].text` to allow paginating long events. `format:json` does not guarantee an intact object when the page is a fragment. `textLength`, `textOffset`, `nextTextOffset`, and `cutoff` make this explicit. To continue long content, repeat **identical ID, seq, section, and format**, using `nextTextOffset`. Default 2048 characters per event; ceiling 16384. If output is short due to byte budget, next offset matches actual returned fragment.

The agent can find "I ran tests", open results of that test, inspect neighboring events, and summarize findings without receiving the entire conversation automatically.

## Limits and Guards

- Standard output 16384 JSON bytes, minimum 1024 and maximum 32768; up to 100 lines/events per call. Metadata may require larger budget than 1024 in edge cases; explicit error instead of dump.
- Reader: up to 64 MiB decompressed per file, up to 8 MiB per line, snapshot cache 32 MiB / 32 entries. Navigation: up to 24 states / 64 MiB, TTL 15min. Catalog: up to 20000 metadata entries examined, cache of 2048 headers.
- Selected zstd file is read via streaming; arbitrary seeks at compressed end are not promised. Limits, partial EOF, or concurrent mutations signal `partial`, `titleComplete`, and `tailComplete`, without asserting complete title/tail.
- Root comes from public service, not arbitrary model argument. Symlinks and swapped identities rejected. Header inspection uses anchored Linux/procfs file descriptors; platforms lacking this fail explicitly.
- Credentials recursively redacted by keys/patterns before pagination. Redaction is best-effort, not cryptographic proof of absent private data. Reasoning/request envelopes and attachment bodies stay excluded. Logs remain untrusted data, including instructions embedded within them.
- No writes to canonical logs, database migrations, message dispatch, or agent resumption occur during reads.

## Compatibility

Public Companion tool enables the file-based reader. `sources` and `paths` remain metadata discovery; to open content use `sessionId`. `pathRef`/`directory` are rejected in new content operations and do not bypass Companion exclusion. `describe` outlines exact contract per operation. `search` is literal alias; legacy `phrase`/`substring` modes do not activate SQLite on this route.

Legacy reading implementations via public services remain for internal/test compatibility, but do not replace the new public route or modify `send`/`resume` gates.

## Validation

```sh
env SESSION_RESUME_REAL=0 node --test plugins/session/*.test.mjs tools/session-companion/profile.test.mjs
```

Resume test uses synthetic adapter, sending no messages to real sessions.

Read-only smoke test is in `.dumps/session-usability/recent-runtime-smoke.mjs` with compact results / local JSON artifact. Includes real root listing, renamed titles, tail reading, JSON tool results, and literal search. No forced restart of Companion service; reload its process to guarantee fresh code in an active instance.
