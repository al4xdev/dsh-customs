# Organize pending local changes into topic commits

## Request and goal
User explicitly requested committing everything pending here, separated into multiple commits. Active goal: goal-5e620b81-e8d6-4edc-a6fc-81c3d2c09fc6.

## Scope
Inventory the current working tree, new files, and any nested Antigravity Git fork. Review diffs and files to avoid secrets, node_modules, dumps, backups, and ignored private artifacts. Preserve all changes from other tasks, including work in progress, without implementing or reverting them. Plans are managed snapshots: version what already exists without editing mirrors/registry.

Separate cohesive commits for: installation/activation/profiles; Codex retry and categories; self-healing v2; companion bridge/session; mobile frontend; documentation; plan snapshots. Adjust groups according to real diff dependencies. If the Antigravity fork has its own Git and pertinent changes, create its commits in that repository, without forcing inclusion into root.

## Execution and security
Independent read-only review may be delegated. Check relevant existing tests / whitespace, large files, and credential patterns, without printing secrets. Use explicit paths for staging; review staged diff before each commit. Do not use indiscriminate `git add -A`, reset/rebase/amend, file deletion, installation, modification of others' work, or push. Existing Git identity configuration; if missing, ask user for data, do not invent.

## Final verification
List commit hashes and subjects; verify root and fork status. Explain intentional exclusions and any work that appeared during commits. Do not claim open/WIP tasks were completed merely because they were committed. Complete the goal only when everything appropriate from the inventory is committed and results are verified.
