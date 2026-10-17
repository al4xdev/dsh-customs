# Implement research and replace default search

## Human authorization

The owner explicitly authorized beginning autonomous creation of the tool, replacing the default search tool in all profiles upon completion, and preserving results when any provider fails or reaches a limit. This authorization supersedes the pause for review of base plan 116 r3. The base plan remains architectural reference; this artifact bounds execution.

## Objective and goal

Execute under goal `goal-088b322f-eac8-40f6-be0a-fc5c9b9d7f2e`: native research plugin, persistent collection bounded to context, continuity and partial failures, tests, and activation across all profiles. Do not mark goal complete without verifying delivery and recording limitations.

## Scope

1. Inspect real interfaces of web, tools, MCP client, profiles, and activation. Preserve existing work in checkout.
2. Implement plugin in `plugins/research/`, tests, and documentation: config, search, inspect, and continue; snapshots and evidence in `.dumps/research`; cumulative budget, IO/return limits, and isolation.
3. Reuse `ctx.web.search` and `ctx.web.fetch` instead of unnecessary fork. Google/web, Reddit/X with explicit fallback modes, Hacker News, grep.app, and Context7 when interfaces permit. Do not invent credentials or purchase service; unavailable connector must appear as unavailable/degraded, not success.
4. Failures 429, quotas, timeout, authentication, or blocking are recorded per source/stage. Deliver results collected from other sources and notify the agent. Do not let long-duration retry block entire research.
5. Mandatory reads occur within the tool; results are saved before being presented. Compact return includes index, refs, coverage, errors, and consumption; full content is retrieved selectively.
6. Test concurrency, limits, cancellation, partial failures, persistence, security, and continuation. Validate real integrations in controlled manner without purchasing APIs.
7. Update activation across all profiles, including companion isolation per real interface. Remove only exposure of default search; preserve necessary backend service and compatible reading. Reversible configuration, without forcibly restarting a session in use.
8. Verify registered tools in test runtime and final configurations. Document necessity of reopening existing profiles if loading is not dynamic; do not claim hot reload without evidence.

## Implementation decisions

Use conservative configurable defaults for limits not yet defined; agents can only lower owner ceilings. Core sources: web, Reddit, X, HN. Technical sources opt-in per research. No mandatory second LLM. No bypassing blocks, personal authenticated scraping, or contracting without specific authorization.

## Acceptance criteria

- Usable research tool with config/search/inspect/continue and stable references.
- Research persists locally with path protection and bounded files; context does not receive entire collection.
- Failure of one connector does not block results from others, and distinguishes snippet from real reading.
- Budget shared across calls; cancellation and timeouts do not leave internal operations uncontrolled.
- Automated tests and controlled smoke; real quotas/unavailabilities explicitly recorded.
- New tool configured in all existing/generated profiles and web_search not exposed in these registrations; backend preserved.
- Changes unrelated to task not reverted or overwritten.

## Next action

Continue inspection and implementation after approval of this revision. Upon completion, close artifact with evidence, update goal, and deliver summary of usage, tests, and limitations.
