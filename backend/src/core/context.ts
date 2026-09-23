import type { DatabaseHandle, DB } from '@jerp/database';
import type { HasadService, MockHasadService } from '@jerp/hasad';
import type { Permission } from '@jerp/shared';
import type { SettingsStore } from '../modules/settings/store';

/** The authenticated user performing an operation. Passed into every service call. */
export interface Actor {
  userId: number;
  username: string;
  fullName: string;
  roleCode: string;
  roleName: string;
  roleRank: number;
  branchId: number | null;
  branchCode: string | null;
  branchName: string | null;
  permissions: Set<Permission>;
  sessionId: string | null;
  ip?: string;
}

/** Application services container. */
export interface Ctx {
  handle: DatabaseHandle;
  db: DB;
  hasad: HasadService;
  /** Present only while the mock is in use (enables the demo simulator). */
  mockHasad: MockHasadService | null;
  settings: SettingsStore;
}
