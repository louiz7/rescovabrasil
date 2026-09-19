import test from 'node:test';
import assert from 'node:assert/strict';
import { operatingMandate, portfolioMandateView } from '../server/operating-mandate.mjs';
import { activatePortfolio } from '../server/portfolio-operations.mjs';
import { liveVoiceInstructions } from '../server/voice-policy.mjs';
import { fixture } from './helpers.mjs';

test('runtime composes organization, portfolio, role, task and policy into one compact mandate', (t) => {
  const f = fixture(t);
  activatePortfolio(f.db, f.portfolio.id, { channels: ['sms', 'email'] }, 'demo');
  const mandate = operatingMandate(f.db, {
    caseId: f.cases[0].id,
    agentId: 'Marina',
    taskGoal: 'Answer the current payment question.',
  });

  assert.equal(
    mandate.organization.objective,
    'Maximize verified recovery of Rescova-owned receivables within approved rules.',
  );
  assert.equal(mandate.portfolio.id, f.portfolio.id);
  assert.match(mandate.portfolio.objective, /Carteira piloto/);
  assert.equal(mandate.role.agentId, 'Marina');
  assert.equal(mandate.task.goal, 'Answer the current payment question.');
  assert.deepEqual(mandate.policy.portfolio.channels, ['sms', 'email']);
  assert.match(mandate.policyVersion, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(mandate).includes(f.cases[0].name), false);
});

test('portfolio mandate view exposes versioned role contracts for oversight', (t) => {
  const f = fixture(t);
  const view = portfolioMandateView(f.db, f.portfolio.id);
  assert.equal(view.goalId, `recovery:${f.portfolio.id}`);
  assert.ok(view.roles.some((role) => role.agent_id === 'Mateo'));
  assert.ok(view.roles.some((role) => role.agent_id === 'Helena'));
  assert.match(liveVoiceInstructions, /Maximize verified recovery/);
});
