import { STATUS_CODES } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_ORIGIN, classifyRequest } from './origin-policy.mjs';
import { classifyRequestBudget } from './request-budget.mjs';
import { DSH_CLI_PACKAGE } from '../session/host-paths.mjs';

const sdk = createRequire(DSH_CLI_PACKAGE);
const { WebServer: NativeWebServer } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-host-webserver')).href);

export { NativeWebServer };
export const name = 'companion-guarded-webserver';

function foreignProfile(ctx) {
  const profile = ctx.get('profileContext');
  return profile !== undefined && profile?.name !== 'companion';
}

function rejectHttp(res, rejection) {
  const body = rejection.code;
  res.writeHead(rejection.status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function rejectUpgrade(socket, rejection) {
  const body = rejection.code;
  const reason = STATUS_CODES[rejection.status];
  socket.end(`HTTP/1.1 ${rejection.status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** Native provider replacement, not an additional listener or authentication owner. */
export class GuardedWebServer extends NativeWebServer {
  constructor(ctx, config) {
    if (foreignProfile(ctx)) throw new Error('companion-profile-required');
    super(ctx, config);
  }

  rejection(req, upgrade = false) {
    if (foreignProfile(this.ctx)) return { status: 403, code: 'profile_mismatch' };
    // Resolve the bound port at request time: configured port zero is not an origin.
    return classifyRequest(req, {
      publicOrigin: PUBLIC_ORIGIN,
      localOrigins: [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`],
      upgrade,
    }) ?? classifyRequestBudget(req);
  }

  register(route) {
    const provider = this;
    return super.register({ ...route, handler(req, res) {
      const rejection = provider.rejection(req);
      if (rejection) return rejectHttp(res, rejection);
      return route.handler(req, res);
    } });
  }

  registerUpgrade(route) {
    const provider = this;
    return super.registerUpgrade({ ...route, handler(req, socket, head) {
      const rejection = provider.rejection(req, true);
      if (rejection) return rejectUpgrade(socket, rejection);
      return route.handler(req, socket, head);
    } });
  }

  registerFallback(handler) {
    const provider = this;
    return super.registerFallback((req, res) => {
      const rejection = provider.rejection(req);
      if (rejection) return rejectHttp(res, rejection);
      return handler(req, res);
    });
  }
}

export default GuardedWebServer;
