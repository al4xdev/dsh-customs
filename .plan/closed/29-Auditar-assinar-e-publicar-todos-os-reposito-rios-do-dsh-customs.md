# Audit, sign, and publish all dsh-customs repositories

## Objective and authorization
Address the explicit request to review all .git repositories under /home/alex/git/my/dsh-customs, commit legitimate changes in English following the Google/Conventional Commits standard, and push with cryptographic signatures. The active goal guides execution until final validation.

## Inventory
Enumerate the main repository, frontend/dsh-tui, vendor submodules, plugins/dsh-antigravity, and worktrees/clones under .dumps; group by git-common-dir to avoid repeating the same repository. .dumps is private scratch: audit references but do not incorporate/publish dumps, caches, credentials, logs, builds, or generated copies. Directories without .git will not be invented as repos. Respect AGENTS in each root.

## Security and commits
- Review complete changes, detect credentials/private data, and separate coherent groups. Keep files and content from other work; the request now authorizes committing existing reviewed changes, not implementing arbitrary new tasks.
- Do not directly manipulate the content of .plan mirrors/registry. Active runtime SQLite data must not be published; if needed, remove only its Git tracking and ignore runtime state, keeping the local file intact and Markdown documents reviewed. Do not delete or rewrite plans.
- Run focused offline/read-only tests for each change, without paid LLM probes, deployment, or restarts. New failures block a group until the cause is identified; pre-existing failures must be explicitly recorded.
- Commit explicit paths, avoiding `add .` / `-A`, using `type(scope): imperative English` titles and body when needed. Use `git commit -S` and verify each signature with `git verify-commit/%G?`. Do not create empty commits solely to sign history, nor rewrite published history or force-push.
- Concurrent changes detected by hashes/status must be re-evaluated before stage/commit; no stash/reset/clean.

## Remotes and publication
Current gh identity al4xdev; existing personal remotes will be preferred over third-party upstreams. Verify auth/remote branches/ancestry before each push, publish appropriate working branches without `push --all/--mirror`, and respect submodule dependencies (child before parent). If there is no personal remote and a GitHub upstream exists, use gh for a personal fork, preserving upstream; if a genuinely new repository lacks upstream, create a private personal repository by default via gh. Do not alter the visibility of existing remotes and never publish secrets. Treat shared experimental worktrees as local evidence; publish consolidated code changes on the appropriate branch once integrated.

## Acceptance
List of all roots/canonical repos and scratch classification; each safe public change committed in a signed and validated group; each branch intended for publication synced with personal remote with local/remote SHA verified. Items excluded due to privacy, concurrency, or signature/authentication will be accurately reported, without claiming non-existent clean state/synchronization. No tags/releases/PRs or force-pushes.
