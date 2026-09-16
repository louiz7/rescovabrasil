import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, one, all, run, now } from '../server/db.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import {
  registerPaymentAgreement,
  createPaymentService,
  getPaymentState,
} from '../server/payments.mjs';
import {
  createSimulatorPaymentProvider,
  validatePaymentProvider,
} from '../server/payment-provider.mjs';

async function fixture(t, backend, options = {}) {
  let db, admin, schema;
  if (backend === 'postgres') {
    admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
    schema = 'payments_' + process.pid + '_' + Math.random().toString(36).slice(2);
    admin.query('CREATE SCHEMA ' + schema);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', '-csearch_path=' + schema);
    db = openDb(url.href);
  } else db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true };
  const { caseId } = ensureDemoVoiceCase(db, config, {
    provider: 'openai',
    sessionId: 'payment-test',
  });
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async () => {
      throw new Error('Payment accounting must not call a model.');
    },
  });
  const agreement = {
    id: 'agreement-one',
    demo: true,
    currency: 'BRL',
    totalMinor: 30000,
    timezone: 'America/Sao_Paulo',
    installments: [
      { amountMinor: 10000, dueDate: '2030-01-15' },
      { amountMinor: 10000, dueDate: '2030-02-15' },
      { amountMinor: 10000, dueDate: '2030-03-15' },
    ],
  };
  const service = createPaymentService(db, config, options);
  t.after(async () => {
    await workflow.closeAll();
    await workflow.library.closeIngestion();
    db.close();
    if (admin) {
      admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      admin.close();
    }
  });
  registerPaymentAgreement(db, caseId, agreement);
  run(
    db,
    'INSERT INTO agent_conversations (id,case_id,agreement_id,provider,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    'conversation-one',
    caseId,
    agreement.id,
    'openai',
    'payment-test',
    'active',
    now(),
    now(),
  );
  const request = () => getPaymentState(db, caseId).agreements[0].installments[0].request;
  return {
    db,
    caseId,
    config,
    agreement,
    service,
    request,
    end: () =>
      run(
        db,
        'INSERT OR IGNORE INTO agent_source_ends VALUES (?,?,?)',
        'openai',
        'payment-test',
        now(),
      ),
    event: (patch = {}) =>
      service.applyEvent(caseId, {
        eventId: 'event-one',
        paymentId: 'payment-one',
        version: 1,
        requestId: request().id,
        currency: 'BRL',
        amountMinor: 10000,
        status: 'succeeded',
        ...patch,
      }),
    messages: () => all(db, 'SELECT * FROM agent_messages ORDER BY rowid'),
  };
}
const backends = process.env.TEST_DATABASE_URL ? ['sqlite', 'postgres'] : ['sqlite'];
for (const backend of backends) {
  test(`${backend}: agreement registration is idempotent and creates nonpayable requests`, async (t) => {
    const f = await fixture(t, backend);
    registerPaymentAgreement(f.db, f.caseId, f.agreement);
    assert.equal(f.service.state(f.caseId).agreements[0].installments.length, 3);
    assert.equal(f.service.state(f.caseId).summary.remainingMinor, 30000);
    assert.throws(
      () => registerPaymentAgreement(f.db, f.caseId, { ...f.agreement, id: 'another' }),
      /different collection agreement/,
    );
    await f.service.tick({ caseId: f.caseId, date: '2030-01-01' });
    assert.equal(f.request().status, 'ready');
    assert.match(f.request().url, /^https:\/\/payments\.example\.invalid\//);
    assert.equal(f.messages().length, 0);
  });
  test(`${backend}: invalid installment schedules roll back without partial financial records`, async (t) => {
    const f = await fixture(t, backend);
    const other = ensureDemoVoiceCase(f.db, f.config, {
      provider: 'openai',
      sessionId: 'invalid-plan',
    });
    assert.throws(
      () =>
        registerPaymentAgreement(f.db, other.caseId, {
          ...f.agreement,
          id: 'bad-total',
          totalMinor: 30001,
        }),
      /Invalid agreement total/,
    );
    assert.throws(
      () =>
        registerPaymentAgreement(f.db, other.caseId, {
          ...f.agreement,
          id: 'bad-date',
          installments: [
            f.agreement.installments[0],
            { amountMinor: 20000, dueDate: 'not-a-date' },
          ],
        }),
      /Invalid|date/i,
    );
    assert.equal(f.service.state(other.caseId).agreements.length, 0);
    assert.equal(
      one(f.db, 'SELECT COUNT(*) n FROM payment_requests WHERE case_id=?', other.caseId).n,
      0,
    );
    assert.equal(
      one(f.db, 'SELECT COUNT(*) n FROM payment_tasks WHERE case_id=?', other.caseId).n,
      0,
    );
  });
  test(`${backend}: duplicate and older events cannot double count or roll back settled money`, async (t) => {
    const f = await fixture(t, backend);
    f.event({ version: 2 });
    f.event({ version: 2 });
    let state = f.event({ eventId: 'older', version: 1, status: 'processing' });
    assert.equal(state.summary.receivedMinor, 10000);
    assert.equal(state.summary.remainingMinor, 20000);
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_events').n, 2);
    assert.equal(
      one(f.db, "SELECT status FROM payment_events WHERE event_id='older'").status,
      'ignored_stale',
    );
    assert.throws(() => f.event({ version: 2, amountMinor: 9000 }), /Conflicting duplicate/);
    assert.throws(
      () => f.event({ eventId: 'conflict', version: 2, status: 'processing' }),
      /Conflicting payment snapshot/,
    );
    assert.throws(
      () => f.event({ eventId: 'regress', version: 3, status: 'failed' }),
      /explicit refund or reversal/,
    );
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_events').n, 2);
  });
  test(`${backend}: processing and failed payments do not reduce receivables; settlement cancels the matching reminder`, async (t) => {
    const f = await fixture(t, backend);
    f.end();
    f.event({ status: 'processing' });
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    assert.equal(f.service.state(f.caseId).summary.receivedMinor, 0);
    assert.equal(f.messages().filter((m) => m.body.includes('remains due')).length, 0);
    f.event({ eventId: 'failed', version: 2, status: 'failed' });
    assert.equal(f.service.state(f.caseId).summary.remainingMinor, 30000);
    f.event({ eventId: 'settled', version: 3 });
    const reminders = f.service.state(f.caseId).tasks.filter((t) => t.kind === 'reminder');
    assert.equal(reminders.filter((t) => t.status === 'cancelled').length, 1);
    assert.equal(reminders.filter((t) => t.status === 'queued').length, 2);
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    assert.equal(f.messages().filter((m) => m.body.includes('remains due')).length, 0);
  });
  test(`${backend}: partial payments, refunds and reversal recompute allocations and reopen unpaid reminders`, async (t) => {
    const f = await fixture(t, backend);
    let state = f.event({ amountMinor: 4000 });
    assert.equal(state.agreements[0].installments[0].status, 'partial');
    assert.equal(state.summary.remainingMinor, 26000);
    state = f.event({ eventId: 'second', paymentId: 'payment-two', amountMinor: 6000 });
    assert.equal(state.agreements[0].installments[0].status, 'paid');
    state = f.event({
      eventId: 'refund',
      version: 2,
      status: 'refunded',
      amountMinor: 4000,
      refundedMinor: 2000,
    });
    assert.equal(state.summary.receivedMinor, 8000);
    assert.equal(state.summary.remainingMinor, 22000);
    assert.equal(
      state.tasks.find(
        (t) => t.kind === 'reminder' && t.installment_id === state.agreements[0].installments[0].id,
      ).status,
      'queued',
    );
    state = f.event({ eventId: 'reversal', version: 3, status: 'reversed', amountMinor: 4000 });
    assert.equal(state.summary.receivedMinor, 6000);
    assert.equal(state.summary.remainingMinor, 24000);
    assert.equal(
      state.tasks.filter((t) => t.kind === 'payment_update' && t.status !== 'cancelled').length,
      1,
    );
  });
  test(`${backend}: overpayment stays unallocated, holds collection and opens Rafael reconciliation`, async (t) => {
    const f = await fixture(t, backend);
    f.end();
    const state = f.event({ amountMinor: 12000 });
    assert.equal(state.summary.unallocatedMinor, 2000);
    assert.equal(state.summary.remainingMinor, 20000);
    assert.equal(state.agreements[0].installments[1].paidMinor, 0);
    const task = state.tasks.find((t) => t.kind === 'reconciliation');
    assert.equal(task.owner, 'Rafael');
    assert.equal(task.status, 'waiting_information');
    await f.service.tick({ caseId: f.caseId, date: '2030-02-15' });
    assert.equal(f.messages().length, 1);
    assert.match(f.messages()[0].body, /Unallocated credit: BRL 20.00/);
    assert.equal(
      f.service
        .state(f.caseId)
        .tasks.filter((t) => t.kind === 'reminder' && t.status === 'simulated_completed').length,
      0,
    );
    const cleared = f.event({
      eventId: 'excess-refunded',
      version: 2,
      status: 'refunded',
      amountMinor: 12000,
      refundedMinor: 2000,
    });
    assert.equal(cleared.summary.unallocatedMinor, 0);
    assert.equal(
      cleared.tasks.find((t) => t.kind === 'reconciliation').status,
      'simulated_completed',
    );
  });
  test(`${backend}: reconciliation reopens when new excess arrives after a prior excess was cleared`, async (t) => {
    const f = await fixture(t, backend);
    f.event({ amountMinor: 12000 });
    f.event({
      eventId: 'excess-refunded',
      version: 2,
      status: 'refunded',
      amountMinor: 12000,
      refundedMinor: 2000,
    });
    const state = f.event({ eventId: 'new-excess', paymentId: 'extra-payment', amountMinor: 1000 });
    assert.equal(state.summary.unallocatedMinor, 1000);
    assert.equal(
      state.tasks.find((t) => t.kind === 'reconciliation').status,
      'waiting_information',
    );
  });
  test(`${backend}: wrong currency, cross-case requests, conflicting payment ownership and malformed amounts are rejected`, async (t) => {
    const f = await fixture(t, backend);
    assert.throws(() => f.event({ currency: 'USD' }), /currency/);
    for (const amountMinor of [0, -1, 1.1, Number.MAX_SAFE_INTEGER])
      assert.throws(() => f.event({ amountMinor }), /amount or currency/);
    assert.throws(() => f.event({ requestId: 'not-this-case' }), /Unknown payment request/);
    f.event();
    const other = ensureDemoVoiceCase(f.db, f.config, {
      provider: 'openai',
      sessionId: 'other-debtor',
    });
    registerPaymentAgreement(f.db, other.caseId, { ...f.agreement, id: 'other-agreement' });
    const requestId = f.service.state(other.caseId).agreements[0].installments[0].request.id;
    assert.throws(() => f.event({ requestId }), /Unknown payment request/);
    assert.throws(
      () =>
        f.service.applyEvent(other.caseId, {
          eventId: 'other-event',
          paymentId: 'payment-one',
          version: 2,
          requestId,
          currency: 'BRL',
          amountMinor: 10000,
          status: 'succeeded',
        }),
      /different request/,
    );
    assert.equal(f.service.state(other.caseId).summary.receivedMinor, 0);
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_events').n, 1);
  });
  test(`${backend}: outbound reminders wait for source call completion, respect suppression and deliver once`, async (t) => {
    const f = await fixture(t, backend);
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    assert.equal(f.messages().length, 0);
    f.end();
    run(f.db, 'UPDATE cases SET suppressed=1 WHERE id=?', f.caseId);
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    assert.equal(f.messages().length, 0);
    assert.equal(
      f.service.state(f.caseId).tasks.find((t) => t.due_at === '2030-01-15').status,
      'waiting_policy',
    );
    run(f.db, 'UPDATE cases SET suppressed=0 WHERE id=?', f.caseId);
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    const reminder = f.service
      .state(f.caseId)
      .tasks.find((t) => t.kind === 'reminder' && t.due_at === '2030-01-15');
    const messages = f.messages().filter((m) => m.request_id === `payment-task:${reminder.id}`);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'simulated_delivered');
    assert.match(messages[0].body, /No real payment is requested/);
  });
  test(`${backend}: portfolio pause and disputed debt prevent automated collection`, async (t) => {
    const f = await fixture(t, backend);
    f.end();
    run(f.db, "UPDATE cases SET outcome='disputed' WHERE id=?", f.caseId);
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    assert.equal(f.messages().length, 0);
    run(f.db, 'UPDATE cases SET outcome=NULL WHERE id=?', f.caseId);
    const portfolio = one(f.db, 'SELECT portfolio_id FROM cases WHERE id=?', f.caseId).portfolio_id;
    run(
      f.db,
      "INSERT INTO portfolio_operations (portfolio_id,status,channels,mode,updated_at) VALUES (?,'paused','[]','demo',?) ON CONFLICT(portfolio_id) DO UPDATE SET status='paused'",
      portfolio,
      now(),
    );
    await f.service.tick({ caseId: f.caseId, date: '2030-01-15' });
    assert.equal(f.messages().length, 0);
  });
  test(`${backend}: provider retries reuse idempotency keys and stop after three failures`, async (t) => {
    const calls = [];
    const adapter = {
      ...createSimulatorPaymentProvider(),
      async createRequest(request) {
        calls.push(request.idempotencyKey);
        throw new Error('Simulated timeout');
      },
    };
    const f = await fixture(t, backend, { adapter });
    for (let n = 0; n < 4; n++) await f.service.tick({ caseId: f.caseId, date: '2030-01-01' });
    assert.equal(calls.length, 9);
    assert.equal(new Set(calls).size, 3);
    assert.equal(f.request().attempts, 3);
    assert.equal(f.request().status, 'failed');
  });
}

test('provider contract and activation explicitly reject incomplete and live adapters', () => {
  assert.throws(
    () => validatePaymentProvider({ name: 'missing', mode: 'simulation' }),
    /createRequest/,
  );
  const db = openDb();
  try {
    assert.throws(
      () =>
        createPaymentService(
          db,
          { mode: 'demo' },
          { adapter: { ...createSimulatorPaymentProvider(), mode: 'live' } },
        ),
      /explicit activation/,
    );
  } finally {
    db.close();
  }
});
