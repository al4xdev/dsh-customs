# Anthropic request proxy

Records the exact API request the Claude Code binary sends, so its harness — system
blocks, tool catalog, cache breakpoints, context management — can be read from the
wire instead of inferred from behaviour.

```fish
npm run proxy:anthropic          # listens on 127.0.0.1:8787, dumps to .dumps/anthropic
set -x ANTHROPIC_BASE_URL http://127.0.0.1:8787
claude
```

No MITM, no certificate and no wrapper: the binary honours `ANTHROPIC_BASE_URL`, so it
speaks plain HTTP to this process and this process speaks HTTPS to
`api.anthropic.com`.

## Why it works on a spent plan

The request is assembled and sent before the provider decides anything, so a quota or
auth error upstream still leaves the complete payload on disk. A 429 is a captured
request, not a failed one.

## What it writes

One JSON file per exchange under `.dumps/anthropic/`:

- `request` — the body verbatim;
- `response` — the body verbatim (raw text for streams, capped at 8 MiB);
- `requestHeaders` — with `authorization`, `x-api-key` and cookies replaced by a
  `<redacted sha256:… len:…>` marker, so a dump can be shared without leaking a token;
- `summary` — the geometry: model, `max_tokens`, `thinking`, `output_config`,
  `context_management`, every system block with its size, every tool with its size,
  every message part with its size, and each `cache_control` marker with its path.

`summary` is what answers the questions we actually have. Everything else is there so
the answer can be re-derived later.

## Caveats

- Subscription **OAuth** may refuse a non-official base URL; an **API key** works. Both
  paths still produce a capture when the provider rejects the request.
- `/api/hello`, telemetry and non-inference calls pass through and are recorded too —
  filter by `path` when reading.
- This is an observation tool. It forwards whatever it receives; it does not validate,
  rewrite or replay anything.
