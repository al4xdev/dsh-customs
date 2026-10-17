# Personal LTS: Parallel Polish of Trash, Clipboard, and Context

## Intent
Conservative final review in parallel, requested by the user. Not a bug hunt, rewrite, or feature expansion. MCP remains last. Use active goal through verification; preserve all existing modifications.

## Completed Reviews
The three subagents identified no concrete need to modify production. The base already has 50 tests passing for the contracts of apply-patch, list, and grammar. Legacy tests recorded in READMEs remain historical evidence and will not be rebuilt as a general test suite.

## Independent Implementation by Plugin
1. **Trash:** create a dedicated short README and read-only trash.test.mjs covering public policy contracts, invalid inputs, and protected paths. Do not call trashOne/execute or delete/move/create fixtures. Clarify no-overwrite recovery, tmpfs lost on reboot, and cross-FS/metadata limits. Do not promise real rename/EXDEV/recovery tests.
2. **Clipboard:** create a short README and clipboard.test.mjs with a FAKE wl-copy executable in .dumps, PATH pointing exclusively to this stub, and dummy display. Test Unicode/newlines, empty text, failure, missing executable, cancellation/timeout; socket discovery only if simple. Do not access real clipboard/compositor. Fixtures/processes belong strictly to the test; cleanup bounded to identified test resources. Do not expand into complex descendant process management. Document Wayland/wl-clipboard, environment, lack of X11 fallback, and that cancellation is not rollback.
3. **Workspace-context:** create workspace-context.test.mjs focused on existing cwd/session contracts and prompt; if convenient, artificial local Git fixtures in .dumps for root/subdir/outside Git/symlink. Without modifying index.mjs. Add to existing README only test command and limits, preserving all existing good documentation.
4. **Integration by main agent:** add scripts test:trash, test:clipboard, test:workspace-context, and test:lts:contracts for the six reviewed plugins, without managed-plans/MCP and without live model calls. Document this current scope in plugins/README.md without confusing historical evidence with validation of the entire harness.

## Constraints
Subagents only edit tests/README of their assigned plugin; package.json and central README are owned by the main agent. index.mjs for all three and common.mjs remain intact. No deployment/activation, new dependencies, migrations, real clipboard copying, or real trash operations. If a production need arises, report and discuss before expanding.

## Acceptance
Focused suites and contract set passing, outputs/failures collected, diff/whitespace verified, limitations of mocks versus integration made clear, and production files have zero diff. No commit/push.
