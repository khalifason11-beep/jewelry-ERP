// Runs in every test file: after the file, every field name any API response carried during it
// must be classified in shared/src/field-classification.ts (docs/decisions.md D-2a-7).
import { afterAll, expect } from 'vitest';
import { secretResponseFields, unclassifiedResponseFields } from '../src/core/cost-redaction';

afterAll(() => {
  expect(unclassifiedResponseFields(), 'unclassified API response fields: add them to shared/src/field-classification.ts').toEqual([]);
  expect(secretResponseFields(), 'SECRET field (hash, key, handle) sent in an API response').toEqual([]);
});
