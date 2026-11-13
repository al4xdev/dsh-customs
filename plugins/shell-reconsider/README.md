# Shell reconsideration

Small optional plugin intercepting the existing native `bash` through `tools/pre-execute`. No DSH core changes, shell wrapper, automatic command execution, or model calls from the plugin.

## How classification works

The command is tokenized before it is judged: quotes, escapes, comments and here-doc bodies are resolved, `$(...)`/backtick payloads and `sh -c` arguments are recursed into, and every rule is applied to a real `argv[0]` instead of a substring of the raw text.

That matters in both directions. An earlier version matched regexes against the whole string, which denied `docker run --rm`, `npm run remove-old`, and any commit message or quoted string containing the letters "rm" — while simultaneously missing `cat` on the second line of a script, `$(rm -rf x)`, `sh -c 'rm …'`, and every removal other than `rm`/`unlink`. A guard that denies obviously-fine commands stops being read as a signal and starts being routed around, which is exactly what happened before this rewrite.

## Interception rules

Only one rule remains, because it is the only one that protects something that cannot be undone:

- **Destructive operations:** denied, recommending the native `trash` tool. Detected anywhere in the command — on later lines, behind `&&`, inside `$(...)`/backticks, inside `sh -c`, inside a here-doc whose reader is a shell, and behind `sudo`/`xargs`/variable assignments. Covered: `rm`, `unlink`, `rmdir`, `shred`, `truncate`, `dd of=`, `find -delete`, `find -exec <removal>`, `git clean` with `-f`/`-d`/`-x`, and `git reset --hard`. When the command also silences failures (`>/dev/null`, `|| true`), the reason says so, because that masks a partial removal.
- **Everything else (`cat`, `ls`, `grep`, `sed`, `awk`, `python3`, `npm`, `git`, compilers, test runners, `docker`, forty-step scripts, …):** passes without friction.

Reading, listing and searching through the shell are no longer denied (Plan 134). They were denied before and the rule was cosmetic: `cat f` was refused while `sed -n 1,80p f`, `awk` and `python3 -c "print(open('f').read())"` all passed, so it removed the honest spelling and kept the obfuscated one; it also denied `cat > script.py <<EOF`, which is a write. The compound ceiling is off by default for the same reason: two bash operations were denied at the default of 6 while a forty-line `python3 - <<EOF` counted as one, so the limit moved the work into Python instead of reducing it. A profile that still wants a ceiling sets a positive `compoundLimit`.

`mv` is deliberately not blocked: the global guidance is to move the target or rename it `.bak` instead of deleting it, so `mv` is the recommended non-destructive path.

Every denial takes the single-use permit: `shell_reconsider({ necessary: true })` grants exactly one retry with the identical **full bash arguments** (including description, workdir and other supplied fields), not just matching command text. The next bash attempt consumes the grant even if its arguments do not match.

## Limits

This reads command text; it is not a security boundary. It does not sandbox anything, it cannot see through a program that deletes files internally, and unusual wrapper forms (for example `sudo -u user rm …`) resolve imprecisely on purpose.

## Configuration

- `compoundLimit`: `0` (the default) for no ceiling, or a positive integer to bound how many separate operations one bash call may carry.
- `interval`: positive integer, default `50` (retained for backward compatibility).
- `unit`: `steps` or `turns` (retained for backward compatibility).

## State and denials

Pending decisions and grants expire at the next agent turn; state is process-local, per session, and reset on restart. PTC/run_code nested bash calls are intentionally not intercepted: an inner program cannot request a separate model decision.

A denial is an ordinary tool result and stays in the transcript exactly as the model received it. It is never rewritten, retracted or re-rendered: replacing a message mid-history makes the provider re-evaluate every token after it, which costs more than the one redirect line the denial carries. The permission state that decides a retry lives in the plugin's own per-session `pending`/`permit` fields, so nothing about the guard depends on editing earlier messages.

Activation is intentionally separate: the adjacent `cordis.patch.yml` inserts only this plugin, with paths relative to the overlay. Load it as an additional DSH overlay, or insert the entry in your selected profile. Do not install the same entry twice.

## Verification

`classifyCommand` is exported so it can be exercised without a running DSH. `shell-reconsider.test.mjs` (run by `npm run test:shell-reconsider`) covers the false positives above, the previously-invisible removals, a removal inside a shell here-doc, the `compoundLimit` override, and the Plan 134 cases: inspection and chaining pass, a here-doc holding data is not counted, and `cat > f <<EOF` is a write.
