# Mobile companion premium — animations and gestures

Complement to approved task 40 r1, per direct user request. Use updated active goal to guide implementation/verification. Project remains an independent frontend, fixed companion profile, official renderer and policies intact.

## Experience
- Cohesive and understated iOS-style motion language: list <-> chat transition with depth/parallax and spring; buttons/status/loading with brief feedback, without ornamental bounce on every component.
- Horizontal navigation gesture with finger-tracked progress and distance/velocity decision; back from conversation to list, and forward/reopen previously validated conversation when context exists. Do not trigger message dispatch or backend operations via gesture, nor navigation to foreign logs. Revalidate header before retain.
- Edge elasticity on conversation/list scrollport where applicable. Preserve native browser scrolling and iOS physics; small/bounded emulated fallback that does not duplicate native effects. Never intercept horizontal scrolling of code/tables, selection, inputs, controls, dialogs, or confirmations; no global prevention of all touchmove.
- On send, animate message presentation rising from composer into its real transcript position, tracking conversation scroll upward. Visual replica contains no credentials and does not interfere with actual message; do not fabricate a send prior to native admission or resend. Cancel effect if submit fails / does not result in message. Do not block input/reconciliation/scroll to sustain effect.
- Received response: brief entrance once per new message; streaming remains incremental in renderer, without re-animating each token, each reload, or entire historical transcript. Scroll preserves user reading above.

## Delegated implementation
- Delegate screen motion / gestures / elasticity to one subagent and message movement / composer-transcript integration to another, with separate files and shared contract; parent agent integrates and audits.
- Use public APIs of services / DOM data attributes and presentation observation without modifying parser/engine. If additional upstream adaptation is needed, keep exact/pinned/fail-closed and document; do not edit installed runtime or TUI.
- WAAPI / CSS transforms + opacity where possible; requestAnimationFrame only for active gesture, cleanup of observers/listeners/animations on switch/unmount. Avoid per-frame layout, measure only necessary points, no heavy dependencies or infinite loops.
- Respect prefers-reduced-motion: minimal/non-displacing transitions, gestures navigate without elastic effect, message animation disabled. No new configuration required.
- Accessibility, targets >= 44px, keyboard / visualViewport / safe-area, focus/contrast, and native approval remain top priority. Vertical touch / native scrolling and selection/copy must not regress.

## Verification
- Deterministic tests of thresholds / velocity / axis-lock / cancellation, excluded targets rules, reduced-motion, cleanup, message admitted strictly once / error / streaming without repeated animation, foreign guard.
- Maintained browser 393x852 / DPR 2 / touch: demonstrate list <-> chat, gesture commit/cancel, edge scroll, real send/receive, and history without replay of effects. Verify console/network/overflow and scroll stability. Synthetic data only.
- Short video capture / frame inspection if maintained tool allows; isolated screenshots do not prove fluidity. Do not install browser/dependencies to bypass disabled capabilities. Do not claim physical Android/iOS physics/keyboard without physical device test.
- Integrate with task 40: build/test, auth/profile/confirm-reject/allow-once, publication only after removing audit auth seam, preserve 443/3080/TUI and 8443 rollback.

## Conclusion
Premium motion implemented and observed in real app with synthetic data, without altering security/renderer or breaking touch/scroll/accessibility. Record emulation limits and measured results; objective complete only after validation and full frontend integration.
