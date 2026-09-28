// npm run bootstrap -w @jerp/backend -- --username gm.name --full-name "Name" [--full-name-ar "الاسم"]
//                                       [--branch KRT:"Khartoum Branch":"فرع الخرطوم":Khartoum] …
// Creates the reference data and the FIRST General Manager of a production deployment.
// The one-time password is printed once; the GM must change it at first sign-in.

import { parseArgs } from 'node:util';
import { config } from './config';
import { createContext, openDatabase } from './bootstrap';
import { productionConfigProblems } from './core/startup';
import { bootstrapProduction, parseBranchArg } from './modules/bootstrap/service';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    'full-name': { type: 'string' },
    'full-name-ar': { type: 'string' },
    branch: { type: 'string', multiple: true },
  },
  strict: true,
});

if (!values.username || !values['full-name']) {
  console.error('Usage: npm run bootstrap -w @jerp/backend -- --username <user> --full-name "<name>" [--full-name-ar "<name>"] [--branch CODE:NameEn:NameAr:City ...]');
  process.exit(2);
}
const problems = productionConfigProblems(config);
if (problems.length) {
  console.error(`Refusing to bootstrap (APP_MODE=${config.appMode}):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir });
try {
  const ctx = createContext(handle);
  const res = await bootstrapProduction(ctx, {
    username: values.username,
    fullName: values['full-name'],
    fullNameAr: values['full-name-ar'],
    branches: (values.branch ?? []).map(parseBranchArg),
  });
  console.log(`General Manager "${res.username}" created. Branches created: ${res.branches.join(', ') || 'none'}.`);
  console.log(`One-time password (shown once, must be changed at first sign-in): ${res.temporaryPassword}`);
} catch (e) {
  console.error(`Bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
