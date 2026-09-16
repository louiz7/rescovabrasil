import { openDb, one, run } from './db.mjs';
import { configuration } from './providers.mjs';
import { ensureDemoPlatform } from './demo-platform.mjs';
import { createAgentWorkflows } from './agent-workflows.mjs';
import { createAgentRunner } from './agent-models.mjs';
import { createEmailWorkflows } from './email-workflows.mjs';
import { startWorkerRuntime } from './worker-runtime.mjs';

const config = configuration();
if (!/^postgres(?:ql)?:\/\//.test(config.dbPath))
  throw new Error(
    'Standalone workers require DATABASE_URL pointing to PostgreSQL. Keep SQLite in combined local mode.',
  );
const db = openDb(config.dbPath);
const stored = one(db, "SELECT value FROM settings WHERE key='mode'");
if (stored && stored.value !== config.mode)
  throw new Error('Database mode does not match worker mode.');
run(db, "INSERT OR IGNORE INTO settings VALUES ('mode',?)", config.mode);
ensureDemoPlatform(db);
const agents = createAgentWorkflows(db, config, { runAgent: createAgentRunner(config) });
const email = createEmailWorkflows(db, config, agents);
const runtime = startWorkerRuntime(db, config, {
  agents,
  email,
  kind: process.env.WORKER_KIND || 'all',
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 90000);
  timeout.unref();
  await runtime.close();
  db.close();
  clearTimeout(timeout);
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
console.log(`Rescova ${process.env.WORKER_KIND || 'all'} worker started.`);
