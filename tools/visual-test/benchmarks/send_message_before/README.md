# Benchmark: Send Message (Before Fix)

- **Scenario**: User creates new chat, types "quais sessoes abertas", hits Send.
- **Device**: Motorola Edge 30 Pro (XT2201-2), 144Hz display, 720x1600 capture at 30fps.
- **Issues Captured**:
  1. `f_030.png` -> `f_035.png` -> `f_045.png`: Composer text clears, re-appears for 300ms, then clears again.
  2. `f_065.png` -> `f_072.png` -> `f_085.png`: User message card is shown, then vanishes. Empty state Maid mascot and "Preparando conversa..." flash for ~250ms, then disappear as message card reappears. DSH avatar leaps up to top and jumps back down.
  3. `f_180.png` -> `f_185.png`: "Atividade · 1 ferramenta" pops in without placement animation, causing DSH avatar to snap ~40dp downwards instantly.
