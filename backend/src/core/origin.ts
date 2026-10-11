// The app's public origin (CLN-3), for the WebAuthn relying party. A proxy may rewrite Origin and Host: GitHub
// Codespaces' port forwarder delivers `Origin: https://localhost:4001` for a page served from
// `https://<codespace>-4001.app.github.dev`, and reports the real host only in X-Forwarded-Host/-Proto.
//
//   1. APP_ORIGIN set (always in production, which refuses to start without it): that, unchanged.
//   2. Otherwise (demo/dev only), with Express "trust proxy" on (TRUST_PROXY): Express 5's own req.protocol and
//      req.host, which read X-Forwarded-Proto / X-Forwarded-Host only from a trusted hop. Never parsed by hand.
//   3. Otherwise: the Origin header, then http://localhost:<port> (as before). Forwarded headers are never read here.
//
// CSRF does not use this: without APP_ORIGIN its Origin check is off and the token decides (core/csrf.ts), so a
// rewritten Origin does not matter in demo; with APP_ORIGIN the Origin must equal it, exactly as before.

import type { Request } from 'express';
import type { Config } from '../config';

export function publicOrigin(config: Pick<Config, 'appOrigin' | 'trustProxy' | 'port'>, req: Request): string {
  if (config.appOrigin) return config.appOrigin;
  if (config.trustProxy !== false && req.host) {
    try {
      return new URL(`${req.protocol}://${req.host}`).origin;
    } catch {
      /* malformed forwarded host: fall through to the Origin header */
    }
  }
  const header = req.header('origin');
  if (header) {
    try {
      return new URL(header).origin;
    } catch {
      /* keep the default */
    }
  }
  return `http://localhost:${config.port}`;
}
