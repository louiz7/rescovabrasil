import { all, one, run, id, now, event, transaction } from './db.mjs';
import { assert, CHANNELS } from './domain.mjs';
import { suppressionReason } from './service.mjs';

export function operationState(db, portfolioId, mode) {
  const stored = one(db, 'SELECT * FROM portfolio_operations WHERE portfolio_id=?', portfolioId);
  if (stored) return { ...stored, channels: JSON.parse(stored.channels) };
  const legacy = one(
    db,
    "SELECT * FROM campaigns WHERE portfolio_id=? AND status IN ('running','paused','draft') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, created_at DESC LIMIT 1",
    portfolioId,
  );
  return {
    status:
      legacy?.status === 'running' ? 'active' : legacy?.status === 'paused' ? 'paused' : 'draft',
    channels: legacy ? JSON.parse(legacy.channels) : ['sms', 'email', 'voice'],
    mode: legacy?.mode || mode,
    activated_at: legacy?.status === 'running' ? legacy.created_at : null,
  };
}
function demoPortfolio(db, portfolioId) {
  return !!one(
    db,
    "SELECT 1 FROM settings WHERE key='demo_voice_portfolio' AND value=?",
    portfolioId,
  );
}
export function portfolioSummary(db, portfolioId, mode) {
  const p = one(db, 'SELECT * FROM portfolios WHERE id=?', portfolioId);
  assert(p, 'Portfolio not found.', 404);
  const scalar = (sql) => one(db, sql, portfolioId).n;
  const cases = scalar('SELECT COUNT(*) n FROM cases WHERE portfolio_id=?');
  const attemptedCases = scalar(
    'SELECT COUNT(DISTINCT a.case_id) n FROM attempts a JOIN cases c ON c.id=a.case_id WHERE c.portfolio_id=?',
  );
  const agreements = one(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='demo_voice_results'",
  )
    ? all(
        db,
        'SELECT r.agreement_json FROM demo_voice_results r JOIN cases c ON c.id=r.case_id WHERE c.portfolio_id=?',
        portfolioId,
      ).map((r) => JSON.parse(r.agreement_json))
    : [];
  const metrics = {
    cases,
    attemptedCases,
    reachedCases: scalar(
      'SELECT COUNT(DISTINCT a.case_id) n FROM attempts a JOIN cases c ON c.id=a.case_id WHERE c.portfolio_id=? AND a.identity_verified=1',
    ),
    attempts: scalar(
      'SELECT COUNT(*) n FROM attempts a JOIN cases c ON c.id=a.case_id WHERE c.portfolio_id=?',
    ),
    responses: scalar(
      "SELECT COUNT(*) n FROM cases WHERE portfolio_id=? AND outcome IS NOT NULL AND outcome NOT IN ('not_reached','invalid_contact')",
    ),
    openFollowups: scalar(
      "SELECT COUNT(*) n FROM tasks t JOIN cases c ON c.id=t.case_id WHERE c.portfolio_id=? AND t.status='open'",
    ),
    queuedCases: scalar(
      "SELECT COUNT(DISTINCT e.case_id) n FROM enrollments e JOIN cases c ON c.id=e.case_id WHERE c.portfolio_id=? AND e.state IN ('queued','dispatching')",
    ),
    waitingCases: scalar(
      "SELECT COUNT(DISTINCT e.case_id) n FROM enrollments e JOIN cases c ON c.id=e.case_id WHERE c.portfolio_id=? AND e.state='waiting'",
    ),
    reviewCases: scalar('SELECT COUNT(*) n FROM cases WHERE portfolio_id=? AND review_required=1'),
    blockedCases: all(db, 'SELECT * FROM cases WHERE portfolio_id=?', portfolioId).filter((c) =>
      suppressionReason(db, c),
    ).length,
    agreementCount: agreements.length,
    agreedAmountMinor: agreements
      .filter((a) => a.currency === 'BRL')
      .reduce((sum, a) => sum + a.totalMinor, 0),
    recoveredAmountMinor: null,
    simulatedReceivedMinor: one(
      db,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='collected_payments'",
    )
      ? scalar(
          "SELECT COALESCE(SUM(CASE WHEN p.status IN ('succeeded','refunded') THEN p.amount_minor-p.refunded_minor ELSE 0 END),0) n FROM collected_payments p JOIN cases c ON c.id=p.case_id WHERE c.portfolio_id=? AND p.mode='simulation' AND p.currency='BRL'",
        )
      : 0,
    coveragePercent: cases ? Math.round((attemptedCases / cases) * 100) : 0,
  };
  return {
    ...p,
    ...operationState(db, p.id, mode),
    case_count: cases,
    balance: scalar(
      "SELECT COALESCE(SUM(amount_minor),0) n FROM cases WHERE portfolio_id=? AND currency='BRL'",
    ),
    metrics,
    automationBlocked: demoPortfolio(db, p.id),
  };
}
export function portfolioList(db, mode) {
  return all(db, 'SELECT id FROM portfolios ORDER BY created_at DESC').map((p) =>
    portfolioSummary(db, p.id, mode),
  );
}
export function portfolioDetail(db, portfolioId, mode) {
  return {
    ...portfolioSummary(db, portfolioId, mode),
    recentAttempts: all(
      db,
      'SELECT a.*,c.name,c.reference FROM attempts a JOIN cases c ON c.id=a.case_id WHERE c.portfolio_id=? ORDER BY a.created_at DESC LIMIT 30',
      portfolioId,
    ),
    daily: all(
      db,
      'SELECT substr(a.created_at,1,10) AS "day",COUNT(*) count FROM attempts a JOIN cases c ON c.id=a.case_id WHERE c.portfolio_id=? GROUP BY "day" ORDER BY "day" DESC LIMIT 14',
      portfolioId,
    ).reverse(),
    outcomes: all(
      db,
      'SELECT outcome,COUNT(*) count FROM cases WHERE portfolio_id=? AND outcome IS NOT NULL GROUP BY outcome',
      portfolioId,
    ),
    channelStats: all(
      db,
      'SELECT channel,COUNT(*) attempts,SUM(identity_verified) reached FROM attempts a JOIN cases c ON c.id=a.case_id WHERE c.portfolio_id=? GROUP BY channel',
      portfolioId,
    ),
  };
}
function enrollNew(db, operation) {
  if (demoPortfolio(db, operation.portfolio_id)) return 0;
  const channels = JSON.parse(operation.channels);
  const fresh = all(
    db,
    `SELECT c.* FROM cases c WHERE c.portfolio_id=?
    AND NOT EXISTS(SELECT 1 FROM enrollments e WHERE e.case_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.case_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.case_id=c.id AND t.status='open')`,
    operation.portfolio_id,
  ).filter(
    (c) =>
      !suppressionReason(db, c) &&
      channels.some((channel) => (channel === 'email' ? c.email : c.phone)),
  );
  if (!fresh.length) return 0;
  // Each internal run has an immutable channel order, preserving already dispatched step IDs.
  const campaignId = id();
  run(
    db,
    'INSERT INTO campaigns VALUES (?,?,?,?,?,?,?)',
    campaignId,
    operation.portfolio_id,
    'Portfolio outreach',
    operation.channels,
    'running',
    operation.mode,
    now(),
  );
  for (const c of fresh)
    run(
      db,
      'INSERT INTO enrollments (id,campaign_id,case_id,state,due_at) VALUES (?,?,?,?,?)',
      id(),
      campaignId,
      c.id,
      'queued',
      now(),
    );
  event(
    db,
    null,
    'portfolio_work_scheduled',
    { portfolioId: operation.portfolio_id, runId: campaignId, cases: fresh.length },
    'worker',
  );
  return fresh.length;
}
export function adoptLegacyPortfolios(db) {
  for (const p of all(
    db,
    `SELECT p.id FROM portfolios p WHERE NOT EXISTS(SELECT 1 FROM portfolio_operations o WHERE o.portfolio_id=p.id)
    AND EXISTS(SELECT 1 FROM campaigns c WHERE c.portfolio_id=p.id AND c.status IN ('running','paused'))`,
  )) {
    if (demoPortfolio(db, p.id)) continue;
    const state = operationState(db, p.id, 'demo');
    run(
      db,
      'INSERT OR IGNORE INTO portfolio_operations VALUES (?,?,?,?,?,?)',
      p.id,
      state.status,
      JSON.stringify(state.channels),
      state.mode,
      state.activated_at,
      now(),
    );
  }
}
export function reconcilePortfolios(db, mode) {
  return transaction(db, () => {
    adoptLegacyPortfolios(db);
    return all(
      db,
      "SELECT * FROM portfolio_operations WHERE status='active' AND mode=?",
      mode,
    ).reduce((sum, op) => sum + enrollNew(db, op), 0);
  });
}
export function activatePortfolio(db, portfolioId, input, mode) {
  assert(one(db, 'SELECT id FROM portfolios WHERE id=?', portfolioId), 'Portfolio not found.', 404);
  assert(
    !demoPortfolio(db, portfolioId),
    'Voice test demos are isolated and cannot be activated for outreach.',
    409,
  );
  const channels = input.channels ?? operationState(db, portfolioId, mode).channels;
  assert(
    Array.isArray(channels) &&
      channels.length > 0 &&
      channels.length <= 4 &&
      new Set(channels).size === channels.length &&
      channels.every((c) => CHANNELS.includes(c)),
    'Select valid channels in order.',
  );
  transaction(db, () => {
    run(
      db,
      `INSERT INTO portfolio_operations VALUES (?,?,?,?,?,?) ON CONFLICT(portfolio_id) DO UPDATE SET status='active',channels=excluded.channels,activated_at=COALESCE(portfolio_operations.activated_at,excluded.activated_at),updated_at=excluded.updated_at`,
      portfolioId,
      'active',
      JSON.stringify(channels),
      mode,
      now(),
      now(),
    );
    // Resume legacy and internal unfinished runs, keeping their existing step/channel contracts.
    run(
      db,
      "UPDATE campaigns SET status='running' WHERE portfolio_id=? AND mode=? AND status IN ('paused','draft')",
      portfolioId,
      mode,
    );
    enrollNew(db, one(db, 'SELECT * FROM portfolio_operations WHERE portfolio_id=?', portfolioId));
    event(db, null, 'portfolio_activated', { portfolioId, channels, mode });
  });
  return portfolioDetail(db, portfolioId, mode);
}
export function pausePortfolio(db, portfolioId, mode) {
  const summary = portfolioSummary(db, portfolioId, mode);
  transaction(db, () => {
    run(
      db,
      `INSERT INTO portfolio_operations VALUES (?,?,?,?,?,?) ON CONFLICT(portfolio_id) DO UPDATE SET status='paused',updated_at=excluded.updated_at`,
      portfolioId,
      'paused',
      JSON.stringify(summary.channels),
      mode,
      summary.activated_at,
      now(),
    );
    run(
      db,
      "UPDATE campaigns SET status='paused' WHERE portfolio_id=? AND status='running'",
      portfolioId,
    );
    event(db, null, 'portfolio_paused', { portfolioId });
  });
  return portfolioDetail(db, portfolioId, mode);
}
