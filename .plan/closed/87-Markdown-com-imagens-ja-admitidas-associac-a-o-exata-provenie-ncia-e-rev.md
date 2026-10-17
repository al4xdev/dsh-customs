# Markdown images linked only to existing native receipts

## Request and audit
The owner reported that typed images already work in APK8, but not images within response Markdown. Task 85 requested investigation and correction solely with exact association / provenance. The example ![...](...) was requested and has not yet been provided; do NOT claim the real case was fixed without knowing it. Readonly c8 confirmed Image.destination discarded in MarkdownProjection92 and no image tile. Public SDK 0.2.0-rc.2 dsh-tool-fs:202–210 resolves file_path in backend/session, 973–995 defines read_image, 1007–1019 reads regularfile and saves bytes, 1035–1045 returns path/ref; 955–962 renders exactly one typed Image. ref.name is a basename, not a secure alias. Canonical read_image is an explicit hypothesis of this curated deployment; wire does not attest package-id.

## Implementable scope without new backend
Preserve alt/destination as inert data in AST / text preparation. In a subsequent plan, resolve only in FINAL/DURABLE assistant prose:
1. Exact attachment:<opaqueId> of an image originating from a prior native receipt, confirmed and unambiguous within the same admitted conversation.
2. Destination EXACTLY identical to the ORIGINAL file_path of a canonical read_image call actually dispatched, with complete/strict args and a single resulting typed image, success/resultSeq > callSeq. Without comparing ref.name/basename, without resolving cwd/realpath/URL/percent-decode/./ or guessing returned canonical path. Repeated alias pointing to different refs fails closed.
No generic URI authorizes reading. http(s), file, data, content, javascript, sandbox without prior exact association remain inert. Do not install package/provider/network/RPC/alias server; do not construct ImageReference from JSON/text/names. Reuse complete already admitted ImageReference and existing OwnedImageCard / transport attachment with its verifications.

## Mandatory provenance and chronology
ToolTimelineProjection 45–47 fills missing name/args from assistant preview even with callSeq: do NOT derive alias from post-fallback ToolPresentation. Derive immutable DTO of receipt/call/path in RichTranscriptProjection BEFORE that fallback (or from admitted originals during presenter), solely from dispatched original pair and corresponding result. Missing/orphan/preview/partial args/duplicate/error/truncated/offloaded/multi-image refuse association. Verify JSON duplicates effectively (strict syntax by itself does not guarantee this).
Full tool appears at original position of CALL and may have future resultSeq: do not use line order to prove precedence. Require resultSeq < ORIGINAL cut of the response. Real final sourceSeqs exist; provenanceSeqs may be empty. Live has empty sourceSeqs / synthetic seq: keep Markdown images inert during streaming if there is no proven durable cut; current native images are not delayed.

## Cache/revisão/performance
PreparedMarkdown/text cache stores only alt/destination, NEVER association/authorization/ref. Resolve in the current plan off-main, per current session/generation/revision. New image cell carries dependency on assistant origin AND complete receipt (sourceStableId/callId/callSeq/resultSeq/args/ref fingerprint). Immediate filtering of displayed cells must revalidate on removal/replace/compaction/prune/partial history, even if assistant text does not change and even if ref remains elsewhere. VM knownNow alone does not prove association. No global/saved alias; caps per message, stable structural keys, same existing LazyColumn/SelectionContainer/preview. Do not parse large args/JSON on Main, nor alter layout/fonts/motion/gestures/palette/copy.

## Negative/positive validation
- Final with real sourceSeqs and empty provenance accepts prior receipt; live and future receipt at prior call position refuse.
- Preview/orphan/missing callSeq, original call with null name/args recovered by Timeline, differing callId, invalid seq, duplicate JSON, error/truncated/offloaded/multi-image refuse.
- Same basename in different dirs, relative/absolute/.//percent encoding do not fuzzy-match. Without typed image, JSON/text/path envelope does not create image.
- Ambiguous alias and repeated reads for different refs remain inert; removal/change of args/path/ref removes old cell immediately during replan, even if same ID remains in another receipt. Cross-session/generation/refmetadata fail.
- Verify parser limits / Markdown image in middle of paragraph, selection/lazy/pan/history/finalization, new cap/revision, and Native OwnedImageCard on synthetic fixture. Never private image/URL/file or real model/HTTP/service call.
Parent centralizes Gradle/lint/protocol/JVM/Android on own emulator 5039/5580. Coordinate freeze of 85/86 and compilation; do not edit sources being read by a running build. Do not install on phone, alter profile/backend/SDK/TUI/vault/HA/network/model, or activate 82/83.

## Honest delivery
Include safe subset in APK9 if validation passes; document that arbitrary URLs/files and resolved paths differing from ORIGINAL remain unsupported, and request an example of the real case to determine whether a backend alias / separate external permission proposal is needed. Without promising universal fix. Current goal continues guiding execution and remains active until complete validation / necessary decision.
