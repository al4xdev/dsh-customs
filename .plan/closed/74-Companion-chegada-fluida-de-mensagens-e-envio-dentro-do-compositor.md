# Companion: fluid message arrival and send button inside composer

## Request after successful physical test
The owner confirmed 'it worked' on the updated Android. Requested: (1) less abrupt message arrival when responses are very fast, with small minimal presentation latency if necessary to complete fluid animations; (2) send button placed inside the message input box to save vertical space. Also inquired about the active model used.

## Scope
- Inspect the current projection/render/autoscroll/220ms entry pipeline and identify remounts/keys or layout jumps causing visual truncation. Do not mask real data loss with animations: confirm transcript integrity and all tokens remain intact.
- Add coalescing/minimal pacing strictly at visual presentation/publication and entry/settlement transitions when needed. Do not delay backend, queue, ACK/cancel/approvals, nor persist/replay submissions. Complete entry animation before abruptly switching states; short and predictable duration, without artificially withholding stop status after actual completion.
- Reduced motion / scale 0 = immediate presentation. Pause/background/navigation / new generation cancels ticker/latency and updates to current ground truth, without history/paging replay or letting older sequences overwrite newer ones.
- Improve follow-bottom: smoothly follow only when user is already near the bottom; respect manual scrolling, historical reading, and text selection. Avoid live-to-durable jumps/remounts that repeat or truncate content.
- Place send icon/button inside composer container with 48dp touch target and 'Send' accessibility description, preserving multiline input, IME, RAM draft, SENDING/UNKNOWN/connection/auth/busy enabled guards, and once-admission. Remove the extra external button row; do not alter auto-send / Enter policies.
- Verify dedicated profile model configuration and report configured value, without claiming historical per-conversation models or switching models without request.

## Validation
Deterministic tests covering fast burst/completion before animation finishes, partial -> durable key transitions, reduced motion, cancellation / new generation, reading/scroll/selection states, composer inner button, 48dp touch target, and disabled / double-tap protection. Build/lint/JVM/Compose tests on emulator with synthetic fixtures. Owner now tests real conversations: do not install/restart/capture private chat without a fresh safe/confirmed condition.

## Acceptance
Rapid messages arrive with smooth, continuous transitions without loss/duplication/replay; composer occupies less height with accessible inner send button; current model reported. No changes to model, backend, sandbox/approvals, or service required for these adjustments.
