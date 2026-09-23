// The single place where the Hasad Gold implementation is chosen.
// To go live: implement `HasadService` over HTTP and return it here instead of the mock.

import type { DB } from '@jerp/database';
import { MockHasadService, type HasadService } from '@jerp/hasad';
import type { SettingsStore } from './modules/settings/store';

export function createHasadIntegration(db: DB, settings: SettingsStore): { hasad: HasadService; mock: MockHasadService | null } {
  const mock = new MockHasadService(db, {
    behaviour: async () => {
      const s = await settings.get();
      return { latencyMs: s.mockHasad.latencyMs, simulateOutage: s.mockHasad.simulateOutage };
    },
  });
  return { hasad: mock, mock };
}
