# Companion: conversation titles on the initial catalog load

## Observed problem

In the native app (`android/companion`), the conversation list shows `Conversa <id>` instead of
the name. The name only appears after opening the conversation; closing and reopening the app
brings the id back, because everything is loaded from scratch.

## Cause

The app is ready to display a title; the host never sends one. The pipe exists all the way to
the tap and it is closed:

- `plugins/companion-api/contracts.mjs:46` — a row only carries `title` when `hints.title` is present.
- `plugins/companion-api/recent-catalog.mjs:33-35` — production builds `hints` with only
  `{ updatedAt }`; it never passes `title`. This is the live path (`index.mjs:54`).
- `plugins/companion-api/catalog.mjs:44` (list) and `:79` (detail) call `companionMetadata`
  without hints, so neither the list nor the detail carries a name.
- `plugins/companion-api/message-heads.mjs` returns `knowledge`/`asOfSeq`/`lastVisibleAssistant`,
  never a title.
- No production caller passes `title` in hints; only tests do.

The only path that produces a name today is the open session stream: `publishFollowTitle` reads
`projections["title"]` (`CompanionCatalogMerge.kt:60`). That is why the name depends on opening
the conversation, and why it disappears on a cold start (app state is RAM only,
`chats = emptyList()`).

Nothing is missing on the app side: `CompanionChat.title` is optional, `NativeCodec.kt:190`
already parses `title` in the list, `mergeRefreshedCatalog` preserves a confirmed title, the UI
falls back to `Conversa <id>` only when it is null, and `CompanionNativeTitleFence95Test` /
`CompanionNativeTitleRefresh95Test` fence the behavior.

The host already has the right public API and does not use it: `sessionQuery.readTitleSnapshots(ids, signal)`
(fold titles for several ids from one cancellable corpus observation), next to `readTitle` and
`readTitleSnapshot`.

## Scope

Host only: enrich `companion/listChats` with titles read from the session log, as `hints.title`.
No change to the app, the protocol, or any client-side cache.

## Design

- A title is a **display hint**, never membership. It does not enter the cursor `revision`
  (today `id + createdAt`, `catalog.mjs:50`), does not change order, and neither adds nor
  removes a row.
- Source: `sessionQuery.readTitleSnapshots` for the ids of the returned page only, never for
  the whole catalog (up to 4096 rows).
- Never blocking: a per-page time budget (same order as `messageHeads`, ~1–1.5 s). On timeout,
  failure, or a missing title, the page is returned exactly as today — without a title. A list
  without names is the current behavior; it must never become an error.
- Bounded cache per id (~128 entries) holding `{ createdAt, title, eventSeq }`, valid only for
  the same incarnation (`id + createdAt`). Invalidation: a `session/title` event drops the
  entry — `activity` already listens to that stream (`activity-source.mjs:59`).
- Reuse existing sanitization: `companionMetadata` already trims to 240 chars and strips control
  characters; `createRecencyPager` already validates `title` (`activity-order.mjs:99`) and
  already drops the title when the byte budget cannot fit it (`:84`).
- Byte budget: if attaching titles overflows `MAX_BYTES`, return the same page without titles,
  preserving cursor progress.

## Steps

1. Add `plugins/companion-api/title-hints.mjs`: a resolver that takes the ctx, obtains
   `sessionQuery` tolerantly (absent → no titles), keeps the bounded cache, subscribes to
   `session/title` for invalidation, and exposes `read(ids, signal) → Map<id, title>` with a time
   budget and cancellation.
2. Wire it in `plugins/companion-api/index.mjs:54`, passing the resolver to `createRecentCatalog`
   alongside `activity`/`base`/`contracts`.
3. In `recent-catalog.mjs`, after the pager returns the page, resolve titles for the returned ids
   only, rebuild those rows with the `title`, and revalidate with `parseListOutput`; when bytes
   overflow, retry once without titles.
4. Close the resolver together with the catalog (`index.mjs:64-69`).
5. Add tests under `plugins/companion-api/` (below).

## Tests

- A fresh page carries `title` when the resolver knows one for the row.
- A row without a title stays valid and without `title` (never an empty string or fallback).
- Resolver rejection or timeout → page identical to today's.
- `title` changes neither membership, order, nor the cursor `revision`; the following cursor page
  also carries titles.
- Cache: a second call does not re-read; a `session/title` event forces a re-read (rename shows up).
- Budget: a title that overflows `MAX_BYTES` is dropped and the page still makes progress.

## Verification

- `npm run test:session` (includes `plugins/companion-api/*test.mjs`).
- Real check on the companion profile: force-stop the app and open it — the list must be born with
  names; rename a conversation on the PC and refresh — new name; a conversation without a title
  event keeps `Conversa <id>`.
- No client change is expected: `./gradlew :app:testDebugUnitTest` only as a confirmation that
  nothing broke.

## Risks

- Cost of folding logs on a cold catalog. Mitigated by: page only, per-incarnation cache, time
  budget, absence never blocking.
- A rename may take a while to reach the list because `session/title` does not count as activity in
  `activityTime` (`activity-order.mjs:12-22`) and therefore does not invalidate the catalog.
  Acceptable: with the conversation open the title arrives through the stream; in the list it
  appears on the next refresh.

## Out of scope

- Caching or persisting conversations on the device (contradicts `CompanionCatalogMerge.kt:21`:
  membership comes from the current catalog, never from the cache).
- Seeding the catalog from the login-proof page and animating message entry — two separate UI
  improvements, each deserving its own plan.
