import { id, now, run, one, event, task } from './db.mjs';
import { createPortfolio, createCampaign, recordOutcome, finishDispatch } from './service.mjs';
import { ensureAutonomyDemoPortfolio } from './autonomous-planner.mjs';

export function seedDemo(db) {
  if (one(db, 'SELECT id FROM cases LIMIT 1')) return ensureAutonomyDemoPortfolio(db);
  const p = createPortfolio(db, {
    name: 'Horizonte · Personal loans',
    creditor: 'Financeira Horizonte (fictional)',
  });
  createPortfolio(db, { name: 'Aurora · Pilot portfolio', creditor: 'Banco Aurora (fictional)' });
  const names = [
    'Mariana Santos',
    'Lucas Oliveira',
    'Ana Costa',
    'Pedro Almeida',
    'Beatriz Lima',
    'Gabriel Souza',
    'Camila Rocha',
    'Rafael Martins',
    'Juliana Ribeiro',
    'Bruno Ferreira',
    'Fernanda Alves',
    'Diego Barros',
    'Larissa Mendes',
    'Thiago Gomes',
    'Isabela Nunes',
    'Matheus Silva',
    'Patrícia Melo',
    'André Carvalho',
  ];
  const ids = [];
  names.forEach((name, i) => {
    const cid = id(),
      reference = `BR-${String(1041 + i).padStart(5, '0')}`;
    ids.push(cid);
    run(
      db,
      `INSERT INTO cases (id,portfolio_id,reference,name,phone,email,amount_minor,due_date,timezone,verification_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      cid,
      p.id,
      reference,
      name,
      i === 4 || i === 9 ? null : `+551199900${String(1000 + i)}`,
      i === 2 || i === 8 ? null : `cliente${i + 1}@example.invalid`,
      i === 16 ? null : Math.round((320 + i * 83.7) * 100),
      `2026-0${3 + (i % 4)}-15`,
      'America/Sao_Paulo',
      null,
      now(),
    );
    event(db, cid, 'imported', 'Fictional demo data. Never use for real outreach.', 'demo');
  });
  const camp = createCampaign(
    db,
    {
      name: 'First contact · September',
      portfolioId: p.id,
      channels: ['sms', 'voice', 'email'],
      caseIds: ids.slice(0, 10),
    },
    'demo',
  );
  run(db, "UPDATE campaigns SET status='paused' WHERE id=?", camp.id);
  const outcomes = [
    'willing_to_pay',
    'callback',
    'paid_reported',
    'not_reached',
    'human_review',
    'unable_to_pay',
    'disputed',
    'opt_out',
  ];
  outcomes.forEach((outcome, i) => {
    const e = one(
      db,
      'SELECT * FROM enrollments WHERE campaign_id=? AND case_id=?',
      camp.id,
      ids[i],
    );
    const aid = id(),
      channel = i % 3 === 0 ? 'voice' : i === 4 ? 'email' : 'sms';
    const c = one(db, 'SELECT * FROM cases WHERE id=?', ids[i]);
    const created = new Date(Date.now() - (7 - i) * 86400000).toISOString();
    run(
      db,
      `INSERT INTO attempts (id,campaign_id,enrollment_id,case_id,step,channel,destination,mode,status,identity_verified,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      aid,
      camp.id,
      e.id,
      c.id,
      0,
      channel,
      channel === 'email' ? c.email : c.phone,
      'demo',
      channel === 'voice' ? 'completed' : 'delivered',
      channel === 'voice' && i !== 3 ? 1 : 0,
      created,
      created,
    );
    run(db, "UPDATE enrollments SET state='waiting' WHERE id=?", e.id);
    if (channel === 'voice' && i !== 3)
      run(db, "UPDATE attempts SET identity_method='self_reported_name' WHERE id=?", aid);
    recordOutcome(
      db,
      c.id,
      {
        outcome,
        note: 'Simulated outcome for exploring the operational workflow.',
        callbackAt:
          outcome === 'callback' ? new Date(Date.now() + 86400000).toISOString() : undefined,
        willingness: ['willing_to_pay', 'unable_to_pay'].includes(outcome) ? 'yes' : 'unknown',
        ability: outcome === 'unable_to_pay' ? 'no' : 'unknown',
      },
      'demo',
      aid,
    );
  });
  ensureAutonomyDemoPortfolio(db);
}
