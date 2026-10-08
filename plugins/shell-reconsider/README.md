# Shell reconsideration

Small optional plugin intercepting the existing native `bash` through `tools/pre-execute`. No DSH core changes, shell wrapper, automatic command execution, or model calls from the plugin.

## How classification works

The command is tokenized before it is judged: quotes, escapes, comments and here-doc bodies are resolved, `$(...)`/backtick payloads and `sh -c` arguments are recursed into, and every rule is applied to a real `argv[0]` instead of a substring of the raw text.

That matters in both directions. An earlier version matched regexes against the whole string, which denied `docker run --rm`, `npm run remove-old`, and any commit message or quoted string containing the letters "rm" — while simultaneously missing `cat` on the second line of a script, `$(rm -rf x)`, `sh -c 'rm …'`, and every removal other than `rm`/`unlink`. A guard that denies obviously-fine commands stops being read as a signal and starts being routed around, which is exactly what happened before this rewrite.

## Interception rules

- **Read / inspection (`cat`, `head`, `tail`, `less`, `more`):** denied, pointing at the native `read` tool. Checked on each pipeline head, so `npm test | grep FAIL` is untouched.
- **Directory exploration (`ls`, `tree`, `find`):** denied, pointing at the native `list` (or `glob`) tool.
- **Content search (`grep`, `egrep`, `fgrep`, `rg`):** denied, pointing at the native `grep` tool.
- **Destructive operations:** denied, recommending the native `trash` tool. Detected anywhere in the command — on later lines, behind `&&`, inside `$(...)`/backticks, inside `sh -c`, and behind `sudo`/`xargs`/variable assignments. Covered: `rm`, `unlink`, `rmdir`, `shred`, `truncate`, `dd of=`, `find -delete`, `find -exec <removal>`, `git clean` with `-f`/`-d`/`-x`, and `git reset --hard`. When the command also silences failures (`>/dev/null`, `|| true`), the reason says so, because that masks a partial removal.
- **Oversized compound commands:** denied when a single call carries more than `compoundLimit` separate operations (default 6). A twelve-step script is not faster, it is opaque: the transcript shows one wall of text instead of a sequence of decisions, and there is no discrete point to revert to. A here-doc read by a shell counts as its operations, so `bash <<EOF` cannot smuggle a script past the limit; a here-doc holding data — `git commit -F - <<MSG` — does not.
- **Everything else (`npm`, `git`, `python`, compilers, test runners, `docker`, …):** passes without friction.

`mv` is deliberately not blocked: the global guidance is to move the target or rename it `.bak` instead of deleting it, so `mv` is the recommended non-destructive path.

Destructive and compound denials share the single-use permit: `shell_reconsider({ necessary: true })` grants exactly one retry of the identical command. Read/list/grep denials take no permit — the native tool is simply the right answer.

## Limits

This reads command text; it is not a security boundary. It does not sandbox anything, it cannot see through a program that deletes files internally, and unusual wrapper forms (for example `sudo -u user rm …`) resolve imprecisely on purpose.

## Configuration

- `compoundLimit`: positive integer, default `6`. Maximum separate operations allowed in one bash call.
- `interval`: positive integer, default `50` (retained for backward compatibility).
- `unit`: `steps` or `turns` (retained for backward compatibility).

## State and notices

Pending decisions and grants expire at the next agent turn; state is process-local, per session, and reset on restart. PTC/run_code nested bash calls are intentionally not intercepted: an inner program cannot request a separate model decision.

The notice is available for one following model step. Before later steps its result content is replaced on the supported model surface with neutral text. The original audit transcript remains intact. This does **not** erase the assistant's own prose/reasoning or confirmation call; those cannot safely be stripped by this small plugin. A restart before cleanup can retain an outstanding notice.

Activation is intentionally separate: the adjacent `cordis.patch.yml` inserts only this plugin, with paths relative to the overlay. Load it as an additional DSH overlay, or insert the entry in your selected profile. Do not install the same entry twice.

## Verification

`classifyCommand` is exported so it can be exercised without a running DSH. The rewrite was checked against 40 cases covering the false positives above, the previously-invisible removals, read/list/grep on later lines, here-doc counting, and the `compoundLimit` override. That harness lives in `/tmp` and is deliberately not committed; the owner removed the `tests/` directory earlier and it was not reconstructed.
