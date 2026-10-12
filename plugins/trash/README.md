# Recoverable trash

`trash` accepts explicit paths, absolute or relative to the session working
directory; it does not expand globs. Symlinks are removed as links, not as their
targets. Broad paths, working-directory/workspace ancestors, credential trees,
Git worktree roots and mount points are protected. Read-only policy denies
removal; workspace-write remains limited to the runtime's writable roots.

Each item gets a private `/tmp/alex-dsh-trash-*` directory containing `item` and
`manifest.json`. Results include the original and recovery paths and a per-item
status. Batches are **not atomic** (`atomic: false`): an earlier item can succeed
when a later one fails.

## Recovery and limits

- Recover only when the original path is free; never overwrite a recreated
  original. Inspect the returned status and manifest before manual recovery.
  There is no companion restore tool or automatic rollback.
- `/tmp` is tmpfs on this machine: RAM-backed and lost on reboot or cleanup.
  Recovery is temporary, **not a backup**.
- Across filesystems, trash copies and verifies before removing the source.
  Removal may still fail partway (`source_partially_removed`); the result identifies
  the full verified recovery copy and the remaining source entries. An aborted
  copy may be incomplete: do not treat every recovery path as a verified backup.
- Cross-filesystem copying does not preserve extended attributes/ACLs or inode
  change/birth times. Hard links become separate files; ownership may change to
  the current user. Consult `metadata_not_preserved` in the result.
- Ancestor and source checks detect changes, but remain path-based: they do not
  eliminate the final check-to-syscall race with external writers.

## Contract tests

From the repository root:

```sh
node --test plugins/trash/trash.test.mjs
```

These read-only tests cover policy acceptance/denial, invalid inputs and protected
paths through `requireFullAccess` and `checkedSource`. They create no fixtures and
never call `trashOne` or the registered tool. They do **not** exercise actual
removal, sandbox path enforcement, rename, cross-filesystem copying or recovery.
Imports require the existing local DSH installation resolved by `common.mjs`;
no extra dependencies or model calls are needed.
