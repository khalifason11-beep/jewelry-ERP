import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the ERP schema and the deprecated mock Hasad schema (kept until REM-5).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', './src/deprecated-hasad-mock-schema.ts'],
  out: './migrations',
  schemaFilter: ['public', 'hasad_mock'],
});
