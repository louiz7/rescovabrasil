import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb, one, run, transaction } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { persistDemoAgreement } from '../server/demo-platform.mjs';
import { isolatedDatabase, executeTestTool } from '../server/browser-voice.mjs';
import { executePaymentSolution } from '../server/demo-payment.mjs';
const config = { mode: 'demo', agentWorkflowsEnabled: true };
async function fixture(
  t,
  runAgent = async () => ({
    action: 'reply',
    text: 'Thank you. I can help with your agreement.',
    provider: 'test',
    model: 'fake',
  }),
) {
  const db = openDb();
  const voice = isolatedDatabase('workflow-test');
  executeTestTool(voice, 'workflow-test', 'confirm_identity', {
    confirmed: true,
    name: 'Ana Silva',
  });
  const agreement = executePaymentSolution(voice, 'workflow-test', {
    offerId: 'three_installments',
    accepted: true,
  }).agreement;
  voice.close();
  const saved = persistDemoAgreement(db, config, {
    provider: 'openai',
    sessionId: 'workflow-test',
    agreement,
  });
  const input = {
    provider: 'openai',
    sessionId: 'workflow-test',
    caseId: saved.caseId,
    agreementId: agreement.id,
  };
  let workflow = createAgentWorkflows(db, config, { runAgent });
  const app = express();
  app.use(express.json());
  app.use('/workflow', (req, res, next) => workflow.router(req, res, next));
  app.use((e, _req, res, _next) =>
    res.status(e.status || e.statusCode || 400).json({ error: e.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await workflow.closeAll();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const request = async (path, body) => {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/workflow${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    return { status: r.status, data: await r.json() };
  };
  return {
    db,
    input,
    agreement,
    saved,
    request,
    get workflow() {
      return workflow;
    },
    async restart() {
      await workflow.closeAll();
      workflow = createAgentWorkflows(db, config, { runAgent });
    },
  };
}
test('handoff waits for persisted call closure and deduplicates acceptance and end events', async (t) => {
  const f = await fixture(t),
    { conversationId: c } = transaction(f.db, () => f.workflow.agreementSaved(f.input));
  assert.equal(f.workflow.agreementSaved(f.input).conversationId, c);
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 0);
  await f.restart();
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 0);
  f.workflow.sourceEnded('openai', 'workflow-test');
  f.workflow.sourceEnded('openai', 'workflow-test');
  await Promise.all([f.workflow.tick(), f.workflow.tick()]);
  const d = f.workflow.detail(c);
  assert.equal(d.messages.length, 1);
  assert.equal(d.tasks.length, 1);
  assert.equal(d.runs.length, 1);
  assert.match(d.messages[0].body, /DEMO-PIX-NOT-PAYABLE/);
  assert.match(d.messages[0].body, /416/);
  assert.equal(d.messages[0].status, 'simulated_delivered');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
});
test('end before agreement survives restart without enrolling old agreements', async (t) => {
  const f = await fixture(t);
  f.workflow.sourceEnded('openai', 'workflow-test');
  await f.restart();
  assert.equal(f.workflow.summary().queued, 0);
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 1);
});
test('inbound requests dedupe, turns serialize and replay durable history after restart', async (t) => {
  const seen = [];
  const f = await fixture(t, async (input) => {
    seen.push(input.messages);
    return { action: 'reply', text: 'Agent reply ' + seen.length };
  });
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  f.workflow.sourceEnded('openai', 'workflow-test');
  await f.workflow.tick();
  await f.request(`/${c}/messages`, { text: 'First question', requestId: 'one' });
  await f.request(`/${c}/messages`, { text: 'First question', requestId: 'one' });
  assert.equal(
    (await f.request(`/${c}/messages`, { text: 'Different', requestId: 'one' })).status,
    409,
  );
  await f.request(`/${c}/messages`, { text: 'Second question', requestId: 'two' });
  await f.restart();
  await f.workflow.tick();
  assert.equal(seen.length, 3);
  assert.ok(!seen[1].some((m) => m.content === 'Second question'));
  assert.ok(seen[2].some((m) => m.content === 'Agent reply 2'));
  assert.equal(f.workflow.detail(c).messages.filter((m) => m.direction === 'outbound').length, 3);
});
test('stop during generation cancels reply before simulated delivery', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  const f = await fixture(t, async () => {
    entered();
    return new Promise((resolve) => (release = resolve));
  });
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  f.workflow.sourceEnded('openai', 'workflow-test');
  const pending = f.workflow.tick();
  await started;
  await f.request(`/${c}/messages`, { text: 'STOP', requestId: 'stop' });
  release({ action: 'reply', text: 'This must not send.' });
  await pending;
  const d = f.workflow.detail(c);
  assert.equal(d.conversation.status, 'opted_out');
  assert.equal(d.messages.filter((m) => m.direction === 'outbound').length, 0);
  assert.equal(one(f.db, 'SELECT suppressed FROM cases WHERE id=?', f.saved.caseId).suppressed, 1);
});
test('unrelated review blocks automatic fulfillment; changed payment terms cancel a stale draft', async (t) => {
  const f = await fixture(t);
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  run(f.db, "UPDATE tasks SET reason='Identity concern' WHERE case_id=?", f.saved.caseId);
  f.workflow.sourceEnded('openai', 'workflow-test');
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).conversation.status, 'blocked');
  assert.equal(f.workflow.detail(c).runs.length, 0);
  const g = await fixture(t, async () => {
    run(
      g.db,
      "UPDATE payment_followup_jobs SET payment_details='Changed while drafting' WHERE case_id=?",
      g.saved.caseId,
    );
    return { action: 'reply', text: 'Must not send.' };
  });
  const { conversationId: d } = g.workflow.agreementSaved(g.input);
  g.workflow.sourceEnded('openai', 'workflow-test');
  await g.workflow.tick();
  assert.equal(g.workflow.detail(d).messages.length, 0);
  assert.equal(g.workflow.detail(d).tasks[0].status, 'cancelled');
});
test('payment report creates review without reducing balance; pause cancels pending work', async (t) => {
  const f = await fixture(t, async () => ({
    action: 'paid_reported',
    text: 'Your report needs verification.',
    reason: 'Payment reported',
  }));
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  f.workflow.sourceEnded('openai', 'workflow-test');
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).conversation.status, 'human_review');
  const item = one(f.db, 'SELECT * FROM cases WHERE id=?', f.saved.caseId);
  assert.equal(item.outcome, 'paid_reported');
  assert.equal(item.amount_minor, 125000);
  const g = await fixture(t);
  const { conversationId: d } = g.workflow.agreementSaved(g.input);
  await g.request(`/${d}/pause`, {});
  g.workflow.sourceEnded('openai', 'workflow-test');
  await g.workflow.tick();
  assert.equal(g.workflow.detail(d).messages.length, 0);
});
test('bounded retries become visible failures and do not duplicate outbound messages', async (t) => {
  const f = await fixture(t, async () => {
    throw new Error('secret provider error');
  });
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  f.workflow.sourceEnded('openai', 'workflow-test');
  for (let i = 0; i < 3; i++) {
    run(f.db, "UPDATE agent_jobs SET due_at='2000-01-01' WHERE conversation_id=?", c);
    await f.workflow.tick();
  }
  const d = f.workflow.detail(c);
  assert.equal(d.tasks[0].status, 'failed');
  assert.equal(d.tasks[0].attempts, 3);
  assert.equal(d.messages.length, 0);
  assert.ok(!JSON.stringify(d).includes('secret provider'));
});

test('operator pause preserves initial handoff and resume waits for call closure', async (t) => {
  const f = await fixture(t),
    { conversationId: c } = f.workflow.agreementSaved(f.input);
  await f.request(`/${c}/pause`, {});
  assert.equal(f.workflow.detail(c).tasks[0].status, 'paused');
  assert.equal((await f.request(`/${c}/resume`, {})).status, 200);
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 0);
  f.workflow.sourceEnded('openai', 'workflow-test');
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 1);
});
test('STOP uses shared suppression and cancels the platform follow-up', async (t) => {
  const f = await fixture(t),
    { conversationId: c } = f.workflow.agreementSaved(f.input);
  await f.request(`/${c}/messages`, { text: 'STOP', requestId: 'shared-stop' });
  assert.ok(one(f.db, "SELECT 1 FROM suppressions WHERE address='ana.silva@example.invalid'"));
  assert.equal(
    one(f.db, 'SELECT status FROM payment_followup_jobs WHERE case_id=?', f.saved.caseId).status,
    'cancelled',
  );
});
test('supervisor invocation is visible separately and unauthorized financial text never sends', async (t) => {
  const f = await fixture(t, async () => ({
    action: 'reply',
    text: 'Happy to help.',
    provider: 'test',
    model: 'sms-model',
    runs: [
      { role: 'sms', provider: 'test', model: 'sms-model' },
      {
        role: 'supervisor',
        provider: 'other',
        model: 'supervisor-model',
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ],
  }));
  const { conversationId: c } = f.workflow.agreementSaved(f.input);
  f.workflow.sourceEnded('openai', 'workflow-test');
  await f.workflow.tick();
  assert.equal(f.workflow.agentStats().supervisor.completed, 1);
  assert.equal(f.workflow.detail(c).runs.length, 2);
  const g = await fixture(t, async () => ({
    action: 'reply',
    text: 'Please pay BRL 1.00 at https://unapproved.invalid/pay',
  }));
  const { conversationId: d } = g.workflow.agreementSaved(g.input);
  g.workflow.sourceEnded('openai', 'workflow-test');
  await g.workflow.tick();
  assert.equal(g.workflow.detail(d).messages.length, 0);
});
