// Runs in every test file: after the file, every field name any API response carried during it
// must be classified in shared/src/field-classification.ts (docs/decisions.md D-2a-7), and (UX-3) every route that
// asked for a re-authentication must declare it in the route matrix.
import { afterAll, expect } from 'vitest';
import { secretResponseFields, unclassifiedResponseFields } from '../src/core/cost-redaction';
import { undeclaredReauthRoutes } from '../src/core/http';

afterAll(() => {
  expect(unclassifiedResponseFields(), 'unclassified API response fields: add them to shared/src/field-classification.ts').toEqual([]);
  expect(secretResponseFields(), 'SECRET field (hash, key, handle) sent in an API response').toEqual([]);
  // UX-3: every route that answered REAUTH_REQUIRED during the file declares it (reauth or reauthWhen in the matrix).
  expect(undeclaredReauthRoutes(), 'a route asked for re-authentication without declaring it in shared/src/route-matrix.ts').toEqual([]);
});
