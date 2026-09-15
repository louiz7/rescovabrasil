import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb, one, run } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { createDocumentLibrary } from '../server/documents.mjs';

const config = { mode: 'demo', agentWorkflowsEnabled: true };
async function fixture(t, runAgent) {
  const db = openDb();
  const source = { provider: 'openai', sessionId: 'supervisor-workflow' };
  const saved = ensureDemoVoiceCase(db, config, source);
  let workflow = createAgentWorkflows(db, config, { runAgent });
  const app = express();
  app.use(express.json());
  app.use('/workflow/documents/:caseId', createDocumentLibrary(db, config).router);
  app.use('/workflow', (req, res, next) => workflow.router(req, res, next));
  app.use((error, req, res, next) =>
    res.status(error.status || error.statusCode || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await workflow.closeAll();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  return {
    db,
    saved,
    source,
    get workflow() {
      return workflow;
    },
    async restart() {
      await workflow.closeAll();
      workflow = createAgentWorkflows(db, config, { runAgent });
    },
    async get(path) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/workflow${path}`);
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    },
    async post(path, body = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/workflow${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    },
    async start() {
      const result = workflow.documentRequested({
        ...source,
        caseId: saved.caseId,
        kind: 'loan_agreement',
        requestId: 'document-one',
      });
      workflow.sourceEnded(source.provider, source.sessionId);
      await workflow.tick();
      return result.conversationId;
    },
    async drain() {
      for (let i = 0; i < 5; i++) await workflow.tick();
    },
  };
}
const reply = (text) => ({ action: 'reply', text });
const waiting = (action = 'awaiting_information') => ({
  action,
  text: 'I am checking the missing information.',
  reason: 'Missing verified information',
  nextAction: 'Retrieve the lender confirmation and reassess.',
});
function noHumanTask(f) {
  assert.equal(
    one(f.db, "SELECT COUNT(*) n FROM tasks WHERE case_id=? AND status='open'", f.saved.caseId).n,
    0,
  );
  assert.equal(
    one(f.db, 'SELECT review_required FROM cases WHERE id=?', f.saved.caseId).review_required,
    0,
  );
}

for (const primaryAction of ['escalate_supervisor', 'human_review']) {
  test(`${primaryAction} consults Rafael durably and Marina sends his approved guidance`, async (t) => {
    const calls = [];
    const f = await fixture(t, async (input) => {
      calls.push(input);
      if (input.supervisor) {
        const initial = await f.get('/escalations');
        assert.equal(initial.escalations.length, 1);
        assert.equal(initial.escalations[0].reason, 'Need installment guidance');
        assert.equal(initial.escalations[0].caseId, f.saved.caseId);
        assert.equal(initial.summary.open, 1);
        assert.ok(initial.escalations[0].nextAction);
        assert.ok(initial.escalations[0].createdAt);
        assert.equal(input.context.authorizedOffers.length, 3);
        assert.ok(input.context.documents.length);
        assert.match(input.context.supervisorResolution.reason, /installment/i);
        return reply('Explain the approved three or six installment options.');
      }
      if (input.context.supervisorGuidance)
        return reply('You can choose three or six monthly installments.');
      if (input.context.purpose === 'document_followup') return reply('Here is your document.');
      assert.equal(input.deferSupervisor, true);
      return {
        action: primaryAction,
        text: primaryAction === 'human_review' ? '' : 'Internal consultation only.',
        reason: 'Need installment guidance',
      };
    });
    const c = await f.start();
    await f.post(`/${c}/messages`, {
      text: 'Can I pay in installments?',
      requestId: 'installments',
    });
    await f.drain();
    const detail = f.workflow.detail(c);
    assert.equal(detail.conversation.status, 'active');
    assert.match(detail.messages.at(-1).body, /three or six/);
    assert.ok(
      !detail.messages.some((m) => /Internal consultation|Explain the approved/.test(m.body)),
    );
    assert.ok(
      detail.tasks.some((j) => j.purpose === 'supervisor_review' && j.status === 'completed'),
    );
    assert.ok(
      detail.tasks.some((j) => j.purpose === 'marina_guided_reply' && j.status === 'completed'),
    );
    assert.equal(calls.filter((i) => i.supervisor).length, 1);
    const tracked = await f.get('/escalations');
    assert.deepEqual(tracked.summary, { total: 1, open: 0, resolved: 1 });
    assert.equal(tracked.escalations[0].status, 'resolved');
    assert.equal(tracked.escalations[0].reason, 'Need installment guidance');
    assert.equal(tracked.escalations[0].conversationId, c);
    noHumanTask(f);
  });
}

for (const status of ['awaiting_information', 'awaiting_specialist', 'blocked_policy']) {
  test(`${status} belongs to Rafael, accepts new context, and rechecks after restart`, async (t) => {
    const supervisorCalls = [];
    const f = await fixture(t, async (input) => {
      if (input.supervisor) {
        supervisorCalls.push(input);
        return waiting(status);
      }
      if (input.context.purpose === 'document_followup') return reply('Here is your document.');
      return {
        action: 'escalate_supervisor',
        text: 'Checking this.',
        reason: 'Missing information',
      };
    });
    const c = await f.start();
    await f.post(`/${c}/messages`, {
      text: 'Please clarify the account history.',
      requestId: 'question',
    });
    await f.drain();
    const resolution = f.workflow.detail(c).conversation.resolution;
    assert.equal(f.workflow.detail(c).conversation.status, status);
    assert.equal(resolution.owner, 'supervisor');
    assert.equal(resolution.status, status);
    assert.ok(resolution.reason);
    assert.ok(resolution.nextAction);
    noHumanTask(f);
    const beforeRecheck = supervisorCalls.length;
    const originalEscalation = (await f.get('/escalations')).escalations[0];
    assert.equal(originalEscalation.status, status);
    await f.post(`/${c}/recheck`);
    await f.restart();
    await f.drain();
    assert.equal(supervisorCalls.length, beforeRecheck + 1);
    await f.post(`/${c}/messages`, {
      text: 'Here is additional information about my account.',
      requestId: 'new-information',
    });
    await f.drain();
    assert.equal(supervisorCalls.length, beforeRecheck + 2);
    const tracked = await f.get('/escalations');
    assert.equal(tracked.escalations.length, 1);
    assert.equal(tracked.escalations[0].id, originalEscalation.id);
    assert.equal(tracked.escalations[0].reason, originalEscalation.reason);
    assert.equal(tracked.escalations[0].status, status);
    assert.ok(
      supervisorCalls.at(-1).messages.some((m) => /additional information/.test(m.content)),
    );
    noHumanTask(f);
  });
}

test('missing requested evidence goes to Rafael with retrieval result instead of a human task', async (t) => {
  const seen = [];
  const f = await fixture(t, async (input) => {
    seen.push(input);
    return waiting();
  });
  run(f.db, "DELETE FROM case_documents WHERE case_id=? AND kind='loan_agreement'", f.saved.caseId);
  const c = await f.start();
  await f.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].supervisor, true);
  assert.ok(seen[0].context.supervisorResolution.missingDocument);
  assert.equal(f.workflow.detail(c).conversation.status, 'awaiting_information');
  assert.equal(f.workflow.detail(c).messages.flatMap((m) => m.documents).length, 0);
  noHumanTask(f);
});

test('Rafael can delegate evidence retrieval to Helena for Marina delivery', async (t) => {
  const f = await fixture(t, async (input) => {
    if (input.supervisor)
      return {
        action: 'request_account_statement',
        text: 'Retrieve the account statement.',
        reason: 'Statement needed',
      };
    if (input.context.purpose === 'document_followup')
      return reply('Here is the requested document.');
    return {
      action: 'escalate_supervisor',
      text: 'Checking the evidence.',
      reason: 'Need account evidence',
    };
  });
  const c = await f.start();
  await f.post(`/${c}/messages`, {
    text: 'Can you help explain my account?',
    requestId: 'evidence',
  });
  await f.drain();
  const detail = f.workflow.detail(c);
  assert.ok(
    detail.messages.flatMap((m) => m.documents).some((d) => d.kind === 'account_statement'),
  );
  assert.equal(detail.conversation.status, 'active');
  noHumanTask(f);
});

test('STOP interrupts a pending supervisor and prevents subsequent guidance delivery', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, async (input) => {
    if (input.supervisor) {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    if (input.context.purpose === 'document_followup') return reply('Here is your document.');
    return { action: 'escalate_supervisor', text: 'Checking.', reason: 'Needs context' };
  });
  const c = await f.start();
  await f.post(`/${c}/messages`, { text: 'I have another question.', requestId: 'question' });
  const pending = f.drain();
  await started;
  const before = f.workflow.detail(c).messages.filter((m) => m.direction === 'outbound').length;
  await f.post(`/${c}/messages`, { text: 'STOP', requestId: 'stop' });
  release(reply('Continue explaining payment options.'));
  await pending;
  const detail = f.workflow.detail(c);
  assert.equal(detail.conversation.status, 'opted_out');
  const tracked = await f.get('/escalations');
  assert.equal(tracked.escalations.length, 1);
  assert.equal(tracked.escalations[0].status, 'cancelled');
  assert.equal(tracked.summary.open, 0);
  assert.equal(detail.messages.filter((m) => m.direction === 'outbound').length, before);
  assert.ok(!detail.tasks.some((j) => ['queued', 'running'].includes(j.status)));
  assert.equal(one(f.db, 'SELECT suppressed FROM cases WHERE id=?', f.saved.caseId).suppressed, 1);
});

test('voice referral waits for source end and remains a single tracked escalation', async (t) => {
  let supervisorCalls = 0;
  const f = await fixture(t, async (input) => {
    assert.equal(input.supervisor, true);
    supervisorCalls++;
    assert.equal(input.context.supervisorResolution.outcome, 'human_review');
    return waiting();
  });
  const event = {
    ...f.source,
    caseId: f.saved.caseId,
    args: { outcome: 'human_review', note: 'Clarify the account evidence' },
  };
  f.workflow.outcomeChanged(event);
  f.workflow.outcomeChanged(event);
  let tracked = await f.get('/escalations');
  assert.equal(tracked.escalations.length, 1);
  const initial = tracked.escalations[0];
  assert.equal(initial.trigger, 'voice_human_review');
  assert.equal(initial.reason, 'Clarify the account evidence');
  assert.equal(initial.caseId, f.saved.caseId);
  await f.drain();
  assert.equal(supervisorCalls, 0);
  await f.restart();
  f.workflow.sourceEnded(f.source.provider, f.source.sessionId);
  await f.drain();
  assert.equal(supervisorCalls, 1);
  tracked = await f.get('/escalations');
  assert.equal(tracked.escalations.length, 1);
  assert.equal(tracked.escalations[0].id, initial.id);
  assert.equal(tracked.escalations[0].status, 'awaiting_information');
  assert.equal(tracked.escalations[0].reason, initial.reason);
  f.workflow.outcomeChanged(event);
  await f.drain();
  assert.equal(supervisorCalls, 1);
  assert.equal(
    f.workflow.detail(initial.conversationId).conversation.status,
    'awaiting_information',
  );
  noHumanTask(f);
});

test('Rafael cannot create an endless chain by requesting the same missing evidence', async (t) => {
  let calls = 0;
  const f = await fixture(t, async (input) => {
    assert.equal(input.supervisor, true);
    calls++;
    return {
      action: 'request_loan_agreement',
      text: 'Retrieve the loan agreement.',
      reason: 'Need the missing agreement',
    };
  });
  run(f.db, "DELETE FROM case_documents WHERE case_id=? AND kind='loan_agreement'", f.saved.caseId);
  const c = await f.start();
  await f.drain();
  assert.equal(calls, 1);
  assert.equal(f.workflow.detail(c).conversation.status, 'awaiting_information');
  assert.ok(!f.workflow.detail(c).tasks.some((j) => ['queued', 'running'].includes(j.status)));
  await f.drain();
  assert.equal(calls, 1);
  noHumanTask(f);
});

test('uploading missing evidence automatically wakes Rafael and permits fresh retrieval', async (t) => {
  let supervisorCalls = 0;
  const f = await fixture(t, async (input) => {
    if (input.supervisor) {
      supervisorCalls++;
      if (!input.context.documents.some((d) => d.kind === 'loan_agreement')) return waiting();
      return {
        action: 'request_loan_agreement',
        text: 'Retrieve the loan agreement.',
        reason: 'The requested document is now available',
      };
    }
    return reply('Here is your newly available agreement.');
  });
  run(f.db, "DELETE FROM case_documents WHERE case_id=? AND kind='loan_agreement'", f.saved.caseId);
  const c = await f.start();
  await f.drain();
  assert.equal(f.workflow.detail(c).conversation.status, 'awaiting_information');
  assert.equal(supervisorCalls, 1);
  const created = await f.post(`/documents/${f.saved.caseId}`, {
    title: 'Newly located demo loan agreement',
    kind: 'loan_agreement',
    content: 'FICTIONAL DEMO: newly located original agreement.',
  });
  await f.drain();
  assert.equal(supervisorCalls, 2);
  const detail = f.workflow.detail(c);
  assert.equal(detail.conversation.status, 'active');
  assert.ok(detail.messages.flatMap((m) => m.documents).some((d) => d.id === created.document.id));
  noHumanTask(f);
});
