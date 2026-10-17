# Fix Hacker News: Truncated JSON

## Diagnosis

The connector reads `hn.algolia.com/api/v1/items/id`, which returns the complete tree before applying maxComments. The native HTTP reader limits body and marks truncated; json() correctly rejects incomplete JSON. Result: title/snippet survives, large thread is not read. Increasing the global limit does not resolve the design flaw.

## Implementation Authorized by Bug Report

- Keep Algolia for discovery, reduce search fields to avoid unnecessary payloads.
- Use the official Firebase item/id.json API to read post and comments individually, with a cap on nodes/requests/text and at most 2 shared workers via the existing scheduler.
- Preserve parent/children relationships, metadata, pending IDs, and per-comment errors. Do not drop a valid post when a comment or article fails.
- Do not parse partial JSON or disable global limits. No change to credentials or profiles.
- Tests for large thread, truncated node, limit 0 / comment limit, removed comments, cycles / invalid IDs, article failure, concurrency, and structure.
- Limited real smoke test using public API, evidence in .dumps, and compact summary; documentation of required reload.

## Acceptance

A thread with many replies does not require downloading the entire tree; selected post/comments persist even with partial failures, honest counts, and enforced limits. Automated tests and controlled smoke test recorded. Guide execution using the current goal.
