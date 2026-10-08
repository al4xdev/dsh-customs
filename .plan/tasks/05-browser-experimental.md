# Plan 5 — Browser integration (experimental)

## Status

Experimental; revisit with the owner. Not included in the implementation authorization for Plans 1–4.

## Direction

Investigate DSH's native skill/plugin integration for existing browser MCP servers, especially the official Playwright MCP. Prefer native exposure of existing tools over custom wrappers or a new browser implementation. Keep a short skill for usage guidance when useful.

## Questions to revisit

- How does DSH promote MCP tools into native skills/tools?
- Is a separate controlled browser sufficient, or is access to the owner's logged-in Chrome needed?
- Which existing plugin provides concise page observation, interaction, screenshots, console and failed-request inspection?
- Can the agent inspect screenshot artifacts directly and retain a browser session across calls?
- How are browser-session boundaries and sensitive actions communicated?

## Future evaluation

Choose one existing integration and test navigation, click, screenshot and console inspection. Adapt only demonstrated friction. Do not duplicate MCP functionality or implement this plan before renewed discussion.
