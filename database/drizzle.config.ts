import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the COMPLETE ERP schema (never a cut-down copy: see scripts/check-migrations.mjs).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts'],
  out: './migrations',
  schemaFilter: ['public'],
});
