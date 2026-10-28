# Benchmark: Open Existing Conversation (Before Fix)

- **Scenario**: User taps an existing conversation from the main list.
- **Device**: Motorola Edge 30 Pro, 720x1600 at 30fps.
- **Issues Captured**:
  1. `f_035.png` to `f_055.png` (~700ms duration):
     - Banner "Conexão interrompida | Reconectar" flashes immediately at the top because `connected` is false before socket handshake finishes.
     - Center of the screen flashes the full-screen Maid mascot holding a cat (`MockFrameStage`) because `hasTranscript` is false while the session is loading.
     - "Carregar mensagens anteriores" button flashes and shifts.
  2. `f_065.png`:
     - Banner and mascot vanish abruptly, and the message content slams into view without any smooth cross-fade or skeleton transition.
