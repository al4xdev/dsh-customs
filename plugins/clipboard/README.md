# Clipboard

`clipboard_copy` sends text verbatim through stdin to `wl-copy`, preserving Unicode
and newlines. Empty text invokes `--clear`. Nonempty text uses
`text/plain;charset=utf-8`; clipboard contents are never read back.

## Linux prerequisites and limits

- Requires a Wayland session and `wl-copy` from `wl-clipboard` on the DSH process's
  `PATH`. There is no X11 fallback.
- DSH must have access to the desktop session's runtime directory and display.
  `XDG_RUNTIME_DIR` defaults to `/run/user/<uid>`. Without `WAYLAND_DISPLAY`, the
  plugin selects a single `wayland-*` Unix socket; multiple sockets require an
  explicit `WAYLAND_DISPLAY`. An explicit display is passed through to `wl-copy`.
- SSH, headless services and containers do not automatically inherit a usable
  desktop session. Directory discovery alone does not establish compositor access.
- Success means the `wl-copy` process exited successfully, not that every app has
  read the text or that it will persist indefinitely. `wl-copy` manages its own
  forked clipboard server; the plugin does not request `--foreground`.
- The default timeout is five seconds. Timeout/cancellation stop the direct child,
  but are not rollback: they do not guarantee clearing text already offered or
  stopping a clipboard server that has already forked.

## Safe contract tests

From the repository root:

```sh
node --test plugins/clipboard/clipboard.test.mjs
```

The suite creates a **fake** `wl-copy` under `.dumps/clipboard-test-*`. Each call
receives a `PATH` containing only its fixture directory, an explicit fictitious
display, and a temporary runtime directory. The fake uses an absolute Node
interpreter and never invokes real clipboard programs. Even the missing-executable
case cannot fall back to the user's `PATH`.

Cases cover exact text/arguments, empty text, failure stderr, missing executable,
pre-cancellation, in-flight cancellation and timeout. Discovery tests create local
Unix sockets without running a compositor. Cleanup is limited to verified test
fixture paths; no clipboard contents or user session environment are changed.
These are process/discovery contract tests, not real Wayland integration evidence.
