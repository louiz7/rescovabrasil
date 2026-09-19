import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../server/db.mjs';
import {
  createAutonomousPlanner,
  ensureAutonomyDemoPortfolio,
} from '../server/autonomous-planner.mjs';
import { activatePortfolio, pausePortfolio } from '../server/portfolio-operations.mjs';
import { configuration } from '../server/providers.mjs';
import { fixture } from './helpers.mjs';

function setup(t, evaluateDecision) {
  const f = fixture(t);
  const portfolioId = ensureAutonomyDemoPortfolio(f.db);
  activatePortfolio(f.db, portfolioId, { channels: ['sms', 'email', 'voice'] }, 'demo');
  const config = {
    ...configuration({}),
    typeSafeDecisionMode: evaluateDecision ? 'active' : 'off',
    typeSafeActiveMinConfidence: 0.75,
  };
  return {
    ...f,
    portfolioId,
    planner: createAutonomousPlanner(f.db, config, { evaluateDecision }),
  };
}

test('mock autonomous run plans safe work, executes specialists and never contacts providers', async (t) => {
  const f = setup(t, async (state) => ({
    provider: 'typesafe',
    model: 'jev-test',
    answers: {},
    proposedAction: {
      action: state.allowedActions.includes('send_sms') ? 'send_sms' : state.allowedActions[0],
      confidence: 0.96,
    },
    usage: { inputTokens: 4 },
    latencyMs: 2,
  }));

  const result = await f.planner.runSimulation(f.portfolioId);
  assert.equal(result.latestRun.scanned, 7);
  assert.equal(result.latestRun.planned, 7);
  assert.equal(
    one(f.db, "SELECT COUNT(*) n FROM autonomy_actions WHERE status='simulated_completed'").n,
    6,
  );
  assert.equal(
    one(
      f.db,
      'SELECT COUNT(*) n FROM attempts WHERE case_id IN (SELECT id FROM cases WHERE portfolio_id=?)',
      f.portfolioId,
    ).n,
    6,
  );
  assert.equal(result.latestRun.summary.providerContacts, 0);
  assert.equal(result.latestRun.goal_id, `recovery:${f.portfolioId}`);
  assert.equal(result.latestRun.organization_mandate_version, 'rescova-recovery-v1');
  assert.match(result.latestRun.policy_version, /^[a-f0-9]{64}$/);
  assert.equal(result.mandate.role.agentId, 'Mateo');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM autonomy_tasks WHERE goal_id IS NULL').n, 0);
  assert.equal(
    one(f.db, 'SELECT COUNT(*) n FROM autonomy_tasks WHERE role_charter_version IS NULL').n,
    0,
  );
  assert.deepEqual(
    all(
      f.db,
      `SELECT c.reference,a.outcome FROM attempts a JOIN cases c ON c.id=a.case_id
       WHERE c.portfolio_id=? ORDER BY c.reference`,
      f.portfolioId,
    ).map((row) => [row.reference, row.outcome]),
    [
      ['AUTO-001', 'not_reached'],
      ['AUTO-002', 'willing_to_pay'],
      ['AUTO-003', 'callback'],
      ['AUTO-004', 'document_request'],
      ['AUTO-005', 'disputed'],
      ['AUTO-006', 'invalid_contact'],
    ],
  );
  assert.ok(result.tasks.some((task) => task.owner === 'Helena' && task.status === 'completed'));
  assert.ok(result.tasks.some((task) => task.owner === 'Rafael' && task.status === 'waiting'));
  assert.ok(result.tasks.some((task) => task.owner === 'Clara' && task.status === 'scheduled'));
  assert.ok(result.tasks.some((task) => task.owner === 'Tiago' && task.status === 'waiting'));
  assert.equal(one(f.db, "SELECT suppressed FROM cases WHERE reference='AUTO-006'").suppressed, 1);

  const repeat = await f.planner.runSimulation(f.portfolioId);
  assert.equal(repeat.latestRun.id, result.latestRun.id);
  assert.equal(repeat.lastCheck.planned, 0);
  assert.equal(repeat.lastCheck.skipped, 7);
  assert.equal(repeat.tasks.length, result.tasks.length);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM autonomy_actions').n, 6);

  f.planner.executeRun(result.latestRun.id, new Date(Date.now() + 25 * 3600000));
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM autonomy_actions').n, 8);
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM autonomy_tasks WHERE status='scheduled'").n, 2);
});

test('paused portfolio cancels planned work before execution', async (t) => {
  const f = setup(t);
  const planned = await f.planner.planPortfolio(f.portfolioId, { simulate: true });
  pausePortfolio(f.db, f.portfolioId, 'demo');
  f.planner.executeRun(planned.id);
  assert.equal(
    one(
      f.db,
      'SELECT COUNT(*) n FROM attempts WHERE case_id IN (SELECT id FROM cases WHERE portfolio_id=?)',
      f.portfolioId,
    ).n,
    0,
  );
  assert.equal(
    one(
      f.db,
      "SELECT COUNT(*) n FROM autonomy_tasks WHERE run_id=? AND status='cancelled'",
      planned.id,
    ).n,
    6,
  );
});

test('invalid semantic choice falls back to configured channel order and records the trace', async (t) => {
  const f = setup(t, async () => ({
    provider: 'typesafe',
    model: 'jev-test',
    answers: {},
    proposedAction: { action: 'delete_case', confidence: 0.99 },
    usage: null,
    latencyMs: 1,
  }));
  const planned = await f.planner.planPortfolio(f.portfolioId, { simulate: true });
  assert.ok(planned.planned > 0);
  assert.equal(
    one(f.db, 'SELECT applied_action FROM autonomy_decisions ORDER BY created_at LIMIT 1')
      .applied_action,
    'send_sms',
  );
  assert.equal(
    all(
      f.db,
      "SELECT kind FROM autonomy_tasks WHERE channel IS NOT NULL AND status='queued'",
    ).every((task) => ['send_sms', 'send_email', 'call'].includes(task.kind)),
    true,
  );
});
