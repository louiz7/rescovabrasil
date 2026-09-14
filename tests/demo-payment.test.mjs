import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedDatabase, executeTestTool } from '../server/browser-voice.mjs';
import {
  demoPaymentOffers,
  executePaymentSolution,
  paymentDemoContext,
} from '../server/demo-payment.mjs';
import { openDb, one, run } from '../server/db.mjs';
import { recordOutcome } from '../server/service.mjs';
function setup(t) {
  const db = isolatedDatabase('payment-test');
  t.after(() => db.close());
  return { db, caseId: one(db, 'SELECT case_id FROM attempts').case_id };
}
function confirm(db) {
  return executeTestTool(db, 'payment-test', 'confirm_identity', {
    confirmed: true,
    name: 'Ana Silva',
  });
}
const agree = (db, offerId = 'three_installments', extra = {}) =>
  executePaymentSolution(db, 'payment-test', { offerId, accepted: true, ...extra });

test('demo offers are fixed, exact centavo totals and anchored calendar dates do not drift', (t) => {
  const { db } = setup(t);
  run(db, 'UPDATE attempts SET created_at=?', '2028-01-25T01:00:00Z'); // Jan 24 in Sao Paulo; first installment Jan31.
  const context = paymentDemoContext(db, 'payment-test');
  assert.equal(context.agreement, null);
  for (const offer of context.offers) {
    assert.equal(
      offer.installments.reduce((sum, x) => sum + x.amountMinor, 0),
      offer.totalMinor,
    );
    assert.equal(offer.demo, true);
  }
  assert.equal(context.offers[0].totalMinor, 112500);
  assert.equal(context.offers[0].expiresOn, '2028-01-24');
  assert.equal(context.offers[0].installments[0].dueDate, '2028-01-24');
  assert.deepEqual(
    context.offers[1].installments.map((x) => x.dueDate),
    ['2028-01-31', '2028-02-29', '2028-03-31'],
  );
  assert.deepEqual(
    context.offers[2].installments.map((x) => x.amountMinor),
    [20834, 20834, 20833, 20833, 20833, 20833],
  );
  run(db, 'UPDATE attempts SET created_at=?', '2028-02-20T12:00:00Z');
  assert.deepEqual(paymentDemoContext(db, 'payment-test'), context);
  assert.ok(Object.isFrozen(demoPaymentOffers[0].installments));
});
test('agreement requires confirmed self-report, explicit consent and fixed server terms; never clears balance', (t) => {
  const { db } = setup(t);
  assert.throws(() => agree(db), /Confirm the speaker name/);
  confirm(db);
  assert.throws(() => agree(db, 'three_installments', { accepted: false }), /Explicit consent/);
  assert.throws(() => agree(db, 'three_installments', { accepted: 'true' }), /Explicit consent/);
  assert.throws(() => agree(db, 'three_installments', { totalMinor: 1 }), /Only a fixed/);
  assert.throws(() => agree(db, 'arbitrary_offer'), /not authorized/);
  const result = agree(db);
  assert.equal(result.agreed, true);
  assert.equal(result.agreement.demo, true);
  assert.equal(result.agreement.acceptance, 'self_reported_explicit_consent');
  assert.equal(result.agreement.totalMinor, 125000);
  assert.deepEqual(agree(db), result);
  assert.deepEqual(paymentDemoContext(db, 'payment-test').agreement, result.agreement);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM demo_payment_agreements').n, 1);
  assert.equal(one(db, 'SELECT amount_minor FROM cases').amount_minor, 125000);
  assert.equal(one(db, 'SELECT outcome FROM cases').outcome, null);
});
test('changing an agreed offer requires human review and preserves original agreement', (t) => {
  const { db } = setup(t);
  confirm(db);
  const original = agree(db, 'three_installments');
  const conflict = agree(db, 'six_installments');
  assert.equal(conflict.agreed, false);
  assert.equal(conflict.next, 'human_review');
  assert.deepEqual(conflict.agreement, original.agreement);
  assert.equal(one(db, 'SELECT review_required FROM cases').review_required, 1);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM tasks').n, 1);
  assert.deepEqual(agree(db, 'three_installments'), original);
  assert.equal(one(db, 'SELECT amount_minor FROM cases').amount_minor, 125000);
});
test('normal willingness or payment difficulty allows demo plans; disputes, opt-out and payment claims block them', (t) => {
  for (const outcome of [
    'willing_to_pay',
    'unable_to_pay',
    'callback',
    'disputed',
    'human_review',
    'paid_reported',
    'opt_out',
  ]) {
    const db = isolatedDatabase('payment-test');
    try {
      confirm(db);
      const c = one(db, 'SELECT case_id FROM attempts');
      recordOutcome(
        db,
        c.case_id,
        {
          outcome,
          note: 'Explicit outcome',
          ...(outcome === 'callback'
            ? { callbackAt: new Date(Date.now() + 86400000).toISOString() }
            : {}),
        },
        'demo',
        'payment-test',
      );
      if (['willing_to_pay', 'unable_to_pay', 'callback'].includes(outcome))
        assert.equal(agree(db).agreed, true);
      else assert.throws(() => agree(db), /stopped|human review/);
    } finally {
      db.close();
    }
  }
});
test('expired offers, wrong fixture, live attempts and file databases cannot accept demo agreements', (t) => {
  const { db } = setup(t);
  run(db, "UPDATE attempts SET created_at='2020-01-01T12:00:00Z'");
  confirm(db);
  assert.throws(() => agree(db, 'upfront_10_percent'), /expired/);
  run(db, "UPDATE attempts SET mode='live'");
  assert.throws(() => paymentDemoContext(db, 'payment-test'), /isolated demo voice/);
  run(db, "UPDATE attempts SET mode='demo'");
  run(db, "UPDATE cases SET reference='REAL-CASE'");
  assert.throws(() => paymentDemoContext(db, 'payment-test'), /no authorized demo/);
  const dir = mkdtempSync(join(tmpdir(), 'rescova-payment-'));
  const fileDb = openDb(join(dir, 'production.sqlite'));
  try {
    assert.throws(() => paymentDemoContext(fileDb, 'payment-test'), /in-memory demo/);
  } finally {
    fileDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
