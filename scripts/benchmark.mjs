import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openDb, id, now, run, all } from '../server/db.mjs';
import { createPortfolio, createCampaign, claimNext } from '../server/service.mjs';
import { validateRows, commitImport } from '../server/importer.mjs';
import { capabilities, configuration } from '../server/providers.mjs';

// Entirely in memory with synthetic recipients. Never calls an external provider.
const db = openDb(),
  p = createPortfolio(db, { name: 'Teste de volume', creditor: 'Credor fictício' });
const headers = ['referencia', 'nome', 'email', 'saldo'],
  mapping = { reference: 'referencia', name: 'nome', email: 'email', amount: 'saldo' };
const rows = Array.from({ length: 10000 }, (_, i) => [
  `VOLUME-${i}`,
  `Pessoa fictícia ${i}`,
  `pessoa${i}@example.invalid`,
  '1.234,56',
]);
const stage = {
  id: id(),
  portfolio_id: p.id,
  filename: 'synthetic.csv',
  headers: JSON.stringify(headers),
  rows: JSON.stringify(rows),
};
run(
  db,
  'INSERT INTO imports (id,portfolio_id,filename,headers,rows,created_at) VALUES (?,?,?,?,?,?)',
  ...Object.values(stage),
  now(),
);
const start = performance.now(),
  report = validateRows(db, stage, mapping);
assert.equal(report.filter((r) => r.valid).length, 10000);
const validated = performance.now();
const committed = commitImport(
  db,
  stage.id,
  mapping,
  report.map((r) => r.row),
);
assert.equal(committed.imported, 10000);
const imported = performance.now();
const cases = all(db, 'SELECT id FROM cases');
const campaign = createCampaign(
  db,
  { portfolioId: p.id, name: 'Volume local', caseIds: cases.map((c) => c.id), channels: ['email'] },
  'demo',
);
run(db, "UPDATE campaigns SET status='running' WHERE id=?", campaign.id);
const created = performance.now();
assert.ok(claimNext(db, capabilities(configuration({})), 'demo', new Date(), true));
console.log(
  JSON.stringify(
    {
      cases: cases.length,
      validationMs: Math.round(validated - start),
      commitMs: Math.round(imported - validated),
      campaignMs: Math.round(created - imported),
      claimMs: Math.round(performance.now() - created),
      externalRequests: 0,
      scope: 'single process, in-memory SQLite; not production throughput',
    },
    null,
    2,
  ),
);
db.close();
