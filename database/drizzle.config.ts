import { defineConfig } from 'drizzle-kit';

// Migrations are generated from both the ERP schema and the (isolated) mock Hasad schema.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', '../integrations/hasad/src/mock/schema.ts'],
  out: './migrations',
  schemaFilter: ['public', 'hasad_mock'],
});
