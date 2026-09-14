import { openDb, run, now } from '../server/db.mjs';
import { configuration } from '../server/providers.mjs';
const config = configuration(),
  db = openDb(config.dbPath);
const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
const removed = run(
  db,
  "UPDATE imports SET rows='[]',status='expired' WHERE status='staged' AND created_at<?",
  cutoff,
);
// Keep provider receipts: removing them could allow a late duplicate to be reprocessed.
console.log(
  `Importações expiradas: ${removed.changes}. Histórico de casos e recibos preservados. ${now()}`,
);
db.close();
