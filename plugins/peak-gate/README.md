# Peak Gate (`alex-peak-gate`)

Holds LLM requests instead of paying DeepSeek's peak price for them.

## Why

DeepSeek publishes two prices for the same model
([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)):

> *"Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
> 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.
> All other hours are off-peak, including weekends and Chinese public holidays
> in full."*

So the same `deepseek-flash` tokens cost `$0.30`/M input and `$1.20`/M output
during peak, and `$0.15`/`$0.60` off-peak. An unattended agent run that starts
ten minutes before a window opens pays double for its whole duration. This
plugin makes the clock — not the model's judgement — decide.

## How

`apply` registers one `llm/stream` waterfall. For a request whose `provider` is
in `providers`, it computes the gate from `plugins/wait/schedule.mjs` and:

- **outside a gated interval** → dispatches untouched, synchronously;
- **inside one, `mode: wait`** → returns a generator whose first `await` holds
  until the window closes, then dispatches. Nothing is yielded before release,
  so the agent loop's attempt (and first-token clock) only starts afterwards.
  The in-flight request is never interrupted: the *next* one waits.
- **inside one, `mode: refuse`, or the wait exceeds `maxWaitMs`** → throws
  `LlmError(..., 'PEAK_HOURS')`, naming the resume clock time. A hold of up to
  4h20m is only a valid trade when you actually want to leave the session parked.

The hold sleeps in `waitSliceMs` slices and recomputes the window on every
wake, so a clock jump, time-zone change or profile reload can never strand a
request past its window. `options.signal` (interrupt / `Ctrl+C`) rejects the
wait immediately.

`DSH_PEAK_GATE=off` in the environment bypasses the gate — the escape hatch for
a deliberate off-peak batch, without editing a profile.

## Configuration

Every field is optional; the defaults already match the published schedule.

```yaml
- id: alex-peak-gate
  name: ../../../git/my/dsh-customs/plugins/peak-gate/index.mjs
  config:
    providers: [deepseek-official]   # only routes with peak pricing
    mode: wait                       # wait | refuse
    maxWaitMs: 18000000              # 5h: widest window (4h) plus both margins
    waitSliceMs: 60000               # recompute at least once a minute
    timeZone: America/Sao_Paulo      # display only; windows are UTC
    peakWindowsUtc: [[1, 4], [6, 10]]
    weekdaysOnly: true
    holidays: []                     # 'YYYY-MM-DD' Beijing dates
    preMarginMs: 600000              # gate opens 10 min before peak
    postMarginMs: 600000             # gate closes 10 min after peak
```

In `America/Sao_Paulo` (UTC-3) the shipped windows land on **22:00-01:00**
(Sunday to Thursday nights, from the Mon-Fri UTC windows) and **03:00-07:00**
(Monday to Friday), with the 10-minute margins applied on both edges.

## Known gaps

- **Chinese holidays are data, not an API.** `holidays` accepts Beijing-local
  `YYYY-MM-DD` dates. While it is empty the gate over-triggers on a real
  holiday: you wait needlessly, you never overpay. Fill it when the next
  calendar is published.
- **Billing boundary is undocumented.** If a request starts just before a window
  opens and finishes inside it, which price applies is the provider's call; the
  pre-margin exists to keep long runs from straddling that edge.
- **A long hold is silent.** Nothing renders a countdown for a middleware hold.
  For a visible, reasoned pause, the `wait` tool now accepts
  `untilOffPeak: true` (same schedule module), which shows up as a normal tool
  card.
- **Companion profile does not load it.** Scheduled holds there would park the
  companion service.

## Per-profile behavior

`activation.json` gives one config per plugin, so a profile that wants a
different trade-off overrides the row by id — the same wholesale-config
override the owner profiles already use for `agent-default-model`:

```yaml
# Interactive profiles: never park a turn for hours; refuse with the resume time
# when more than 15 minutes are left, hold when it is a margin or a window edge.
- id: alex-peak-gate
  config:
    mode: refuse
    maxWaitMs: 900000
    timeZone: America/Sao_Paulo
```

Headless keeps the shipped default (`mode: wait`, `maxWaitMs: 5h`), which fits
the widest gated interval and lets an unattended run sleep through it.

## Tests

```sh
npm run test:peak-gate   # gate logic + llm/stream wiring (needs the DSH install)
npm run test:wait        # schedule module + the wait tool, host-free
npm run peak:plan        # what is gated now and the next intervals, in local time
```

`peak:plan` reads the same schedule module the middleware uses, so it is the
quickest way to confirm tonight's boundaries on this machine:

```
now 2026-10-19 20:35 America/Sao_Paulo — open
2026-10-19 21:50 → 2026-10-20 01:10  (3h20m, window 01:00-04:00 UTC, peak 22:00-01:00 local)
2026-10-20 02:50 → 2026-10-20 07:10  (4h20m, window 06:00-10:00 UTC, peak 03:00-07:00 local)
```

Flags: `--days N`, `--limit N`, `--tz Region/City`, `--json`.
