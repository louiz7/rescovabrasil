import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { isolatedDatabase, executeTestTool } from '../server/browser-voice.mjs';
import { executePaymentSolution } from '../server/demo-payment.mjs';
import {
  persistDemoAgreement,
  getCasePaymentData,
  updatePaymentFollowup,
  syncDemoOutcome,
} from '../server/demo-platform.mjs';
import { all, one } from '../server/db.mjs';
import { suppressionReason } from '../server/service.mjs';
function agreement(t) {
  const db = isolatedDatabase('platform-voice');
  t.after(() => db.close());
  executeTestTool(db, 'platform-voice', 'confirm_identity', { confirmed: true, name: 'Ana Silva' });
  return executePaymentSolution(db, 'platform-voice', {
    offerId: 'three_installments',
    accepted: true,
  }).agreement;
}
const config = { mode: 'demo', allowlist: ['+5511987654321'] };

test('accepted demo voice agreement becomes one protected platform case, task and nonpayable email draft', (t) => {
  const f = fixture(t),
    value = agreement(t),
    sessionId = randomUUID(),
    input = { provider: 'grok', sessionId, agreement: value };
  const result = persistDemoAgreement(f.db, config, input);
  assert.equal(result.reference, 'DEMO-' + sessionId);
  assert.equal(result.jobStatus, 'draft');
  assert.ok(result.caseId && result.taskId && result.jobId);
  assert.deepEqual(persistDemoAgreement(f.db, config, input), result);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM cases').n, 2);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_followup_jobs').n, 1);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 1);
  const c = one(f.db, 'SELECT * FROM cases WHERE id=?', result.caseId);
  assert.equal(c.name, 'Ana Silva');
  assert.equal(c.amount_minor, 125000);
  assert.equal(c.review_required, 1);
  assert.equal(c.status, 'review');
  assert.equal(c.email, 'ana.silva@example.invalid');
  assert.ok(suppressionReason(f.db, c));
  const payment = getCasePaymentData(f.db, result.caseId);
  assert.equal(payment.paymentAgreements[0].id, value.id);
  assert.equal(payment.paymentAgreements[0].provider, 'grok');
  const job = payment.paymentFollowups[0];
  assert.equal(job.channel, 'email');
  assert.equal(job.destination, 'ana.silva@example.invalid');
  assert.match(job.message, /DEMO/);
  assert.match(job.message, /payments\.example\.invalid/);
  assert.match(job.message, /DEMO-PIX-NOT-PAYABLE/);
  assert.ok(job.message.includes(value.installments[0].dueDate));
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM enrollments').n, 0);
});
test('only an authorized Twilio test number can become the SMS draft destination', (t) => {
  const f = fixture(t),
    value = agreement(t),
    base = { sessionId: randomUUID(), agreement: value, destination: '+5511987654321' };
  assert.throws(
    () => persistDemoAgreement(f.db, config, { ...base, provider: 'openai' }),
    /Only an authorized Twilio/,
  );
  assert.throws(
    () =>
      persistDemoAgreement(f.db, config, {
        ...base,
        provider: 'twilio',
        destination: '+5511987650000',
      }),
    /Only an authorized Twilio/,
  );
  const result = persistDemoAgreement(f.db, config, { ...base, provider: 'twilio' });
  const job = getCasePaymentData(f.db, result.caseId).paymentFollowups[0];
  assert.equal(job.channel, 'sms');
  assert.equal(job.destination, base.destination);
  assert.equal(job.status, 'draft');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
});
test('operator can prepare SMS/email previews, missing inputs block drafts, cancellation cannot send', (t) => {
  const f = fixture(t),
    value = agreement(t),
    result = persistDemoAgreement(f.db, config, {
      provider: 'openai',
      sessionId: randomUUID(),
      agreement: value,
    });
  let job = updatePaymentFollowup(f.db, config, result.jobId, { paymentDetails: '' });
  assert.equal(job.status, 'blocked_missing_payment_details');
  assert.match(job.message, /Payment details are missing/);
  job = updatePaymentFollowup(f.db, config, result.jobId, { channel: 'sms', destination: '' });
  assert.equal(job.status, 'blocked_missing_contact');
  assert.throws(
    () => updatePaymentFollowup(f.db, config, result.jobId, { channel: 'whatsapp' }),
    /WhatsApp/,
  );
  assert.throws(
    () =>
      updatePaymentFollowup(f.db, config, result.jobId, { channel: 'sms', destination: 'invalid' }),
    /valid destination/,
  );
  assert.throws(
    () => updatePaymentFollowup(f.db, config, result.jobId, { status: 'sent' }),
    /sending is not available/,
  );
  assert.throws(
    () => updatePaymentFollowup(f.db, config, result.jobId, { paymentDetails: 'x'.repeat(2001) }),
    /2,000/,
  );
  job = updatePaymentFollowup(f.db, config, result.jobId, {
    channel: 'email',
    destination: 'TEST@example.invalid',
    paymentDetails: 'Demo payment instructions only.',
  });
  assert.equal(job.destination, 'test@example.invalid');
  assert.equal(job.status, 'draft');
  assert.match(job.message, /Demo payment instructions only/);
  job = updatePaymentFollowup(f.db, config, result.jobId, { status: 'cancelled' });
  assert.equal(job.status, 'cancelled');
  assert.throws(
    () => updatePaymentFollowup(f.db, config, result.jobId, { paymentDetails: 'reopen' }),
    /cannot be reopened/,
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  assert.equal(
    one(f.db, 'SELECT amount_minor FROM cases WHERE id=?', result.caseId).amount_minor,
    125000,
  );
});
test('live mode, altered monetary terms and conflicting source agreements cannot create or overwrite records', (t) => {
  const f = fixture(t),
    value = agreement(t),
    input = { provider: 'openai', sessionId: randomUUID(), agreement: value };
  assert.throws(() => persistDemoAgreement(f.db, { mode: 'live' }, input), /live workspaces/);
  assert.throws(
    () => persistDemoAgreement(f.db, config, { ...input, agreement: { ...value, totalMinor: 1 } }),
    /authorized demo offer/,
  );
  assert.throws(
    () => persistDemoAgreement(f.db, config, { ...input, agreement: { ...value, demo: false } }),
    /fictional demo agreement/,
  );
  assert.throws(
    () =>
      persistDemoAgreement(f.db, config, {
        ...input,
        agreement: {
          ...value,
          installments: value.installments.map((p, i) => ({
            ...p,
            amountMinor: i === 0 ? 1 : p.amountMinor,
          })),
        },
      }),
    /installment terms/,
  );
  const saved = persistDemoAgreement(f.db, config, input),
    before = JSON.stringify(getCasePaymentData(f.db, saved.caseId));
  assert.throws(
    () =>
      persistDemoAgreement(f.db, config, { ...input, agreement: { ...value, id: randomUUID() } }),
    /different saved agreement/,
  );
  assert.equal(JSON.stringify(getCasePaymentData(f.db, saved.caseId)), before);
  assert.throws(
    () => updatePaymentFollowup(f.db, { mode: 'live' }, saved.jobId, {}),
    /live workspaces/,
  );
  assert.equal(all(f.db, 'SELECT * FROM demo_voice_results').length, 1);
});

test('a later demo opt-out suppresses the saved case and cancels its pending follow-up', (t) => {
  const f = fixture(t),
    value = agreement(t),
    sessionId = randomUUID();
  assert.equal(
    syncDemoOutcome(f.db, config, {
      sessionId,
      provider: 'grok',
      args: { outcome: 'opt_out', note: 'Stop' },
    }),
    null,
  );
  const saved = persistDemoAgreement(f.db, config, {
    sessionId,
    provider: 'grok',
    agreement: value,
  });
  const related = persistDemoAgreement(f.db, config, {
    sessionId: randomUUID(),
    provider: 'grok',
    agreement: agreement(t),
  });
  const synced = syncDemoOutcome(f.db, config, {
    sessionId,
    provider: 'grok',
    args: { outcome: 'opt_out', note: 'Speaker withdrew permission for further contact.' },
  });
  assert.equal(synced.caseId, saved.caseId);
  assert.equal(synced.jobStatus, 'cancelled');
  assert.equal(getCasePaymentData(f.db, related.caseId).paymentFollowups[0].status, 'cancelled');
  const c = one(f.db, 'SELECT * FROM cases WHERE id=?', saved.caseId);
  assert.equal(c.suppressed, 1);
  assert.equal(c.outcome, 'opt_out');
  assert.equal(c.amount_minor, 125000);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  assert.throws(
    () => updatePaymentFollowup(f.db, config, saved.jobId, { paymentDetails: 'Resume' }),
    /cannot be reopened/,
  );
  assert.equal(getCasePaymentData(f.db, saved.caseId).paymentAgreements[0].id, value.id);
});
