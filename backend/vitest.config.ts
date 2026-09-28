import { defineConfig } from 'vitest/config';

// Two projects (docs/decisions.md D-2a-6):
//   pglite   — every suite on embedded PGlite (fast, no install)
//   postgres — every suite again on real PostgreSQL, plus test/pg/** (concurrency, privileges).
//              Needs TEST_DATABASE_URL: a role with CREATEDB and CREATEROLE that is NOT a superuser.
// Without TEST_DATABASE_URL the postgres project is left out with a warning; `npm run test:pg`
// (REQUIRE_PG_TESTS=1) fails instead, which is what CI uses.
const pgUrl = process.env.TEST_DATABASE_URL;
if (!pgUrl) {
  if (process.env.REQUIRE_PG_TESTS === '1') throw new Error('REQUIRE_PG_TESTS=1 but TEST_DATABASE_URL is not set');
  console.warn('\n⚠  TEST_DATABASE_URL is not set: the real-PostgreSQL test project is SKIPPED.\n');
}

const shared = { testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false, setupFiles: ['test/setup.ts'] };

export default defineConfig({
  test: {
    ...shared,
    projects: [
      { test: { ...shared, name: 'pglite', include: ['test/**/*.test.ts'], exclude: ['test/pg/**'] } },
      ...(pgUrl
        ? [{ test: { ...shared, name: 'postgres', include: ['test/**/*.test.ts'], exclude: ['test/arithmetic.property.test.ts'], env: { JERP_TEST_DRIVER: 'postgres' } } }]
        : []),
    ],
  },
});
