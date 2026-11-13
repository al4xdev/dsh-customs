# Plan 134 — Open the shell policy: style out, irreversibility stays

## Decision

The owner wants the policy opened, not tuned: stop holding back `list`/`grep`/`cat`,
let the model do the whole job in one call, and let it chain whatever it wants in bash.
Newer models are trained to work that way, and the reference session
(`7ecc11bb-6b27-4814-ad39-122c12ef96a7`, dw2003recomp) is evidence it works.

This revision replaces the "raise the limit and soften the denials" version with
"remove the style rules, keep the safety rule".

## Why this is the coherent choice

The compound limit protects nothing that the safety rule protects. Destructive
detection runs per command, not per count: `rm -rf x` inside a 40-operation chain is
caught exactly like `rm -rf x` alone (verified against the classifier). What the limit
buys is transcript legibility — and it buys it by costing a round trip per refusal.

The style denials for `cat`/`ls`/`grep` are worse than useless as written: `cat x.c` is
denied, while `sed -n 1,80p x.c`, `awk`, and `python3 -c "print(open('x.c').read())"`
all pass. A rule that only catches the honest spelling does not shape behaviour, it
rationally teaches an alternative spelling. Half-open is the worst of the three states;
the choice is closed or open, and open is the right one.

Measured cost of opening, from the owner's own recent DSH work (400 sessions, 35 410
bash calls, 879 denials = 2.5%, median 1 per session, p90 10): small in ordinary
sessions, structural in exploration-heavy ones — the reference session would see 97 of
its 132 calls refused. That asymmetry is what the change targets.

## The one prerequisite

A destructive command hidden inside a shell here-doc is **already invisible today**:

| command | today | after opening |
| --- | --- | --- |
| `rm -rf /tmp/x` | denied | denied |
| `sh -c 'rm -rf /tmp/x'` | denied (payload recursed) | denied |
| `bash <<'EOF' … rm -rf /tmp/x … EOF` | **allowed** | allowed |

The body of a shell here-doc is stripped and only its line count is used, so the
removal never reaches `detectDestructive`; today an accidental catch exists only when
the body is long enough to trip the compound limit. Removing that limit removes the
accident.

So the same commit must make the classifier treat a shell here-doc body the way it
already treats `sh -c`: recursion into `scan(body, depth + 1)`. Then the limit can go
without losing anything.

## Changes

### A. `plugins/shell-reconsider/index.mjs`

1. **Remove the style denials.** `READ_OPS`, `LIST_OPS`, `GREP_OPS` and their three
   deny branches go; so does the `tool:read`-style redirect text from the reasons.
2. **Compound limit off by default.** `DEFAULT_COMPOUND_LIMIT` becomes `0` =
   disabled; config validation accepts `0` (and a positive integer to re-enable per
   profile). The counting code and the `compound` verdict stay, so a profile that wants
   the ceiling back only sets a number.
3. **Scan shell here-doc bodies for destructive commands** (the prerequisite above).
   `stripHereDocs` returns the bodies alongside the stripped script; a body whose
   reader is a shell recurses into `scan`, mirroring `sh -c`.
4. **Fix the write-through-heredoc false positive** while in there: `cat > f <<EOF` is
   a write, never a removal or a read.
5. **Keep, unchanged:** the destructive set (`rm`, `unlink`, `rmdir`, `shred`,
   `truncate`), `dd of=`, `find -delete`, `find -exec` of a removal, `git clean -f/-d/-x`,
   `git reset --hard`, the masking note, the single-use permit through
   `shell_reconsider`, `mv` deliberately unblocked, the schema-stability contract, and
   the "a denial is never rewritten in history" contract.
6. **Call it what it is.** `shell_reconsider`'s description and the destructive reason
   stop mentioning compound commands; the tool becomes purely "is permanent deletion
   really required".

### B. Prose — replace the deny with the rule that actually matters

7. `tools/prompt-audit/baseline/*.txt` and the two SDK packages
   (`@deepseek-ai/dsh-tool-fs` and `@deepseek-ai/dsh-tool-fs-search`, both
   0.2.0-rc.2) still say "Use the read tool — not shell commands like cat", "not shell
   ls or find", "not shell grep or rg". Opening the guard while the system prompt keeps
   saying that is the worst combination, so this moves from optional (old D3) to
   required: a new hash-guarded patch target in `tools/clean-install/` (same shape as
   `agent-instructions.mjs`: refuse an unknown build, verify the post-hash, applied by
   `host.mjs`). Target wording: native tools for the plain case, no framing of shell as
   forbidden.
8. `plugins/list/index.mjs:90` — same softening, this one is ours to edit.
9. **New rule, in the bash guidance and in the owner's AGENTS.md proposal:** chain with
   `&&` or `set -e`, not `;`, when a call carries several steps, so a failure in the
   middle aborts the chain instead of scrolling past; `[exit code: N]` only reports the
   last command. This is what makes a one-shot call auditable rather than silent. This
   rule does the job the compound limit was trying to do, without a round trip.
10. `~/.dsh/AGENTS.md` stays the owner's to apply: `proposal only`. Drop "Give each call
    one operation" for read-only work; keep "anything destructive gets its own call and
    its own approval" verbatim; allow Python where it is not JSON filtering; keep
    "source edits go through `edit`/`apply_patch`, not a script" — shell writes bypass
    the file-observation policy, and that is a real cost even when it is allowed.

### C. Measurement

11. `tools/shell-policy/replay.mjs` + `npm run shell:replay`: replays a Claude Code
    transcript (`.jsonl`) or a DSH session (`session.v4.jsonl.zstd`) through
    `classifyCommand` and prints verdicts by type plus the op-count histogram. The
    policy stops being an opinion; nothing private is committed.

## Acceptance criteria

1. `npm run test:shell-reconsider` and `npm run test:lts:contracts` pass, with new
   `classifyCommand` cases: every destructive form denied standalone, in a `&&` chain,
   in `$(…)`, in `sh -c`, and now inside a shell here-doc; `cat > f <<EOF` allowed;
   `cat`/`ls`/`grep` allowed; a 40-operation chain allowed; `compoundLimit: 3`
   re-enables the ceiling and still denies.
2. Replay of session `7ecc11bb`: **0 of 132 calls denied** (from 97).
3. Replay of the 400-session sample: every `rm`/`rmdir`/`shred`/`truncate`/`dd of=`/
   `find -delete`/`git clean`/`git reset --hard` command still denied — **and count how
   many were previously hidden inside a here-doc**, so the new detection is proved on
   real data, not only on fixtures.
4. `npm run prompt:audit` after the SDK patch and profile change; no denylist hit; the
   baseline diff reviewed line by line and accepted **only with the owner's explicit
   yes**, committed with the change.

## Risks

- **Legibility.** A 40-step call reads worse afterwards. Accepted by the owner's
  decision; mitigated by the `&&`/`set -e` rule and by `edit`/`apply_patch` staying the
  way source files change.
- **Classifier regressions** are irreversible when they hit the destructive path. The
  here-doc recursion is new code in that path: it gets its own fixtures plus criterion 3
  on real transcripts.
- **SDK patch upkeep** on every upgrade (hash re-review), same as
  `agent-instructions.mjs` already carries.

## Out of scope

- Allowing shell writes to tracked files (no permit): they bypass the
  file-observation policy, and that is a separate decision.
- Changes to the audit denylist, the tool catalog, or subagent policy.
