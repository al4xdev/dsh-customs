import { GuardedWebServer } from '../companion-transport/guarded-webserver.mjs';
import { redactedCarrierLogger } from './redacted-logger.mjs';

export const name = 'companion-download-redacted-webserver';

/** Context.logger is a builtin property, NOT an isolated provided service.
 * Public extend(metadata) shadows it only for this existing Companion carrier.
 * No HTTP/request/socket implementation or SDK-private field is replaced.
 */
export default class DownloadRedactedWebServer extends GuardedWebServer {
  constructor(ctx, config) {
    const scoped = ctx.intercept('logger', { level: 3 });
    super(scoped.extend({ logger: redactedCarrierLogger(scoped.logger) }), config);
  }
}
