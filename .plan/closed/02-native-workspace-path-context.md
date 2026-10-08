# Plan 2 — Native workspace path context

## Objective

Extend the existing harness surface that reports the working directory so agents receive absolute and repository-relative paths together, in a compact, native-looking format. Use English for field names, descriptions, messages, and this specification so smaller models can consume the same contract.

Status: implementation was subsequently authorized by the owner and exists as a local plugin with unit and separate-runtime integration tests. Persistent activation in web/headless/tui/dsh-tui and coordinated global AGENTS.md deduplication are now implemented; existing profile settings were preserved and all four composed successfully. See `plugins/README.md` for current delivery and documented overlap with the native preset cwd line.

## Agreed direction

- Stay close to the harness: first identify the existing tool or runtime-context producer that supplies the working directory.
- Extend that surface rather than introducing a separate context tool, extra prompt document, or repeated context card.
- Present related paths together so a fresh session can interpret them without knowledge of this discussion.
- Do not repeat MCP information already supplied by the harness.
- Do not repeat permission information already present in runtime context.
- Prefer supported extension/profile mechanisms where available. Inspect update compatibility before changing upstream code; do not assume the mechanism used for Plan 1 is necessary here.

## Machine context and AGENTS.md deduplication

This plugin targets Alex's machine, not a portable environment-discovery platform. Use a small explicit configuration for known machine facts; do not repeatedly probe installations or design speculative multi-machine support.

Move environment facts currently repeated in `~/.dsh/AGENTS.md` into the native context, in English:

- Preferred shell: fish. Explain the actual executor contract accurately: if a tool executes `bash -c`, do not label that executor as fish. Configure fish execution separately if desired.
- Python workflow: uv; project virtual environment convention: `.venv/`; fish activation command: `source .venv/bin/activate.fish`. Do not claim that every project already has that directory.
- Known general-purpose utilities: uv, jq, az. Keep the list compact.
- Useful machine locations, such as `/home/alex/git/my`, plus the current absolute and Git-relative paths below.

Keep behavioral instructions in AGENTS.md: proactive clipboard copying, recoverable removal preference, comment style, goal usage, and `.plan/` / `.dumps/` conventions. Do not duplicate them in a context block.

After Plan 3 provides `clipboard_copy`, hide Wayland, `wl-copy` / `wl-paste`, environment-variable discovery, and shell recipes behind that tool. They need not consume model context. Preserve the proactive-copy instruction and update it to reference the new tool.

After Plan 4 provides `trash`, preserve the recoverable-removal policy but replace operational recipes with the tool reference where appropriate.

Migration must inspect the actual global AGENTS.md before editing it, remove only information now supplied elsewhere, and avoid an interval where required guidance disappears. Do not change that file as part of recording this plan.

## Minimal proposed contract

Use explicit English field names; adapt serialization to the existing harness convention:

```json
{
  "working_directory": "/home/alex/git/my/alex-tavern/src",
  "git_root": "/home/alex/git/my/alex-tavern",
  "working_directory_relative_to_git_root": "src"
}
```

- `working_directory`: absolute default working directory used by tools.
- `git_root`: absolute root of the Git worktree containing that directory, or `null` outside a Git worktree.
- `working_directory_relative_to_git_root`: path relative to that root; `"."` at the root and `null` outside a Git worktree.
- All three fields must describe the same observation. Avoid ambiguous labels such as `relative_path` without naming the reference root.
- A per-call `workdir` override must not silently change the session default. If a tool reports its effective directory, label it separately and resolve its relative path against the appropriate Git root.

## Optional information to evaluate, not required for the minimal contract

- Current Git branch, with an explicit detached-HEAD representation.
- A compact indicator of pre-existing working-tree changes, distinguishing unavailable/unknown from clean.
- Applicable instruction paths and whether their contents were actually loaded. Discovering a file must not be reported as loading it.

Include these only if the harness can supply them accurately without duplicating existing context or adding disproportionate latency and tokens. Do not include full diffs, directory trees, dependency lists, or complete tool inventories.

## Delivery and refresh

- Supply initial path context through the existing native surface.
- Refresh on an actual change of the session working directory/workspace; do not inject the same block every turn.
- If the existing path tool is explicitly called, return current values rather than stale initialization data.
- Do not treat a shell subprocess changing directories as a change to the harness default.
- Define behavior for symlinks, nested repositories, Git worktrees, missing directories, and Git discovery errors. Preserve the harness path convention and document whether paths are logical or canonical.
- Outside a repository is a normal state. Discovery errors should be distinguishable from a confirmed absence of a repository without verbose repeated output.

## Future implementation steps

1. Locate the harness source and inspect how it exposes default paths, runtime context, tool output, and profile extensions.
2. Confirm which proposed fields are already present and avoid duplication.
3. Choose the smallest compatible extension to the existing path-reporting surface.
4. Implement English output and precise root-relative semantics.
5. Test root, nested directory, non-repository directory, nested repository, worktree, symlink, failed discovery, and per-call directory overrides.
6. Verify refresh behavior and token footprint with a fresh session, including a smaller model where available.

## Completion criteria

- Absolute working directory, Git root, and root-relative directory appear together through the native path/context surface.
- English naming makes their meanings clear without extra project instructions.
- New sessions receive accurate context with no dependence on conversation history.
- Directory overrides do not misrepresent the session default.
- No redundant MCP or permissions block and no per-turn context repetition.
- Edge cases and update compatibility are documented and tested.
