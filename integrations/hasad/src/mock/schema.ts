// Tables that simulate the Hasad Gold system's own storage.
// They live in a separate Postgres schema (`hasad_mock`) and are ONLY accessed by
// MockHasadService. Removing the mock = dropping this schema.

import { integer, jsonb, pgSchema, serial, smallint, text, timestamp } from 'drizzle-orm/pg-core';

export const hasadMock = pgSchema('hasad_mock');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const mockCustomers = hasadMock.table('customers', {
  id: text('id').primaryKey(),
  fullName: text('full_name').notNull(),
  fullNameAr: text('full_name_ar'),
  phone: text('phone'),
  nationalIdMasked: text('national_id_masked'),
  /** Accumulated gold balance (mg), bought in small "Haba" units. */
  balanceMg: integer('balance_mg').notNull(),
  karat: smallint('karat').notNull().default(21),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const mockWithdrawals = hasadMock.table('withdrawals', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull().references(() => mockCustomers.id),
  weightMg: integer('weight_mg').notNull(),
  karat: smallint('karat').notNull(),
  branchCode: text('branch_code').notNull(),
  status: text('status').notNull(),
  pickupCode: text('pickup_code'),
  requestedAt: ts('requested_at').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  completion: jsonb('completion'),
  cancellation: jsonb('cancellation'),
});

/** Every call the ERP makes to "Hasad" — shown in the integration monitor. */
export const mockApiCalls = hasadMock.table('api_calls', {
  id: serial('id').primaryKey(),
  at: ts('at').notNull().defaultNow(),
  operation: text('operation').notNull(),
  request: jsonb('request'),
  responseStatus: integer('response_status').notNull(),
  response: jsonb('response'),
  durationMs: integer('duration_ms').notNull(),
});
