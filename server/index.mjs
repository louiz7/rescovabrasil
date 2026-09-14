import { reconcilePortfolios } from './portfolio-operations.mjs';
import { createServer } from 'node:http';
import { openDb, one, run } from './db.mjs';
import { configuration, capabilities, dispatch } from './providers.mjs';
import { createApp } from './app.mjs';
import { attachTwilioTest } from './twilio-live-bridge.mjs';
import { attachRealtime } from './realtime.mjs';
import { seedDemo } from './seed.mjs';
import {
  advanceWaiting,
  claimNext,
  finishDispatch,
  failDispatch,
  finishCampaigns,
  recoverQueue,
} from './service.mjs';

const config = configuration(),
  db = openDb(config.dbPath);
const stored = one(db, "SELECT value FROM settings WHERE key='mode'");
if (stored && stored.value !== config.mode)
  throw new Error('Banco pertence a outro modo. Use arquivos separados para demo e live.');
run(db, "INSERT OR IGNORE INTO settings VALUES ('mode',?)", config.mode);
if (config.mode === 'demo' && process.env.SEED_DEMO !== 'false') seedDemo(db);
recoverQueue(db);
run(
  db,
  "UPDATE imports SET rows='[]',status='expired' WHERE status='staged' AND created_at<?",
  new Date(Date.now() - 24 * 3600000).toISOString(),
);
const app = createApp(db, config),
  server = createServer(app),
  wss = attachRealtime(server, db, config),
  testWss = attachTwilioTest(server, app.locals.twilioTests, config);
app.locals.grokTests.attach(server);
let busy = false;
const agentTick = setInterval(() => {
  void app.locals.agentWorkflows.tick().catch(() => console.error('Agent workflow tick failed.'));
}, 1000);
const tick = setInterval(async () => {
  if (busy || config.mode !== 'live' || !config.liveEnabled) return;
  busy = true;
  try {
    reconcilePortfolios(db, config.mode);
    advanceWaiting(db);
    const claim = claimNext(db, capabilities(config), config.mode);
    if (claim)
      try {
        finishDispatch(db, claim.attempt, await dispatch(config, claim.attempt, claim.c));
      } catch (e) {
        failDispatch(db, claim.attempt, e);
      }
    finishCampaigns(db);
  } catch (error) {
    console.error('Worker error:', error.name);
  } finally {
    busy = false;
  }
}, 3000);
const maintenance = setInterval(
  () =>
    run(
      db,
      "UPDATE imports SET rows='[]',status='expired' WHERE status='staged' AND created_at<?",
      new Date(Date.now() - 24 * 3600000).toISOString(),
    ),
  3600000,
);
server.listen(config.port, config.host, () =>
  console.log(`Rescova ${config.mode} · http://${config.host}:${config.port}`),
);
async function shutdown() {
  clearInterval(tick);
  clearInterval(agentTick);
  clearInterval(maintenance);
  for (const client of wss.clients) client.close();
  for (const client of testWss.clients) client.close();
  await Promise.all([
    app.locals.voiceTests.closeAll(),
    app.locals.twilioTests.closeAll(),
    app.locals.grokTests.closeAll(),
  ]);
  await app.locals.voiceDebug.closeAll();
  await app.locals.agentWorkflows.closeAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
