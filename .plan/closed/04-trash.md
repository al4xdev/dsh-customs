# Plan 4 — trash tool for recoverable removal

## Objective

Add a machine-local `trash` tool that moves files or directories into a recoverable location under `/tmp` instead of permanently deleting them. Implementation was subsequently authorized and delivered as a local plugin with cross-filesystem recovery and separate-runtime integration tests. Persistent activation in web/headless/tui/dsh-tui and AGENTS.md migration are implemented. Additional fail-closed ancestor-topology checks passed same-device and EXDEV workspace-write regression tests; compare-and-remove remains non-atomic against external writers, as documented. See `plugins/README.md`.

## Contract

- Accept explicit source paths, resolved against a clearly defined working directory.
- Validate and report the intended absolute source before moving it; guard against empty paths and refuse filesystem roots, home root, and other protected broad targets defined during implementation.
- Use a dedicated, private directory under `/tmp` and collision-resistant destinations. Never overwrite an existing recovery entry.
- Preserve original paths in a small recovery manifest and return original-to-recovery mappings in English.
- Treat symlink entries as entries to move, not instructions to remove their referenced targets. Validate parent-path resolution and permissions.
- Define cross-filesystem behavior: do not remove the source until a copy is confirmed complete; handle failure, metadata limits, and concurrent source changes explicitly.
- For multiple sources, report success/failure per entry and any partial completion. Do not claim atomicity.
- Explain that `/tmp` can be cleaned by the OS: recoverable removal is not durable backup.
- No permanent-delete operation is included. Explicit user requests for permanent deletion remain a separate operation under existing policy.

## Recovery

- Provide enough information to restore an entry safely: recovery path, original absolute path, and status.
- Never overwrite a newly created file at the original location during recovery.
- Decide whether a companion restore operation is useful during implementation; do not expand the initial tool without need.

## Integration

- Create a separate tool through the harness extension/profile mechanism.
- Preserve the AGENTS.md preference for recoverable removal and reference `trash` as the preferred operation.
- Coordinate with Plan 1: patch removal must not silently bypass the recoverable-removal policy. Define whether it uses the same recovery mechanism or requires another explicit safeguard.
- Coordinate with Plan 2 to avoid duplicating operational shell recipes in context.

## Future steps and validation

1. Inspect harness extension points and filesystem policy integration.
2. Define protected paths, source validation, destination allocation and manifest format.
3. Implement move/recovery reporting and cross-filesystem failure handling.
4. Test files, directories, Unicode paths, duplicate names, missing sources, symlinks, protected targets, permission errors, partial batch failure and recovery conflicts.
5. Activate in the intended profile and update the operational guidance without weakening user preferences.

## Completion criteria

One call removes an explicitly identified item from its original location while preserving a recoverable copy and clear recovery mapping. Unsafe destinations and overwrites are rejected; partial failures are accurately reported.
