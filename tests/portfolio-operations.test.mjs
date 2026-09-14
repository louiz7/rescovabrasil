import { createApp } from '../server/app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, run, id, now } from '../server/db.mjs';
import { fixture, campaign, stage, server } from './helpers.mjs';
import {
  activatePortfolio,
  pausePortfolio,
  portfolioDetail,
  reconcilePortfolios,
} from '../server/portfolio-operations.mjs';
import {
  claimNext,
  finishDispatch,
  finishCampaigns,
  advanceWaiting,
  recordOutcome,
  campaignAction,
  dashboard,
} from '../server/service.mjs';
import { configuration, capabilities } from '../server/providers.mjs';
import { commitImport, suggestMapping } from '../server/importer.mjs';
const caps = capabilities(configuration({}));
const at = new Date('2030-09-16T15:00:00Z');

test('portfolio activation is idempotent, pause blocks all work and active survives completed runs', (t) => {
  const f = fixture(t),
    key = f.portfolio.id;
  assert.equal(portfolioDetail(f.db, key, 'demo').status, 'draft');
  activatePortfolio(f.db, key, { channels: ['sms'] }, 'demo');
  activatePortfolio(f.db, key, { channels: ['sms'] }, 'demo');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM enrollments').n, 1);
  const runId = one(f.db, 'SELECT id FROM campaigns').id;
  pausePortfolio(f.db, key, 'demo');
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
  assert.throws(() => campaignAction(f.db, runId, 'start'), /Activate the portfolio/);
  activatePortfolio(f.db, key, {}, 'demo');
  const claim = claimNext(f.db, caps, 'demo', at, true);
  finishDispatch(f.db, claim.attempt, { status: 'delivered' });
  advanceWaiting(f.db, new Date(at.getTime() + 86400000), true);
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
  finishCampaigns(f.db);
  assert.equal(one(f.db, 'SELECT status FROM campaigns').status, 'completed');
  assert.equal(portfolioDetail(f.db, key, 'demo').status, 'active');
  assert.equal(dashboard(f.db, 'demo').running, 1);
  assert.equal(reconcilePortfolios(f.db, 'demo'), 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM enrollments').n, 1);
});

test('new imports enter active portfolios once while opt-outs, reviews and old runs do not restart', (t) => {
  const f = fixture(t),
    key = f.portfolio.id;
  activatePortfolio(f.db, key, { channels: ['sms'] }, 'demo');
  const staged = stage(f.db, key, [
    ['NEW', 'New Person', '21987654321', '', '10', ''],
    ['STOP', 'Stop Person', '31987654321', '', '10', ''],
    ['REVIEW', 'Review Person', '41987654321', '', '10', ''],
  ]);
  commitImport(f.db, staged.id, suggestMapping(JSON.parse(staged.headers)), [2, 3, 4]);
  recordOutcome(f.db, one(f.db, "SELECT id FROM cases WHERE reference='STOP'").id, {
    outcome: 'opt_out',
  });
  recordOutcome(f.db, one(f.db, "SELECT id FROM cases WHERE reference='REVIEW'").id, {
    outcome: 'human_review',
  });
  pausePortfolio(f.db, key, 'demo');
  assert.equal(reconcilePortfolios(f.db, 'demo'), 0);
  activatePortfolio(f.db, key, {}, 'demo');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM enrollments').n, 2);
  assert.equal(reconcilePortfolios(f.db, 'demo'), 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM enrollments').n, 2);
});

test('legacy runs retain their channel steps and become portfolio-controlled', (t) => {
  const f = fixture(t),
    c = campaign(f, ['sms', 'email']);
  assert.equal(portfolioDetail(f.db, f.portfolio.id, 'demo').status, 'active');
  pausePortfolio(f.db, f.portfolio.id, 'demo');
  assert.equal(one(f.db, 'SELECT status FROM campaigns').status, 'paused');
  activatePortfolio(f.db, f.portfolio.id, { channels: ['voice'] }, 'demo');
  assert.equal(
    one(f.db, 'SELECT channels FROM campaigns WHERE id=?', c.id).channels,
    '["sms","email"]',
  );
  assert.equal(all(f.db, 'SELECT * FROM enrollments').length, 1);
});

test('progress separates confirmed contact, responses and promises from recovered money', (t) => {
  const f = fixture(t);
  activatePortfolio(f.db, f.portfolio.id, { channels: ['sms'] }, 'demo');
  const { attempt, c } = claimNext(f.db, caps, 'demo', at, true);
  finishDispatch(f.db, attempt, { status: 'delivered' });
  let detail = portfolioDetail(f.db, f.portfolio.id, 'demo');
  assert.equal(detail.metrics.attemptedCases, 1);
  assert.equal(detail.metrics.reachedCases, 0);
  run(f.db, 'UPDATE attempts SET identity_verified=1 WHERE id=?', attempt.id);
  recordOutcome(f.db, c.id, { outcome: 'paid_reported' }, 'demo', attempt.id);
  detail = portfolioDetail(f.db, f.portfolio.id, 'demo');
  assert.equal(detail.metrics.reachedCases, 1);
  assert.equal(detail.metrics.openFollowups, 1);
  assert.equal(detail.metrics.responses, 1);
  assert.equal(detail.metrics.coveragePercent, 100);
  assert.equal(detail.metrics.recoveredAmountMinor, null);
  assert.equal(detail.recentAttempts[0].reference, c.reference);
  assert.equal(detail.outcomes[0].outcome, 'paid_reported');
});

test('empty portfolios can activate; isolated voice-demo portfolios cannot', (t) => {
  const f = fixture(t);
  run(f.db, 'DELETE FROM events');
  run(f.db, 'DELETE FROM cases');
  assert.equal(
    activatePortfolio(f.db, f.portfolio.id, { channels: ['sms'] }, 'demo').status,
    'active',
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM campaigns').n, 0);
  run(f.db, "INSERT INTO settings VALUES ('demo_voice_portfolio',?)", f.portfolio.id);
  assert.throws(
    () => activatePortfolio(f.db, f.portfolio.id, { channels: ['sms'] }, 'demo'),
    /isolated/,
  );
  assert.equal(portfolioDetail(f.db, f.portfolio.id, 'demo').automationBlocked, true);
});

test('authenticated portfolio simulation stays scoped, respects pause and rejects unknown portfolios', async (t) => {
  const f = fixture(t),
    other = id();
  run(
    f.db,
    'INSERT INTO portfolios VALUES (?,?,?,?,?)',
    other,
    'Other portfolio',
    'Test',
    'America/Sao_Paulo',
    now(),
  );
  const staged = stage(f.db, other, [['OTHER', 'Other Person', '21987654321', '', '10', '']]);
  commitImport(f.db, staged.id, suggestMapping(JSON.parse(staged.headers)), [2]);
  const base = await server(t, createApp(f.db, configuration({})));
  assert.equal((await fetch(base + '/api/portfolios/' + other)).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'rescova-demo' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (const portfolio of [f.portfolio.id, other])
    assert.equal(
      (await post('/api/portfolios/' + portfolio + '/activate', { channels: ['sms'] })).status,
      200,
    );
  await post('/api/portfolios/' + other + '/pause', {});
  assert.equal(
    (await (await post('/api/demo/step', { portfolioId: other, advanceTime: true })).json())
      .processed,
    0,
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  assert.equal((await post('/api/demo/step', { portfolioId: 'missing' })).status, 404);
  await post('/api/portfolios/' + other + '/activate', {});
  const result = await (
    await post('/api/demo/step', { portfolioId: other, outcome: 'paid_reported' })
  ).json();
  assert.equal(result.processed, 1);
  assert.equal(
    one(f.db, 'SELECT portfolio_id FROM cases WHERE id=?', result.caseId).portfolio_id,
    other,
  );
  assert.equal(portfolioDetail(f.db, f.portfolio.id, 'demo').metrics.attempts, 0);
});

test('legacy active mandates adopt automatically and enroll new imports once; paused legacy stays paused', (t) => {
  const f = fixture(t),
    legacy = campaign(f, ['sms']);
  const staged = stage(f.db, f.portfolio.id, [
    ['LATER', 'Later Person', '21987654321', '', '10', ''],
  ]);
  commitImport(f.db, staged.id, suggestMapping(JSON.parse(staged.headers)), [2]);
  campaignAction(f.db, legacy.id, 'pause');
  assert.equal(reconcilePortfolios(f.db, 'demo'), 0);
  assert.equal(one(f.db, 'SELECT status FROM portfolio_operations').status, 'paused');
  run(f.db, 'DELETE FROM portfolio_operations');
  campaignAction(f.db, legacy.id, 'start');
  assert.equal(reconcilePortfolios(f.db, 'demo'), 1);
  assert.equal(one(f.db, 'SELECT status FROM portfolio_operations').status, 'active');
  assert.equal(reconcilePortfolios(f.db, 'demo'), 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM enrollments').n, 2);
});
