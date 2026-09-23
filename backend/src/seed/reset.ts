import type { Ctx } from '../core/context';
import { resetSyncState } from '../modules/hasad/sync';
import { seedDemo } from './demo';

/** Drop everything and rebuild the demo dataset relative to "now". */
export async function resetDemoData(ctx: Ctx) {
  await ctx.handle.wipe();
  await ctx.handle.migrate();
  ctx.settings.invalidate();
  resetSyncState();
  const result = await seedDemo(ctx);
  ctx.settings.invalidate();
  return result;
}
