import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, run } from '../server/db.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { lookupCaseInformation } from '../server/case-context.mjs';
import { agentTaskList } from '../server/agent-task-list.mjs';
import { createAgentRunner } from '../server/agent-models.mjs';

test('payment lookup distinguishes missing ledger evidence from zero debt and requires a real case', () => {
  const db = openDb();
  try {
    const { caseId } = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'payment-lookup' },
    );
    const result = lookupCaseInformation(db, caseId, { topic: 'payment_status' });
    assert.deepEqual(result.items, []);
    assert.match(result.missing[0], /does not establish/);
    assert.match(result.evidencePolicy, /Simulation events are not real receipts/);
    assert.match(result.evidencePolicy, /No live payment-provider verification/);
    assert.equal(
      lookupCaseInformation(db, caseId, { topic: 'payment_terms' }).paymentStateLookup,
      'payment_status',
    );
    assert.throws(() => lookupCaseInformation(db, 'another-case', { topic: 'payment_status' }), {
      status: 404,
    });
  } finally {
    db.close();
  }
});

test('payment tasks preserve ownership, scheduling, simulation and case navigation in the work queue', () => {
  const db = openDb();
  try {
    const { caseId } = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'payment-projection' },
    );
    // Minimal provider-independent projection contract; no payment-provider side effects.
    db.exec(`CREATE TABLE IF NOT EXISTS payment_tasks (
      id TEXT PRIMARY KEY, case_id TEXT, agreement_id TEXT, installment_id TEXT,
      kind TEXT, owner TEXT, status TEXT, channel TEXT, due_at TEXT, next_action TEXT,
      message_id TEXT, created_at TEXT, updated_at TEXT
    )`);
    for (const [id, owner, status, nextAction] of [
      ['pay-wait', 'Rafael', 'waiting_information', 'Check authoritative receipt evidence'],
      ['pay-done', 'Marina', 'simulated_completed', ''],
    ])
      run(
        db,
        `INSERT INTO payment_tasks (id,case_id,kind,owner,status,channel,due_at,next_action,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id,
        caseId,
        'payment_reconciliation',
        owner,
        status,
        'sms',
        '2026-10-01',
        nextAction,
        '2026-09-16',
        '2026-09-16',
      );
    const open = agentTaskList(db).rows.filter((row) => row.source === 'payment_task');
    assert.equal(open.length, 1);
    assert.equal(open[0].owner, 'Rafael');
    assert.equal(open[0].case_id, caseId);
    assert.equal(open[0].conversation_id, null);
    assert.equal(open[0].due_at, '2026-10-01');
    assert.equal(open[0].next_action, 'Check authoritative receipt evidence');
    const complete = agentTaskList(db, { state: 'completed' }).rows.find(
      (row) => row.source === 'payment_task',
    );
    assert.equal(complete.owner, 'Marina');
    assert.match(complete.next_action, /no real payment/);
  } finally {
    db.close();
  }
});

test('Marina and Rafael can request payment evidence without monetary mutation tools', async () => {
  for (const supervisor of [false, true]) {
    let body;
    const runner = createAgentRunner(
      { openaiKey: 'test-only' },
      {
        fetchImpl: async (_url, init) => {
          body = JSON.parse(init.body);
          return new Response(
            JSON.stringify({
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify({
                        action: 'lookup_case_information',
                        text: '',
                        reason: 'Check current recorded installment payment.',
                        lookupTopic: 'payment_status',
                        lookupDocumentId: null,
                        lookupOffset: 0,
                        lookupQuery: null,
                        offerId: null,
                        acceptanceQuote: null,
                        presentedOfferIds: [],
                      }),
                    },
                  ],
                },
              ],
            }),
          );
        },
      },
    );
    const result = await runner({
      context: {},
      messages: [{ role: 'user', content: 'Is my first installment paid?' }],
      supervisor,
    });
    assert.equal(result.lookupTopic, 'payment_status');
    assert.ok(body.text.format.schema.properties.lookupTopic.enum.includes('payment_status'));
    assert.match(body.instructions, /retrieve payment_status for this turn/);
    assert.match(body.instructions, /Never write balances or payment states/);
    assert.ok(!body.text.format.schema.properties.action.enum.includes('mark_paid'));
  }
});

test('voice payment context is identity-gated, bounded and excludes provider diagnostics', async () => {
  const { withPaymentStatus } = await import('../server/browser-voice.mjs');
  let calls = 0;
  const read = ({ sessionId }) => {
    calls++;
    assert.equal(sessionId, 'voice-case');
    return {
      summary: { currency: 'BRL', receivedMinor: 1000, remainingMinor: 2000, mode: 'simulation' },
      payments: [{ provider_secret: 'must-not-leak' }],
      tasks: [{ internal_note: 'must-not-leak' }],
      agreements: Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        currency: 'BRL',
        total_minor: 3000,
        status: 'partially_paid',
        installments: Array.from({ length: 13 }, (_, sequence) => ({
          sequence,
          amount_minor: 1000,
          due_date: '2026-10-01',
          paidMinor: 1000,
          remainingMinor: 0,
          status: 'paid',
          request: { provider_secret: 'must-not-leak' },
        })),
      })),
    };
  };
  assert.deepEqual(
    withPaymentStatus({ confirmed: false }, 'get_test_context', 'voice-case', read),
    { confirmed: false },
  );
  assert.deepEqual(withPaymentStatus({ confirmed: true }, 'confirm_identity', 'voice-case', read), {
    confirmed: true,
  });
  assert.equal(calls, 0);
  const result = withPaymentStatus({ confirmed: true }, 'get_test_context', 'voice-case', read);
  assert.equal(calls, 1);
  assert.equal(result.paymentStatus.summary.receivedMinor, 1000);
  assert.equal(result.paymentStatus.agreements.length, 5);
  assert.equal(result.paymentStatus.agreements[0].installments.length, 12);
  assert.equal(result.paymentStatus.agreementsTruncated, true);
  assert.equal(result.paymentStatus.agreements[0].installmentsTruncated, true);
  assert.match(result.paymentStatus.evidencePolicy, /not real payments/);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
  const failed = withPaymentStatus({ confirmed: true }, 'get_test_context', 'voice-case', () => {
    throw new Error('private failure');
  });
  assert.equal(failed.confirmed, true);
  assert.equal(failed.paymentStatus.available, false);
  assert.doesNotMatch(JSON.stringify(failed), /private failure/);
});
