import { config } from '../config';
import type { Ctx } from '../core/context';
import { seedDemo } from './demo';

/** Drop everything and rebuild the demo dataset relative to "now". */
export async function resetDemoData(ctx: Ctx) {
  // Defence in depth: the route and CLI are demo-only too, but the wipe itself must never run in production.
  if (config.appMode !== 'demo') throw new Error('Demo reset is disabled outside APP_MODE=demo');
  await ctx.handle.wipe();
  await ctx.handle.migrate();
  ctx.settings.invalidate();
  const result = await seedDemo(ctx);
  ctx.settings.invalidate();
  return result;
}
