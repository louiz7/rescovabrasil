import { openDb, id, now, run, all } from '../server/db.mjs';
import { createPortfolio, createCampaign, campaignAction } from '../server/service.mjs';
import { suggestMapping, commitImport } from '../server/importer.mjs';
import { configuration } from '../server/providers.mjs';

export function fixture(
  t,
  rows = [['BR-1', 'Ana Silva', '11987654321', 'ana@example.test', '1.234,56', '2025-01-31']],
) {
  const db = openDb();
  t.after(() => db.close());
  const portfolio = createPortfolio(db, { name: 'Carteira piloto', creditor: 'Credor teste' });
  const staged = stage(db, portfolio.id, rows);
  commitImport(
    db,
    staged.id,
    suggestMapping(JSON.parse(staged.headers)),
    rows.map((_, i) => i + 2),
  );
  return { db, portfolio, cases: all(db, 'SELECT * FROM cases') };
}
export function stage(
  db,
  portfolioId,
  rows,
  headers = ['referencia', 'nome', 'telefone', 'email', 'saldo', 'vencimento'],
) {
  const s = {
    id: id(),
    portfolio_id: portfolioId,
    filename: 'teste.csv',
    headers: JSON.stringify(headers),
    rows: JSON.stringify(rows),
    created_at: now(),
  };
  run(
    db,
    'INSERT INTO imports (id,portfolio_id,filename,headers,rows,created_at) VALUES (?,?,?,?,?,?)',
    ...Object.values(s),
  );
  return s;
}
export function campaign(f, channels = ['sms', 'voice', 'email'], mode = 'demo') {
  const c = createCampaign(
    f.db,
    {
      name: 'Contato inicial',
      portfolioId: f.portfolio.id,
      caseIds: f.cases.map((c) => c.id),
      channels,
    },
    mode,
  );
  campaignAction(f.db, c.id, 'start');
  return c;
}
export const liveConfig = () =>
  configuration({
    OUTREACH_MODE: 'live',
    OPERATOR_PASSWORD: 'test-password-long',
    LIVE_SEND_ENABLED: 'true',
    PUBLIC_BASE_URL: 'https://pilot.example.test',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'test-token',
    TWILIO_PHONE_NUMBER: '+551133334444',
    OPENAI_API_KEY: 'test-openai',
    OUTBOUND_ALLOWLIST: '+5511987654321',
  });
export async function server(t, app) {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => s.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        s.close(resolve);
        s.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${s.address().port}`;
}
