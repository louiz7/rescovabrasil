import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, one } from '../server/db.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';

for (const backend of process.env.TEST_DATABASE_URL ? ['sqlite', 'postgres'] : ['sqlite']) {
  test(`${backend}: accepted written plan becomes payment requests, current agent evidence and due-date tasks`, async (t) => {
    let db, admin, schema;
    if (backend === 'postgres') {
      admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
      schema = 'payment_flow_' + process.pid + '_' + Math.random().toString(36).slice(2);
      admin.query('CREATE SCHEMA ' + schema);
      const url = new URL(process.env.TEST_DATABASE_URL);
      url.searchParams.set('options', '-csearch_path=' + schema);
      db = openDb(url.href);
    } else db = openDb();
    const config = { mode: 'demo', agentWorkflowsEnabled: true };
    const source = { provider: 'openai', sessionId: 'connected-payment-flow' };
    const { caseId } = ensureDemoVoiceCase(db, config, source);
    const lookupSummaries = [];
    let lookupRequests = 0;
    const workflow = createAgentWorkflows(db, config, {
      runAgent: async ({ context, messages, supervisor }) => {
        assert.equal(supervisor, false, 'Ordinary payment questions must not escalate.');
        assert.equal(
          context.operatingMandate.organization.objective,
          'Maximize verified recovery of Rescova-owned receivables within approved rules.',
        );
        assert.equal(context.operatingMandate.role.agentId, 'Marina');
        assert.equal(
          context.operatingMandate.goalId,
          `recovery:${context.operatingMandate.portfolio.id}`,
        );
        if (context.purpose === 'document_followup')
          return { action: 'reply', text: 'Here is your demo agreement.' };
        const latest = messages.at(-1).content;
        if (latest === 'What are my payment options?')
          return {
            action: 'reply',
            text: 'The approved plan allows three monthly payments.',
            presentedOfferIds: ['three_installments'],
          };
        if (latest === 'Yes, I accept the three installment plan.')
          return {
            action: 'accept_payment_offer',
            offerId: 'three_installments',
            acceptanceQuote: latest,
            text: 'Record the approved plan.',
          };
        assert.equal(latest, 'What is my current remaining balance?');
        if (!context.lookupResults.length) {
          lookupRequests++;
          return { action: 'lookup_case_information', lookupTopic: 'payment_status', text: '' };
        }
        const evidence =
          context.lookupResults.find((x) => x.result.topic === 'payment_status')?.result ||
          context.lookupResults[0].result;
        assert.equal(evidence.summary.mode, 'simulation');
        lookupSummaries.push(evidence.summary);
        return {
          action: 'reply',
          text: `DEMO: BRL ${(evidence.summary.receivedMinor / 100).toFixed(2)} recorded in simulated receipts; BRL ${(evidence.summary.remainingMinor / 100).toFixed(2)} remains. This does not confirm receipt of real money.`,
        };
      },
    });
    t.after(async () => {
      await workflow.closeAll();
      await workflow.library.closeIngestion();
      db.close();
      if (admin) {
        admin.query('DROP SCHEMA ' + schema + ' CASCADE');
        admin.close();
      }
    });
    const { conversationId } = workflow.documentRequested({
      ...source,
      caseId,
      kind: 'loan_agreement',
      requestId: 'initial-document',
      deliveryChannel: 'sms',
    });
    workflow.sourceEnded(source.provider, source.sessionId);
    await workflow.tick();
    workflow.receiveInbound(conversationId, {
      text: 'What are my payment options?',
      requestId: 'options',
    });
    await workflow.tick();
    workflow.receiveInbound(conversationId, {
      text: 'Yes, I accept the three installment plan.',
      requestId: 'accept',
    });
    await workflow.tick();
    await workflow.tick(); // Drain payment requests registered by the agreement job.
    const agreed = workflow.payments.state(caseId);
    assert.equal(agreed.agreements.length, 1);
    assert.equal(agreed.summary.remainingMinor, 125000);
    assert.equal(agreed.agreements[0].installments.length, 3);
    assert.ok(agreed.agreements[0].installments.every((p) => p.request.status === 'ready'));
    const first = agreed.agreements[0].installments[0];
    const instructions = agreed.tasks.find((task) => task.kind === 'instructions');
    assert.equal(instructions.status, 'simulated_completed');
    assert.ok(instructions.message_id);
    assert.match(
      workflow.detail(conversationId).messages.find((m) => m.id === instructions.message_id).body,
      /agreement is recorded|agreed payment details/,
    );
    const instructionId = instructions.message_id;
    await workflow.tick();
    assert.equal(
      workflow.payments.state(caseId).tasks.find((task) => task.kind === 'instructions').message_id,
      instructionId,
    );
    assert.equal(one(db, "SELECT COUNT(*) n FROM payment_tasks WHERE kind='instructions'").n, 1);

    const beforeSnapshot = workflow.deliveryContext(conversationId).snapshot;
    workflow.payments.simulate(caseId, {
      requestId: first.request.id,
      eventId: 'partial-first',
      paymentId: 'first-part',
      currency: 'BRL',
      amountMinor: 10000,
      version: 1,
      status: 'succeeded',
    });
    assert.notEqual(
      workflow.deliveryContext(conversationId).snapshot,
      beforeSnapshot,
      'Payment evidence must invalidate stale message contexts.',
    );
    await workflow.tick();
    let paymentState = workflow.payments.state(caseId);
    assert.equal(paymentState.agreements[0].installments[0].status, 'partial');
    assert.equal(paymentState.summary.remainingMinor, 115000);
    const update = paymentState.tasks.find(
      (task) => task.kind === 'payment_update' && task.status === 'simulated_completed',
    );
    assert.ok(update?.message_id);
    assert.match(
      workflow.detail(conversationId).messages.find((m) => m.id === update.message_id).body,
      /BRL 100.00/,
    );

    async function askBalance(requestId) {
      workflow.receiveInbound(conversationId, {
        text: 'What is my current remaining balance?',
        requestId,
      });
      await workflow.tick();
      return workflow.detail(conversationId).messages.at(-1).body;
    }
    assert.match(await askBalance('balance-partial'), /BRL 1150.00 remains/);
    assert.equal(lookupSummaries.at(-1).remainingMinor, 115000);

    workflow.payments.simulate(caseId, {
      requestId: first.request.id,
      eventId: 'finish-first',
      paymentId: 'second-part',
      currency: 'BRL',
      amountMinor: first.amount_minor - 10000,
      version: 1,
      status: 'succeeded',
    });
    await workflow.tick();
    assert.match(await askBalance('balance-first-paid'), /BRL 833.33 remains/);
    assert.equal(
      lookupRequests,
      2,
      'Each new balance question must retrieve fresh ledger evidence.',
    );
    assert.equal(lookupSummaries.at(-1).remainingMinor, 83333);
    await workflow.payments.tick({ caseId, date: first.due_date });
    paymentState = workflow.payments.state(caseId);
    assert.equal(paymentState.agreements[0].installments[0].status, 'paid');
    const reminder = paymentState.tasks.find(
      (task) => task.kind === 'reminder' && task.installment_id === first.id,
    );
    assert.equal(reminder.status, 'cancelled');
    assert.equal(reminder.message_id, null);
    const next = paymentState.agreements[0].installments[1];
    assert.equal(
      paymentState.tasks.find((task) => task.kind === 'reminder' && task.installment_id === next.id)
        .status,
      'queued',
    );
    assert.equal(
      one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE purpose='supervisor_review'").n,
      0,
    );
    assert.ok(
      workflow.detail(conversationId).events.filter((e) => e.kind === 'case.lookup').length >= 2,
    );
  });
}
