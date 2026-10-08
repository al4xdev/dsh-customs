# DSH Plans 1–4 acceptance follow-up

## Objective and scope

The owner authorized parallel agents to validate non-web runtime profiles, compare native edit/write/apply_patch on a real GPT Sol code task, validate the active smaller local model, improve Git discovery and evaluate cwd deduplication without modifying installed core. During work the owner deleted `tests/`, then explicitly said not to reconstruct it. A subsequent power failure rebooted the machine; old empty reports are not evidence of success. New validation artifacts stay in `.dumps/` and the deleted directory is not restored.

## Real model-led comparison, verified after reboot

Three independent coding runs worked in isolated copies of the actual clipboard plugin and its existing tests, using only the assigned mutation tool. Real bug: wl-copy exits nonzero while a forked child keeps stderr open, causing an incorrect timeout instead of prompt code/stderr failure. The active coding harness identifies its model as gpt-6.1-sol; no token/cost estimate was invented.

| Assigned tool | Reads of the two target files | Mutation calls | Target-file total | Retries/tool errors |
| --- | ---: | ---: | ---: | ---: |
| edit | 2 | 2 | 4 | 0 |
| apply_patch | 2 | 1 (both files) | 3 | 0 |
| write | 2 | 2 | 4 | 0 |

These are reported actual target-file tool sequences, not total conversation calls. The edit run additionally read unchanged common.mjs. Edit/write used explicit red/green validations; apply_patch ran final validation once. Expected regression failures before fixes are not mutation failures. One run per approach is not a broad reliability or model/token benchmark.

The parent re-ran all three retained suites after reboot: 45 cases, 42 passed, zero failures, three opt-in live-clipboard cases skipped. The parent reviewed and applied the shared exit/close failure handler to the actual plugin, then ran two source-targeted checks (both passed). Original production failure was observed at 156ms with a 150ms timeout; after the source fix the same reproducer returns code-1/known-failure in 6ms. No real clipboard was changed. Copies and source regressions: `.dumps/sol-tool-comparison/`.

## Local model

Persisted pre-reboot events prove actual fresh DSH Bonsai read -> apply_patch -> read and a separate accurate machine-context answer. Live endpoint after reboot still advertises `Ternary-Bonsai-2-27B-PQ2_0`. Existing profile catalogs/defaults were preserved; a scoped CLI overlay selects discovered model and reasoningEffort low because inherited high fails this model's template. The post-reboot run failed: the model repeatedly inserted literal spaces after patch markers, then the endpoint disappeared and the session ended with a transport error. The fixture remained unchanged. This is not a success claim or evidence of what stopped the server. The tool now includes an exact parseable example and explicit whitespace guidance; four source/guide checks passed, but this revised guidance was not revalidated on the local model. The owner instructed us to use the default model (or Luna if available), not the local server; no further local calls were made. See `.dumps/local-model-validation-20260719/`.

## Runtime profiles and Git

Fresh non-web PTY probes use unique per-run ids and fsync'd reports to avoid treating stale/empty files as success. Plain tui has only a base bundle and no frontend; service operation must not be described as a terminal UI. The earlier dsh-tui `commit` exception was an incorrect probe callback return, not an established core compatibility bug. The parent reproduced all three runtime probes successfully after reboot, run `20261008T165000-8161eb65ca9b4f6cb185dcca6e666d37`: 11 checks per profile, four custom tools registered, clean exit 0. dsh-tui rendered its actual UI. Headless entrypoint was disabled only in the service probe; the separate model sessions exercised the real headless task runner. Evidence: `.dumps/profile-validation/`.

Git discovery now delegates validity/environment/worktrees to bounded git rev-parse, with a 250ms subprocess limit, compact errors and one-second per-agent assembly cache. The exported explicit functions remain uncached. The parent reproduced Git/worktree/environment/error/cache checks after reboot; all passed, including a hung Git killed at about 253ms. Evidence: `.dumps/workspace-validation/report.json`. The public registry cannot establish ownership of an identical cwd persona line or remove just that fragment safely, so the persona remains unchanged and the minimal duplication is documented. Finally, actual native read -> apply_patch -> read -> apply_patch_undo -> read calls in this chat changed and restored `.dumps/direct-harness-validation.txt`, preserving its other lines. No additional suites or local-model calls were needed.
