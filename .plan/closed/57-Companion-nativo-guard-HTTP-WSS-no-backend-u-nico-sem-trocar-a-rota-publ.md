# Companion transport guard on existing backend

## Objective and evidence
Continue active goal and task 49: Kotlin/API 34 APK has already been delivered, validated with 82 JVM tests, read-only real transport, and five Compose emulator tests. Owner authorized installation/launch exclusively under Alex/user0 profile; Work/user10 remains without the package. Current publication remains 8443 -> 3082 -> 3081, 443 -> 3080 intact.

Public audit and 20 anonymous probes reveal a discrepancy: native `connection.admit` permits missing Origin and compares only the Origin host. The current proxy enforces exact serialized Origin on POST/WSS. Do not remove the proxy by weakening this protection.

## Execution scope
1. Confirm public composition and id/configuration of provider `dsh-host-webserver`. Create dedicated provider derived from publicly exported WebServer class, within the SAME backend process. Wrappers only for `register`, `registerUpgrade`, and `registerFallback`, prior to native handlers; do not access private fields, monkeypatch runtime objects, edit installed modules, or implement custom authentication/multiplexing.
2. Implement pure and constrained Host/Origin/path/Fetch-Metadata policy matching existing perimeter. Fixed public host with port 8443; exact HTTPS Origin; mandatory Origin on methods other than GET/HEAD and on all upgrades; reject cross-site, invalid paths, and ambiguous values. Preserve native routing and authority. Do not broaden hosts/ports or use trust-all. Verify native body size limit before deciding whether any adjustment is needed.
3. Test this policy using fixtures and an isolated native server on loopback/ephemeral port, without real credentials, models, real sessions, or published processes. Cover HTTP/WSS and fallback/GET bootstrap, missing or malformed Origin, scheme/port/credentials/path, 403 priority before 401, disposer, and lifecycle. Prove the provider delegates to native handlers, authorization, and multiplexer rather than an alternative protocol.
4. Prepare profile generation/configuration as an explicit opt-in, disabled by default, preserving existing preset/permission/model/catalog/API. Do not alter active profile, listeners, services, PrivateLink, or Tailscale during this task. Do not install another APK, read phone screenshot/logs, or automate login/approvals on the phone.
5. Document migration and rollback: provider installation only during proven idle window, account for restarting dependents and invalidating cookies/tokens/streams. Direct publication 8443 -> 3081 and shutting down 3082 remain deferred for specific review/authorization and fresh real/Kotlin authenticated proof, without affecting 443/3080. If the public seam does not permit equivalence, record the limitation; never bypass with internals.

## Acceptance
Policy and provider tested in isolated fixtures, no secrets or alternate authentication, no active route/process/profile modified. Evidence of public composition path and migration plan with checks/rollback. This approval does not authorize switching published routes or disabling the frontend. No commit/push.
