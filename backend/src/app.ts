import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import type { Ctx } from './core/context';
import { errorHandler } from './core/http';
import { authenticate } from './auth/middleware';
import { apiRouter } from './routes';

export function createApp(ctx: Ctx) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', authenticate(ctx), apiRouter(ctx));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint', key: 'Unknown API endpoint' } });
  });

  // Serve the built SPA (production / demo mode).
  if (fs.existsSync(path.join(config.frontendDist, 'index.html'))) {
    app.use(express.static(config.frontendDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.frontendDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
