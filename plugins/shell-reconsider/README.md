# Shell reconsideration

Small optional plugin intercepting the existing native `bash` through `tools/pre-execute`. No DSH core changes, shell wrapper, automatic command execution, or model calls from the plugin.

## Interception rules

- **Read / Inspection operations (`cat`, `head`, `tail`, `less`, `more`):** Denied immediately, instructing the model to use the native `read` tool.
- **Directory exploration / File listing (`ls`, `tree`, `find`):** Denied immediately, instructing the model to use the native `list` (or `glob`) tool.
- **Content search (`grep`, `egrep`, `fgrep`, `rg`):** Denied immediately, instructing the model to use the native `grep` tool. Downstream pipes filtering legitimate command output (e.g. `npm test | grep FAIL`) are not blocked.
- **Destructive file removals (`rm`, `unlink`):** Denied immediately, advising use of the native `trash` tool for recoverable removal. If permanent deletion was explicitly requested by the user, calling `shell_reconsider({ necessary: true })` grants one identical retry.
- **Legitimate development commands (`npm`, `git`, `python`, compilers, test runners, etc.):** Pass directly without friction or prompt disruption.

Pending decisions and grants expire at the next agent turn; state is process-local, per session, and reset on restart. PTC/run_code nested bash calls are intentionally not intercepted: an inner program cannot request a separate model decision.

Configuration:

- `interval`: positive integer, default 50 (retained for backward compatibility).
- `unit`: `steps` or `turns` (retained for backward compatibility).

The notice is available for one following model step. Before later steps its result content is replaced on the supported model surface with neutral text. The original audit transcript remains intact. This does **not** erase the assistant's own prose/reasoning or confirmation call; those cannot safely be stripped by this small plugin. A restart before cleanup can retain an outstanding notice. This is a reflection nudge, not a security boundary. PTC/run_code nested bash calls are intentionally not intercepted: an inner program cannot request a separate model decision.

Activation is intentionally separate: the adjacent `cordis.patch.yml` inserts only this plugin, with paths relative to the overlay. Load it as an additional DSH overlay, or insert the entry in your selected profile. Do not install the same entry twice. Existing shared plugin overlays and profiles were not changed.

Implementation only: no tests, validation runs, or live activation were performed, as requested.
