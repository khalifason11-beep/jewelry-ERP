// npm run db:reset — rebuild the demo database from scratch.
import { config } from '../config';
import { createContext, openDatabase } from '../bootstrap';
import { resetDemoData } from './reset';
import { DEMO_PASSWORDS, USERS } from './catalog';

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
const ctx = createContext(handle);
const started = Date.now();
const res = await resetDemoData(ctx);
console.log(`Demo data rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s — ${res.availableItems} items available.`);
console.table(USERS.map((u) => ({ username: u.username, role: u.role, branch: u.branch ?? 'ALL', password: DEMO_PASSWORDS[u.role] })));
await handle.close();
