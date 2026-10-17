// PRC-1 migration 0024 on an EMPTY database migrated up to 0023 (both projects): a new installation keeps the default
// pricing mode (no pricing.mode row is written), and the used-piece rate kind is accepted. The upgrade of a database
// that holds sales, pieces and rates is proven in migration-upgrade.test.ts (from 0015, 0019 and 0023).

import { beforeAll, describe, expect, it } from 'vitest';
import { one, openAt, run, upTo } from './migration-harness';

describe('migration 0024 (PRC-1) on an empty database', () => {
  beforeAll(() => {
    upTo(23);
  });

  it('writes no pricing.mode (a new installation computes prices) and accepts both rate kinds', async () => {
    const h = await openAt(23);
    try {
      await h.migrate();
      expect(Number((await one(h, `SELECT count(*) AS n FROM settings WHERE key = 'pricing.mode'`)).n)).toBe(0);
      expect(Number((await one(h, `SELECT count(*) AS n FROM settings_history WHERE key = 'pricing.mode'`)).n)).toBe(0);
      await run(h, `INSERT INTO gold_rates (karat, price_per_gram) VALUES (21, 190000); INSERT INTO gold_rates (karat, price_per_gram, kind) VALUES (21, 170000, 'USED')`);
      expect((await run(h, `SELECT kind FROM gold_rates ORDER BY id`)).map((r) => r.kind)).toEqual(['NEW', 'USED']);
      expect(Number((await one(h, `SELECT count(*) AS n FROM permissions WHERE code = 'scrap.buy_sellable'`)).n)).toBe(1);
    } finally {
      await h.close();
    }
  });
});
