# Grammar-fix: Pi Fidelity and Robust Correction

## Objective
Fix intermittent grammar-fix failures and reproduce the experience of https://github.com/al4xdev/pi-grammar-fix, without changes to the harness core or loss of existing modifications.

## Observed Investigation
- The local frontend already has Ctrl+G integration in the composer and Launchpad, but only one pen, seven positions, and four phrases; Pi has five themes, eight positions, 14 phrases, randomized icons, and language/model context.
- The bridge uses separate streaming, token limit, and deadline, but needs regressions for abort, busy, effort, transient errors, and incomplete termination. Confirm real LLM contracts before tuning.
- There are pre-existing modifications in both repositories; preserve and modify only related sections.

## Implementation
1. Audit streaming contract and local evidence of failures; fix reproducible causes. Ensure effective cancellation/deadline, busy release, clear errors, no partial application, and retries limited strictly to recoverable failures.
2. Port the five emoji themes, 14 original phrases, and 150 ms pacing from Pi into an activity component; display selected language/model and success/no-change messages with icons. Preserve terminal theme, undo, draft/session guards, and shortcuts.
3. Pass metadata through the bridge to keep visual context correct when the model is configured. Adjust installer/documentation without manually editing lib artifacts.
4. Add deterministic tests for bridge, animation, and integration; compile frontend and run focused regressions / relevant CI. Document limitations of real provider validation.

## Visual Direction
Do not create new palette or typography: reuse semantic tokens and monospace from TUI. Signature faithful to Pi: emoji trail that wipes errors and returns, followed by `(language · model)` context and `💬` phrase. Compact two-line hierarchy, clipping for narrow terminals, and reduced motion option where supported.

## Acceptance Criteria
- Five Pi themes and phrases available in both editors.
- Canceling preserves draft, does not lock busy, and subsequent correction works.
- Failures/incompleteness do not overwrite draft; incompatible effort has controlled fallback.
- Tests and build pass or external/pre-existing failures are explicitly reported.
- Do not commit/push; close this plan and conclude the goal only after verifying results.
