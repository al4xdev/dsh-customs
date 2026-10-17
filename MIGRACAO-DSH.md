# Applied DSH Migration Cut — Historical Guide

**The migration cut and removal of legacy runtimes have already been executed. Do not repeat the execution commands below.** `finish.mjs`/`cold.mjs` preserve the historical procedure and its tests; they depend on legacy roots that have already been moved to `/tmp`.

To check the current status, even with this TUI open:

```fish
cd /home/alex/git/my/dsh-customs
node tools/installation-consolidation/status.mjs
```

Expected result: `state: "complete"`, `canonicalLinks: 404`, `localPackages: 1`, `blockers: []`. See the post-cleanup inventory in [LOCAIS-DSH.md](LOCAIS-DSH.md).

---

## Historical Executed Procedure

Commands for **fish**, on this machine. They do not reinstall packages, do not perform login or model calls, and do not modify sessions/configs. The frontend/Android/companion prototype remains out of scope.

## What has already been done

- Web uses the canonical CLI at `~/.local/share/dsh-cli`.
- Pi source centralized at `dsh-customs/sources/pi-ai` as a verified snapshot, without inventing Git HEAD.
- Two legacy builds removed from workspace; 597 fixture directories moved to `/tmp`.
- SDK/self-heal with persistence and other current improvements preserved.

## 1. Close this TUI

Exit normally from this conversation/TUI and run the next commands in **another fish terminal**. Do not use a tool from this conversation to run the cut: the session itself is the consumer that the finalizer needs to find terminated.

The script refuses execution if another DSH TUI is active. Do not bypass this guard or use `kill -9`.

## 2. Check code and selection

```fish
cd /home/alex/git/my/dsh-customs
node --test tools/installation-consolidation/finish.test.mjs
node tools/installation-consolidation/finish.mjs --preview
```

The expected selection is:

- **404 links to the canonical runtime**: 401 shared, 2 `debug`/`ms` repairs, 1 TUI adapter.
- **205 obsolete links removed**: 203 direct and 2 UI aliases; their targets no longer exist in the legacy cache or canonical.
- Regular packages/directories, including local `dsh-llm-llamacpp`, preserved.

The `debug`/`ms` repairs use hoisted packages and verified public locks. They do not assume a known version in legacy nested targets, which are missing. Four versions already existing in the canonical runtime are explicitly adopted; no download/upgrade is performed.

**If tests fail or preview displays blockers, do not apply.** Copy only the error summary into this conversation; do not send configs, tokens, or session logs.

## 3. Apply

```fish
node tools/installation-consolidation/finish.mjs --apply
```

The finalizer verifies hashes of SDK improvements, validates the entire mapping before the first mutation, and revalidates every link. It pauses and resumes only `dsh-web.service` if it was active. It does not terminate TUIs or modify the companion prototype. A simple list of actions is placed in a private directory under `/tmp`; no extra backup or rollback plan is created.

If an error is returned, **stop**: do not re-run with invented flags, do not clear caches, and do not manually delete old folders.

## 4. Check and reopen

```fish
node tools/installation-consolidation/finish.mjs --preview
systemctl --user is-active dsh-web.service
curl --max-time 5 --silent --show-error --output /dev/null --write-out 'web HTTP %{http_code}\n' http://127.0.0.1:3080/
dsh
```

In the final preview, verify `stage: "completed"`, `complete: true`, `canonical: 404`, `retarget: 0`, and `retire: 0`. The 404/205 figures from initial selection are actions **before** the cut, not new actions to repeat afterwards.

The web instance on this machine returned `HTTP 401` before migration: this confirms the authentication boundary remains active, not a service failure. This is not an inference test.

The new TUI resolves adapter/Pi/peers in the canonical runtime. The old session is not rewritten; reopen it through the standard interface if desired.

## What NOT to delete together

Do not delete `.dumps` wholesale, `~/.dsh`, `~/.npm`, the winning sources/candidates, or `workshop-build3-20261012` (compiler/provenance still in use). This cut changes the profile graph, **it does not automatically delete the npx root or scratch runtime**: they can only be moved to `/tmp` after confirming the absence of references and processes. Do not use `npm cache clean`, `npm install`, or `activate --write` to complete this step.
