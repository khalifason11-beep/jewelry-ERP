import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config as defaultConfig, type Config } from './config';
import type { Ctx } from './core/context';
import { errorHandler } from './core/http';
import { csrfProtection } from './core/csrf';
import { log } from './core/logger';
import { authenticate } from './auth/middleware';
import { apiRouter } from './routes';

export function createApp(ctx: Ctx, config: Config = defaultConfig) {
  const app = express();
  // Only trust X-Forwarded-* when a proxy is explicitly configured (H-6, decisions D-1a-9).
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          // React/Recharts set inline style attributes; no inline <style>/<script> is allowed.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.production ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      hsts: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  // Small bodies only (D-1a-13); JSON only — forms and text bodies are never parsed.
  app.use(express.json({ limit: '100kb', strict: true, type: 'application/json' }));
  app.use(cookieParser());

  // Structured access log (no bodies, no cookies, no query strings).
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api')) return;
      log.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n), user: req.actor?.userId });
    });
    next();
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', authenticate(ctx, config), csrfProtection(ctx, config), apiRouter(ctx, config));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint', key: 'Unknown API endpoint' } });
  });

  // Serve the built SPA.
  if (fs.existsSync(path.join(config.frontendDist, 'index.html'))) {
    app.use(express.static(config.frontendDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.frontendDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
