# Guarded native carrier (opt-in, not deployed)

`guarded-webserver.mjs` replaces the **existing** public `@deepseek-ai/dsh-host-webserver` provider with a subclass. It inherits the native `WebServer.Config` and Cordis `Service.init` lifecycle; it does not create a second listener, daemon, credential owner, RPC adapter or mux implementation. Imports resolve from the installed CLI's public package entrypoints. Select this provider only through the companion composition's explicit opt-in; never replace the default Web composition.

Only public `register`, `registerUpgrade` and `registerFallback` handlers are wrapped. Before native admission, the wrapper applies the exact Host/Origin/Fetch-Site/path policy, then the HTTP/1 request-framing budget. Allowed requests, responses, sockets, upgrade heads and route disposers are delegated unchanged. The actual bound `port` is read at request time, including ephemeral-port fixtures. An available launcher `profileContext` must name `companion`, at construction and on every request.

## Policy and limits

- Public authority: `https://dsh.tail37b3d7.ts.net:8443`; only explicit same-machine HTTP aliases (`127.0.0.1`, `localhost`, bound port) are additionally accepted. No LAN-host broadening.
- Origin is mandatory for every non-GET/HEAD request and every upgrade. Present Origin values match literally; parsed host equality, SameSite cookies and CORS are not substitutes.
- Host/Origin failures remain 403 **before** native cookie authentication. Native authentication still owns no-cookie 401, root token 303 (`Location: ./`), authority-bound signed cookies, RPC and WebSocket negotiation.
- The inherited carrier is Node HTTP/1: declared lengths above 1 MiB are 413; all Transfer-Encoding/chunked requests are unsupported (411), malformed framing is 400. Origin checks retain priority. No body stream is replaced or buffered by the wrapper.
- Keep native Connection's attachment-aware body cap and image limits unchanged. Setting native `maxRequestBodyBytes` to 1 MiB fails its image-envelope-headroom check when attachments exist. The smaller reachable wire budget is enforced by `request-budget.mjs`, not a misleading native configuration.
- This remains text-first client scope. Chunked uploads and larger bodies are an intentional compatibility restriction; real Tailscale/browser/OkHttp framing must be verified before migration. These fixtures do not prove TLS, production forwarding, a phone request, or a deployment.

## Fixtures

Run `npm run test:companion-transport` for all 35 transport/profile tests, or `node --test plugins/companion-transport/guarded-webserver.test.mjs` for the ten native integration fixtures. The installed CLI/public SDK is required for the native fixtures.

The ten integration tests use actual public Cordis, native WebServer/Connection/BrowserAuth/TypertRegistry/Gateway, ephemeral loopback port-zero listeners and a RAM-only `credentials.modifyRecord` capability. No credentials-local, paths service, profile boot, real credentials, model, session API or remote stream items are mounted. Generic native RPC carries only a synthetic fixture result; mux tests negotiate a proper handshake and close. Native image-headroom validation sees fixture limits without performing image/storage operations. All contexts/listeners are disposed.

A generic fixture RPC channel explicitly declares the public `webServer` dependency in its Connection plugin context; native implementations and installed files are not patched. Token/cookie values stay local to fixtures and are never printed.

## Public source contracts

Installed package root: `/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/`.

- `dsh-host-webserver/lib/types/index.d.ts:67–116`: exported class, config, public registrations and lifecycle; `lib/index.js:228–320`: inherited Node HTTP/1 listener/upgrade dispatch/disposal.
- `dsh-client-connection/lib/index.js:205–219`: native Host trust allows absent Origin and compares only parsed Origin host. `586–594, 821–843`: native trust then cookie admission before the HTTP bridge. `791–795`: image-body headroom requirement.
- `dsh-client-connection/lib/index.js:388–442`: unchanged native token redirect, audience and expiry verification; `296–298`: HttpOnly/SameSite cookie attributes.
- `dsh-api-gateway/lib/index.js:626–643`: native mux route admits through Connection before upgrading.
- `dsh-app-boot/lib/types/profile-context.d.ts:26–30`: public launcher profile service.
- Native Web bundle public `cordis.patch.yml:169–177,216–223`: provider entry `webserver` and Connection entry. Opt-in generator changes must retain the original service ID, loopback bind, compression fields, native auth and precise trusted authority.

No active profile, backend listener, frontend fallback, phone or Tailscale mapping is changed by these source files. Removing required frontend proxy 3082 or changing the current Web root needs explicit owner approval plus migration/rollback and authenticated equivalence evidence. Current `8443 → 3082 → 3081` stays intact.

## Migration checklist — not executed

1. First validate principal-profile phone login, catalog, history and reconnect. Do not send a model turn or grant an approval merely to prove transport.
2. Obtain explicit approval for companion provider recomposition and the separate 8443 publication change, including its switch from the React concept root to the native Web fallback. Preserve 443→3080. Verify no active companion turn or pending approval; never take a writer lock or force an agent restart.
3. Prepare `profileFiles(repoRoot, { guardedTransport: true })` as a reviewed local configuration diff, retaining all preset, permissions, session-root and catalog rows. Do not automatically write it into the running profile. Record the original provider configuration for rollback without collecting credentials. Recomposition can restart dependent transports; check cookie/startup-link validity rather than promising continuity. Unknown delivery remains unknown; no retries.
4. In the approved window, activate the provider in the same backend and verify actual Host/Origin/body framing and native authentication. Keep 3082 available until the separately approved route transaction completes. Repoint only 8443 to 3081, then repeat anonymous denial probes and authenticated read-only Kotlin catalog/detail/events/follow/history/reconnect. Verify token303 and cookie audience; do not log tokens or private journal data. Keep the APK's fixed authority unchanged.
5. If any check fails, restore 8443→3082 first and the original provider configuration in the same controlled window. Verify 443→3080 still works. Retire the optional frontend daemon only after all direct-route evidence passes and retirement is authorized. This checklist grants no deployment authorization.
