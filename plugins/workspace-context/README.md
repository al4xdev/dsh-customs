# workspace-context

Two registrations on the native DSH prompt registry (`@deepseek-ai/dsh-system-prompt`):

- `alex-workspace:machine` — static system-prompt section (right after `tool:bash`) with the machine facts: fish for the user, `bash -c` for the bash tool, uv/`.venv/`, utilities, project location.
- `alex-workspace:paths` — runtime-context entry (`systemPrompt.context`, just before `sandbox:policy`):

```text
Workspace paths: {"working_directory":"/home/alex/git/my/alex-tavern/src","git_root":"/home/alex/git/my/alex-tavern","working_directory_relative_to_git_root":"src"}
```

## Path conventions

- `working_directory`: the session cwd exactly as DSH stores it (`session.header.cwd`, the same value as `{{cwd}}`, the bash/fs default directory and the sandbox workspace root). DSH preserves the spelling it was given, so a session opened through a symlink keeps the logical path; sessions created from a registered workspace or `process.cwd()` are already canonical.
- `working_directory_canonical`: only present when the realpath differs from that spelling.
- `git_root` and `working_directory_relative_to_git_root`: canonical, matching what `git rev-parse --show-toplevel` prints, so `git_root` + relative = the canonical working directory. `"."` at the root; both `null` outside a Git worktree.
- `git_discovery_error`: only present when discovery could not decide (missing, non-directory or looping cwd, permission denied, invalid `.git` file). `null` roots without it mean "confirmed not inside a Git worktree".

## Discovery

Runs `git -C <canonical cwd> rev-parse --is-inside-work-tree --show-toplevel` without a shell, with a 250 ms timeout, SIGKILL on timeout, and a 16 KiB output limit. Git itself validates repositories and handles nested repositories, submodules, gitfiles, linked worktrees, filesystem boundaries, `safe.directory`, and inherited `GIT_DIR`/`GIT_WORK_TREE`/ceiling configuration. Bare repositories have no worktree root. An explicit worktree override may put cwd outside that root, producing a `../` relative path. Missing Git, timeouts, invalid gitfiles and ownership errors are compact discovery errors, never confirmed absence. Git may silently skip unreadable markers: after an absence answer, at most 128 ancestor `.git/HEAD` probes reject access failures; these probes do not establish repository validity. Filesystem calls themselves are synchronous and cannot be timeout-bounded on a hung mount.

## Refresh

The provider caches each agent's rendered paths for one second (including errors), invalidating immediately when cwd or relevant inherited environment changes; repeated assemblies do not repeatedly launch Git. Repository/config/filesystem changes become visible on the first assembly after that TTL. Exported `workspacePaths` and `workspaceContext` remain synchronous and uncached for explicit callers. The agent loop appends a runtime-context snapshot only when the rendered text differs from the retained one, so the block appears once per session and again only after a real change (for example `git init` in the cwd or the cwd being removed). The session cwd is immutable; per-call directories (bash `workdir`, glob/grep `path`) and `cd` inside shells do not change it, and no DSH tool reports its effective directory to the model, so the block only ever describes the session default.

## Overlap with the persona line

The agent preset's persona suffix renders `Your working directory is {{cwd}}.` Inspection of the installed registry confirms `section()` rejects same-layer duplicates and only supports replacing a whole section through scoped shadowing; it has no public read/update/remove-fragment API. Its supported `system-prompt/assemble` waterfall could filter an exact standalone template line in the assembled persona, but cannot establish whether that line belongs to the preset or the user's own persona, and other assembly listeners can subsequently change the result. To preserve user-authored persona content without modifying core/presets or assuming ownership, this plugin leaves it untouched. The compact block repeats cwd so the related fields stay together, carrying no MCP or permission information.
