# Audit before final Compose refactoring

The owner requested autonomous work to rebuild visuals and chat rendering in Kotlin, leveraging the premium UI patterns of `ha_app` (replaceable palette, gestures/transitions/drag state) and functional parity with DSH frontend/tools including images from `read`. New authorization supersedes previous native motion limitations.

1. Audit `/home/alex/git/my/ha_app` strictly read-only: identify reference screen/components, tokens/palette, typography, gestures, and state machine/reduced-motion. Do not edit/deploy/operate HA or read secrets/cameras.
2. Audit DSH frontend and `dsh-tui` profile via public sources / resolved symlinks: tool/markdown/image renderer and JSON schemas/chunks. Do not execute tools, read credentials/real conversations, or modify current profile/runtime.
3. Audit current protocol/presentation/Compose and produce parity matrix (supported types, safe fallback, bounds, tools/capabilities, lifecycle/gestures) with planned synthetic fixtures.
4. Generate concrete phased refactoring proposal and acceptance criteria with visuals faithful to reference/centralized tokens, avoiding improvised implementation. UI warning from task 63 and stability from task 64 remain preserved prerequisites.
5. Only stage approved implementation plan after this audit; synthetic JVM/Compose/SDK 34/gestures/media validation and final APK. No new phone install/force-stop, send/grant/lock/resume/service/TTL/publication changes, or commit/push. `ha_app` remains a read-only reference.
