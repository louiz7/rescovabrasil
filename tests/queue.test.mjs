import test from 'node:test';
import assert from 'node:assert/strict';
import { one, all } from '../server/db.mjs';
import { capabilities, configuration } from '../server/providers.mjs';
import {
  claimNext,
  campaignAction,
  createCampaign,
  advanceWaiting,
  finishDispatch,
  recoverQueue,
  recordOutcome,
  dashboard,
} from '../server/service.mjs';
import { providerStatus, inboundMessage, receiveOnce } from '../server/webhooks.mjs';
import { commitImport, suggestMapping } from '../server/importer.mjs';
import { fixture, campaign, liveConfig, stage } from './helpers.mjs';
const caps = capabilities(configuration({}));
const at = new Date('2030-09-16T15:00:00Z');

test('pause prevents claims; claim is exclusive and restart never automatically resends uncertain work', (t) => {
  const f = fixture(t),
    c = campaign(f);
  campaignAction(f.db, c.id, 'pause');
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
  campaignAction(f.db, c.id, 'start');
  const claimed = claimNext(f.db, caps, 'demo', at, true);
  assert.ok(claimed);
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
  recoverQueue(f.db);
  recoverQueue(f.db);
  assert.equal(one(f.db, 'SELECT status FROM attempts').status, 'unknown');
  assert.equal(one(f.db, 'SELECT state FROM enrollments').state, 'stopped');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 1);
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
});
test('a large group blocked by one in-flight contact cannot starve later independent recipients', (t) => {
  const rows = Array.from({ length: 1001 }, (_, i) => [
    `BR-${i}`,
    'Contato compartilhado',
    '11987654321',
    '',
    '10',
    '',
  ]);
  rows.push(['BR-independent', 'Pessoa independente', '21987654321', '', '10', '']);
  const f = fixture(t, rows);
  campaign(f);
  const first = claimNext(f.db, caps, 'demo', at);
  assert.equal(first.c.phone, '+5511987654321');
  assert.equal(claimNext(f.db, caps, 'demo', at), null);
  const independent = claimNext(f.db, caps, 'demo', new Date(at.getTime() + 3000));
  assert.equal(independent.c.phone, '+5521987654321');
});
test('fallback skips absent contacts and unavailable WhatsApp; elapsed waiting moves to next channel', (t) => {
  const f = fixture(t, [['BR-1', 'Ana', '', 'ana@example.test', '10', '']]);
  campaign(f, ['whatsapp', 'voice', 'email']);
  const a = claimNext(f.db, caps, 'demo', at, true);
  assert.equal(a.attempt.channel, 'email');
  assert.equal(a.attempt.step, 2);
  finishDispatch(f.db, a.attempt, { status: 'delivered' });
  advanceWaiting(f.db, new Date(at.getTime() + 1000));
  assert.equal(one(f.db, 'SELECT state FROM enrollments').state, 'waiting');
  advanceWaiting(f.db, new Date(at.getTime() + 86400000));
  assert.equal(claimNext(f.db, caps, 'demo', new Date(at.getTime() + 86400000), true), null);
  assert.equal(one(f.db, 'SELECT outcome FROM attempts').outcome, 'not_reached');
  assert.equal(one(f.db, 'SELECT state FROM enrollments').state, 'completed');
});
test('shared addresses have a global contact gap and opt-out stops all related cases', (t) => {
  const f = fixture(t, [
    ['BR-1', 'Ana', '11987654321', 'ana@example.test', '10', ''],
    ['BR-2', 'Ana', '11987654321', '', '20', ''],
  ]);
  campaign(f);
  const first = claimNext(f.db, caps, 'demo', at);
  assert.ok(first);
  assert.equal(claimNext(f.db, caps, 'demo', at), null);
  finishDispatch(f.db, first.attempt, { status: 'delivered' });
  assert.equal(claimNext(f.db, caps, 'demo', new Date(at.getTime() + 3600000)), null);
  recordOutcome(f.db, first.c.id, { outcome: 'opt_out' });
  assert.ok(all(f.db, 'SELECT suppressed FROM cases').every((c) => c.suppressed === 1));
  assert.ok(all(f.db, 'SELECT state FROM enrollments').every((e) => e.state === 'stopped'));
  assert.equal(claimNext(f.db, caps, 'demo', new Date(at.getTime() + 86400000), true), null);
});
test('campaign rejects foreign case ids and duplicate active enrollment transactionally', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      createCampaign(
        f.db,
        { name: 'Bad', portfolioId: f.portfolio.id, channels: ['sms'], caseIds: ['missing'] },
        'demo',
      ),
    /outside/,
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM campaigns').n, 0);
  campaign(f);
  assert.throws(() => campaign(f), /another campaign/i);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM campaigns').n, 1);
});
test('payment claims remain unconfirmed and create one high-priority human task', (t) => {
  const f = fixture(t);
  campaign(f);
  const a = claimNext(f.db, caps, 'demo', at, true);
  finishDispatch(f.db, a.attempt, { status: 'delivered' });
  for (let i = 0; i < 2; i++)
    recordOutcome(f.db, a.c.id, { outcome: 'paid_reported', note: 'Já paguei.' });
  const c = one(f.db, 'SELECT * FROM cases');
  assert.equal(c.amount_minor, 123456);
  assert.equal(c.status, 'review');
  assert.equal(c.outcome, 'paid_reported');
  assert.equal(dashboard(f.db, 'demo').rightParty, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 1);
  assert.equal(one(f.db, 'SELECT priority FROM tasks').priority, 'high');
});
test('provider status is monotonic, replay safe and bound to original provider identifier', (t) => {
  const f = fixture(t);
  campaign(f, ['sms'], 'live');
  const { attempt } = claimNext(f.db, capabilities(liveConfig()), 'live', at, true);
  providerStatus(f.db, attempt.id, 'SM1', 'delivered');
  finishDispatch(f.db, attempt, { status: 'queued', sid: 'SM1' });
  assert.equal(one(f.db, 'SELECT status FROM attempts').status, 'delivered');
  assert.deepEqual(providerStatus(f.db, attempt.id, 'SM1', 'delivered'), { duplicate: true });
  assert.deepEqual(providerStatus(f.db, attempt.id, 'SM1', 'sent'), { ignored: true });
  assert.throws(() => providerStatus(f.db, attempt.id, 'SM2', 'read'), /mismatch/i);
});
test('inbound response is correlated once, opt-out blocks future outreach, failed receipt can retry', (t) => {
  const f = fixture(t);
  campaign(f, ['sms'], 'live');
  const { attempt } = claimNext(f.db, capabilities(liveConfig()), 'live', at, true);
  finishDispatch(f.db, attempt, { status: 'sent', sid: 'SM1' });
  const input = { key: 'IN1', from: '+5511987654321', text: 'SAIR', channel: 'sms' };
  assert.deepEqual(inboundMessage(f.db, input), { matched: 1 });
  assert.deepEqual(inboundMessage(f.db, input), { duplicate: true });
  assert.equal(one(f.db, 'SELECT suppressed FROM cases').suppressed, 1);
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM events WHERE kind='inbound_message'").n, 1);
  assert.throws(
    () =>
      receiveOnce(f.db, 'retry', () => {
        throw new Error('rollback');
      }),
    /rollback/,
  );
  assert.equal(
    receiveOnce(f.db, 'retry', () => 42),
    42,
  );
});
test('suppression survives reimport under a new reference and prevents scheduling', (t) => {
  const f = fixture(t);
  recordOutcome(f.db, f.cases[0].id, { outcome: 'opt_out' });
  const s = stage(f.db, f.portfolio.id, [['REIMPORT', 'Ana', '11987654321', '', '15', '']]);
  commitImport(f.db, s.id, suggestMapping(JSON.parse(s.headers)), [2]);
  const c = one(f.db, "SELECT * FROM cases WHERE reference='REIMPORT'");
  assert.equal(c.suppressed, 1);
  const cp = createCampaign(
    f.db,
    { name: 'Retry', portfolioId: f.portfolio.id, caseIds: [c.id], channels: ['sms'] },
    'demo',
  );
  campaignAction(f.db, cp.id, 'start');
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
  assert.equal(one(f.db, 'SELECT state FROM enrollments WHERE case_id=?', c.id).state, 'stopped');
});
test('callback requests stop automatic attempts and keep their due date in the human queue', (t) => {
  const f = fixture(t);
  campaign(f);
  const { attempt, c } = claimNext(f.db, caps, 'demo', at, true);
  const callbackAt = new Date(Date.now() + 86400000).toISOString();
  recordOutcome(f.db, c.id, { outcome: 'callback', callbackAt }, 'operator', attempt.id);
  // In-flight HTTP completion must not reopen outreach after a response arrived.
  finishDispatch(f.db, attempt, { status: 'completed', sid: 'demo-callback' });
  assert.equal(one(f.db, 'SELECT state FROM enrollments').state, 'stopped');
  assert.equal(one(f.db, 'SELECT due_at FROM tasks').due_at, callbackAt);
  assert.equal(claimNext(f.db, caps, 'demo', at, true), null);
});
