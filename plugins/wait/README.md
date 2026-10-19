# Wait Plugin (`alex-wait`)

A native, cancellation-aware pause and synchronization tool for DSH agents.

## Why this tool exists

In autonomous agent workflows, models often need to wait for asynchronous external events:
- A local dev server (e.g. Vite, Next.js, FastAPI, Docker) spinning up and binding to a port.
- A build watcher or compiler emitting output bundles.
- External webhook, database migration, or hardware/device state transitions.
- Debounce intervals or controlled rate pacing.

### The anti-patterns it solves

Without a native `wait` tool, LLMs fall into destructive patterns:
1. **`bash -c "sleep N"`**:
   Spawns an unnecessary shell subprocess, pollutes command history, risks tripping sandbox or security reconsiderations, and freezes the terminal output without visual progress.
2. **Busy-polling across turns**:
   The model issues rapid `curl` or `read` calls across dozens of turns, burning hundreds of thousands of tokens, flooding session logs, and frequently provoking the user to hit interrupt (`Interrupted · What should DeepSeek do instead?`).
3. **Shell while-loops**:
   Spawning scripts like `while ! nc -z ...; do sleep 1; done` that hang invisibly until killed.

---

## Tool Specification

- **Tool Name**: `wait`
- **Profiles**: Enabled across all profiles (`web`, `headless`, `tui`, `dsh-tui`, `companion`).
- **Parameters**:
  - `seconds` (`number`, optional): Duration to wait in seconds (e.g. `2.5`, `15`, `300`). Defaults to `1`.
  - `minutes` (`number`, optional): Alternative duration in minutes (e.g. `5`, `30`). Converted automatically.
  - `hours` (`number`, optional): Alternative duration in hours (e.g. `1`, `8`). Up to `24` hours.
  - `reason` (`string`, optional): Human-readable explanation of why the wait is occurring (e.g. `"Waiting for Vite server on port 5173"`).
- **Execution bounds**:
  - Minimum: `0.01s` (10ms)
  - Maximum: `86400s` (24 hours)
- **Output**: Clean confirmation string:
  - `Waited 5s (Waiting for Vite server on port 5173).`
  - `Waited 300s (~5m) (Waiting for database schema migration).`
- **Cancellation**:
  - Directly bound to the turn's `AbortSignal` (`exec.signal`).
  - If the user presses `Esc` or `Ctrl+C`, the timer is immediately cleared and the call is rejected with the abort reason without leaving hanging timers or orphan processes.

---

## Guide for Large Models: Future DSH TUI Visual Integration

> **ATTENTION (FOR LARGER MODELS / FUTURE ARCHITECTURAL IMPLEMENTATION)**:  
> When tasked with integrating this tool into the DSH TUI (`packages/tui` / Ink React terminal interface), read this section carefully before editing UI components. The TUI is highly sensitive to layout jitter, re-render thrashing, and terminal cursor desynchronization.

### 1. The UX Objective
When the model invokes `wait`:
- **Do not** display a generic spinner that looks identical to a hung command.
- **Do not** clear or overwrite historical terminal output.
- **Do**:
  1. Render a dedicated countdown indicator: e.g. `⏳ Waiting: 3.4s / 5.0s remaining...` (or a compact progress bar `[████░░░░░░] 40%`).
  2. Display the `reason` field prominently in the active activity line (e.g., `Reason: Waiting for Vite server on port 5173`).
  3. When completed, collapse cleanly into the standard completed tool card: `✔ wait 5s (Waiting for Vite server on port 5173)`.

### 2. Ink / React Architecture in DSH TUI
The TUI is implemented in React with Ink (`react-ink`). Ink transforms JSX nodes into ANSI escape sequences printed to `stdout`.

Key architectural principles when touching TUI code:
- **TUI state is delicate**:
  Uncontrolled re-renders at high frequency (e.g., 60fps or 10ms intervals) will overwhelm the terminal emulator, trigger screen flickering, and cause cursor jump bugs.
- **Throttled tick rate**:
  Any countdown hook or component must throttle UI updates to at most **4 Hz to 10 Hz** (every 100ms to 250ms), or 1 Hz (once per second) for durations longer than 10 seconds.
- **Strict cleanup on unmount**:
  Always clear timers (`clearInterval`, `clearTimeout`) in `useEffect` cleanup return functions. If an agent run is interrupted or cancelled, unmounting an active countdown component must never attempt state updates on unmounted Ink components.

### 3. Handling User Interruption (Esc / Ctrl+C)
- When the user interrupts via `Esc` or `Ctrl+C`, the DSH runtime aborts `exec.signal`.
- The `wait` tool immediately stops and rejects.
- The TUI component must catch the abort state gracefully:
  - Transition immediately to an `Interrupted` or `Cancelled` badge.
  - Display the time elapsed before cancellation (e.g., `Cancelled after 2.1s of 10.0s`).
  - Clean up all intervals without throwing React state warnings.

### 4. Component Placement Checklist
When implementing the visual component in the TUI:
1. Locate the tool execution renderer component (typically where `bash`, `read`, and `browser` tool calls render active spinners).
2. Check if `exec.name === 'wait'`.
3. Read `exec.arguments.seconds` (or normalized seconds) and `exec.arguments.reason`.
4. Render a specialized `WaitActivityView` component containing:
   - Remaining time countdown.
   - Total expected time.
   - Descriptive reason tag.
5. Ensure fallbacks exist when `reason` is omitted or empty.
6. Verify terminal width constraints (`stdout.columns`): if width is under 60 columns, truncate or wrap the reason gracefully without breaking Ink flex layout.
