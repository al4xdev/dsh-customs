# Plan 1 — apply_patch tool based on the official implementation

## Objective

Add a dedicated `apply_patch` tool to the harness, using Codex's official implementation as a base, without modifying the standard `edit` and `write` tools.

Status: implementation subsequently authorized by the user and available as a local plugin. Tests, integration in a separate instance, security audit, persistent activation, and practical comparison via dispatcher were completed. Kept edit/write as agreed; the comparative test confirmed identical texts with 3 apply_patch calls, 5 edit calls, and 4 write calls. No claim of model benchmarks or absence of race conditions with external writers is made. See `plugins/README.md` for evidence, deviations, and pending items. This plan preserves the original decisions.

## Agreed Decisions

- Create a separate tool to avoid conflicts with harness updates and facilitate rollback.
- Use the official `apply_patch` implementation/contract as a reference; do not invent an incompatible format.
- Keep `edit` and `write` enabled during initial evaluation.
- Evaluate disabling standard tools in the profile only after real-world tests demonstrate that this makes sense.
- MCP was already tested by the user and works; it is not part of this plan.

## Tool Roles

- `edit`: simple, precise literal replacement in an existing file.
- `write`: file creation or complete content replacement.
- `apply_patch`: contextual changes, with multiple chunks and potentially multiple files in a single call.

## Steps for Future Execution

1. Locate the harness code, its tool extension mechanism, and profile configurations.
2. Identify the official Codex source for `apply_patch`, record URL and revision, check license, and study contract, validations, and failure semantics.
3. Define the minimal harness adaptation: tool name, input format, path resolution, file policy, and success/error output.
4. Implement as an independent tool, preserving standard tools and allowing activation/deactivation via profile.
5. Test file creation, editing, and removal, multiple chunks, multiple files, divergent context, and invalid inputs. Confirm in the official reference which additional operations are supported.
6. Verify behavior under intermediate failure: do not assume atomicity; document and test whether partial changes occur or provide explicit guarantees in the adaptation.
7. Experiment on a real task and compare ergonomics, reliability, and call cost with `edit` and `write`.
8. Decide with the user whether all three tools remain available or if any standard tool will be disabled in the profile.

## Constraints and Points of Attention

- Do not alter standard tools merely to incorporate the experiment.
- Respect harness access policies and applicable workspace instructions.
- For destructive operations, consider the user's preference for recoverable files in `/tmp` or `.bak`; explicitly resolve this policy before enabling removal.
- Errors must distinguish invalid format, context not found, invalid paths, and access failures.
- Do not promise compatibility or atomic application without verification and testing.

## Contract to Define Before Implementation

- **Mandatory prior read:** require observation of original content before modifying an existing file. Record in the harness the observed version and ranges effectively presented to the agent; truncated reading does not count as full reading. For patch, require coverage of modified chunks and context; for full replacement, require full read. Define explicit handling for files newly created/edited by the session itself and for removal. A new file does not require prior reading, but creation must fail if the target already exists.
- **Outdated content:** associate the read with a content version/hash, not just path or timestamp. If the file changes after observation, reject the edit with a conflict error and require a re-read and patch re-evaluation; context matching alone does not prove the file remains at the observed version. Initially prefer invalidating observation of the entire file, even if external change is outside the chunk.
- **Concurrency at write time:** verify the expected version as close to application as possible and define synchronization mechanism and its limits. Do not claim that hashing followed by write or atomic rename eliminates the race between check and write against uncooperative external writers.
- **Shared protection:** study integration with the harness's existing observation policy to apply the same rule to `edit`, `write`, and `apply_patch`, without unnecessarily modifying standard tools. A check only in the new tool does not protect against overwrites by other tools; also make explicit the boundary of shell/MCP commands that modify files.
- **Observation tests:** cover edit without reading, insufficient partial read, externally modified file after reading, re-read after conflict, changes made by subagents, and two concurrent edits. Conflict must preserve external changes.
- **Partial failures:** define whether validation occurs before any write, which failures may still occur during application, and how the response identifies modified files, unmodified files, and uncertain state. Using the official implementation as a reference does not automatically guarantee atomicity.
- **Paths:** define resolution root, handling of absolute paths, `..`, symlinks, and targets outside the workspace; validate effective targets according to harness policy before modifying them.
- **Undo and recovery:** explicitly decide whether there will be automatic rollback, an undo operation, or backup recovery. Define scope, storage, and duration of backups, including for creation and removal; prevent undo from overwriting subsequent changes without detecting conflict. Do not use indiscriminate Git restore, which could lose prior user changes.
- **Failure tests:** simulate failure after a successful first write, failure during rollback itself, invalid targets, and concurrent changes before undo. Document limits of guarantees provided.

## Completion Criteria

- New tool available in a test profile, with official origin and license recorded.
- Tests covering supported operations and relevant failures.
- Original `edit` and `write` preserved.
- Reversible activation without core modifications, according to mechanisms available in the harness.
- Practical evaluation recorded and user decision on keeping or replacing tools in the profile.
