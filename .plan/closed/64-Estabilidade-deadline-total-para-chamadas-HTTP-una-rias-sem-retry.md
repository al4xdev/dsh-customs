# Companion unary call deadline

Requested scope: stability only; UI/refactoring belongs to the owner. Source `OwnerHttpPolicy` configures connect/read/write timeouts, but lacks an overall deadline. A server/network delivering bytes slowly could keep RPC/login and busy/preflight states active indefinitely, as readTimeout resets on each byte progress.

1. Add an overall 45s deadline per unary HTTP call (login and RPC), separate from the long-lived websocket client. Do not alter authority/TLS/auth/cookie/Origin/ping, body limits, POST retry, ACK/UNKNOWN/ledger, or send policy.
2. Local `MockWebServer` fixture with slow response to prove total termination and exactly one POST, without secrets, models, or real network traffic. Configuration fixture to prove stream client remains without a global deadline; test invalid values in the test seam.
3. Run app/protocol/lint/build regressions; record results. Changes restricted to net and tests, no UI alterations. UI adjustment already prepared in task 63 remains separate and will not be installed.
4. Do not update phone, force-stop app with uncertain intents, restart service/PC, alter TTL/profile/Tailscale, or deploy guard without specific authorization. POST timeout signifies a possibly unknown result, never automatic retry.

Acceptance: unary calls with finite overall deadline, long-lived WSS intact, tests without replay pass, and no real resources altered.
