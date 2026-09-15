import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb, one, run } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { ensureDemoVoiceCase, persistDemoAgreement } from '../server/demo-platform.mjs';
import { isolatedDatabase, executeTestTool } from '../server/browser-voice.mjs';
import { executePaymentSolution } from '../server/demo-payment.mjs';

const config = { mode: 'demo', agentWorkflowsEnabled: true };
async function fixture(
  t,
  runAgent = async () => ({ action: 'reply', text: 'Here is the requested document.' }),
) {
  const db = openDb();
  const source = { provider: 'openai', sessionId: 'document-workflow' };
  const saved = ensureDemoVoiceCase(db, config, source);
  let workflow = createAgentWorkflows(db, config, { runAgent });
  const input = {
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'request-one',
  };
  const app = express();
  app.use(express.json());
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
    source,
    saved,
    input,
    get workflow() {
      return workflow;
    },
    async restart() {
      await workflow.closeAll();
      workflow = createAgentWorkflows(db, config, { runAgent });
    },
    async post(path, body = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/workflow${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.text());
    },
    end() {
      workflow.sourceEnded(source.provider, source.sessionId);
    },
  };
}

test('document-only handoff waits for end, survives restart, deduplicates and remembers delivered evidence', async (t) => {
  const seen = [];
  const f = await fixture(t, async (input) => {
    seen.push(input);
    return { action: 'reply', text: 'I can help with this document.' };
  });
  const requested = f.workflow.documentRequested(f.input);
  const c = requested.conversationId;
  assert.equal(
    f.workflow.documentRequested(f.input).documentRequestId,
    requested.documentRequestId,
  );
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 0);
  await f.restart();
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 0);
  f.end();
  await f.workflow.tick();
  let detail = f.workflow.detail(c);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].documents.length, 1);
  assert.equal(detail.messages[0].documents[0].kind, 'loan_agreement');
  assert.equal(detail.messages[0].status, 'simulated_delivered');
  assert.match(seen[0].context.documentResult.content, /FICTIONAL DEMO/);
  assert.equal(seen[0].context.agreement, null);
  f.workflow.documentRequested(f.input);
  f.end();
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 1);
  await f.post(`/${c}/messages`, { text: 'What does the document say?', requestId: 'reply-one' });
  await f.workflow.tick();
  assert.equal(seen[1].context.deliveredDocuments.length, 1);
  assert.match(seen[1].context.deliveredDocuments[0].content, /FICTIONAL DEMO/);
  assert.equal(one(f.db, 'SELECT COUNT(*) AS n FROM attempts').n, 0);
});

test('agreement accepted later reuses document case and conversation and preserves attachments', async (t) => {
  const f = await fixture(t);
  const { conversationId: c } = f.workflow.documentRequested(f.input);
  f.end();
  await f.workflow.tick();
  const voice = isolatedDatabase(f.source.sessionId);
  executeTestTool(voice, f.source.sessionId, 'confirm_identity', {
    confirmed: true,
    name: 'Ana Silva',
  });
  const agreement = executePaymentSolution(voice, f.source.sessionId, {
    offerId: 'three_installments',
    accepted: true,
  }).agreement;
  voice.close();
  const saved = persistDemoAgreement(f.db, config, { ...f.source, agreement });
  assert.equal(saved.caseId, f.saved.caseId);
  assert.equal(
    f.workflow.agreementSaved({ ...f.source, caseId: saved.caseId, agreementId: agreement.id })
      .conversationId,
    c,
  );
  await f.workflow.tick();
  const detail = f.workflow.detail(c);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].documents.length, 1);
  assert.match(detail.messages[1].body, /DEMO-PIX-NOT-PAYABLE/);
  assert.equal(detail.conversation.agreement_id, agreement.id);
});

for (const state of ['missing', 'ambiguous'])
  test(`${state} document routes to supervisor resolution without attachment`, async (t) => {
    let modelCalls = 0;
    const f = await fixture(t, async (input) => {
      modelCalls++;
      assert.equal(input.supervisor, true);
      assert.ok(input.context.supervisorResolution.missingDocument);
      return {
        action: 'awaiting_information',
        text: 'The requested evidence is not yet available.',
        reason: 'Missing or ambiguous document',
        nextAction: 'Locate the correct case document and recheck.',
      };
    });
    if (state === 'missing')
      run(
        f.db,
        "DELETE FROM case_documents WHERE case_id=? AND kind='loan_agreement'",
        f.saved.caseId,
      );
    else
      run(
        f.db,
        "INSERT INTO case_documents SELECT 'other-doc',case_id,'Different loan',kind,version,source,content,checksum,created_at FROM case_documents WHERE case_id=? AND kind='loan_agreement'",
        f.saved.caseId,
      );
    const { conversationId: c, documentRequestId } = f.workflow.documentRequested(f.input);
    f.end();
    await f.workflow.tick();
    await f.workflow.tick();
    const detail = f.workflow.detail(c);
    assert.equal(detail.conversation.status, 'awaiting_information');
    assert.equal(detail.messages.flatMap((m) => m.documents).length, 0);
    assert.equal(
      one(f.db, 'SELECT status FROM document_requests WHERE id=?', documentRequestId).status,
      state,
    );
    assert.equal(modelCalls, 1);
    assert.equal(
      one(f.db, 'SELECT review_required FROM cases WHERE id=?', f.saved.caseId).review_required,
      0,
    );
  });

test('document task pause preserves work and resume still waits for call end', async (t) => {
  const f = await fixture(t);
  const { conversationId: c } = f.workflow.documentRequested(f.input);
  await f.post(`/${c}/pause`);
  assert.equal(f.workflow.detail(c).tasks[0].status, 'paused');
  await f.post(`/${c}/resume`);
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 0);
  f.end();
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages[0].documents.length, 1);
});

test('stop received while drafting prevents document delivery', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, async () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const { conversationId: c } = f.workflow.documentRequested(f.input);
  f.end();
  const pending = f.workflow.tick();
  await started;
  await f.post(`/${c}/messages`, { text: 'STOP', requestId: 'stop-one' });
  release({ action: 'reply', text: 'Do not send this document.' });
  await pending;
  assert.equal(f.workflow.detail(c).conversation.status, 'opted_out');
  assert.equal(f.workflow.detail(c).messages.filter((m) => m.direction === 'outbound').length, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) AS n FROM agent_message_documents').n, 0);
});

test('pause while drafting prevents delivery and resume delivers document exactly once', async (t) => {
  let release,
    entered,
    calls = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, async () => {
    if (++calls > 1) return { action: 'reply', text: 'Here is your document.' };
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const { conversationId: c } = f.workflow.documentRequested(f.input);
  f.end();
  const pending = f.workflow.tick();
  await started;
  await f.post(`/${c}/pause`);
  release({ action: 'reply', text: 'Paused draft.' });
  await pending;
  assert.equal(f.workflow.detail(c).messages.length, 0);
  assert.equal(f.workflow.detail(c).tasks[0].status, 'paused');
  await f.post(`/${c}/resume`);
  await f.workflow.tick();
  assert.equal(f.workflow.detail(c).messages.length, 1);
  assert.equal(f.workflow.detail(c).messages[0].documents.length, 1);
});

test('document-only SMS can explain authorized installment options without creating an agreement', async (t) => {
  const f = await fixture(t, async ({ context }) => {
    if (context.purpose !== 'reply') return { action: 'reply', text: 'Here is your document.' };
    assert.equal(context.agreement, null);
    assert.equal(context.authorizedOffers.length, 3);
    const offer = context.authorizedOffers.find((o) => o.offerId === 'three_installments');
    assert.equal(offer.totalMinor, 125000);
    assert.equal(
      offer.installments.reduce((n, p) => n + p.amountMinor, 0),
      125000,
    );
    return {
      action: 'reply',
      text: `Yes, the demo offers three monthly installments: BRL 416.67, BRL 416.67 and BRL 416.66. Total BRL 1,250.00, starting ${offer.installments[0].dueDate}.`,
    };
  });
  const { conversationId: c } = f.workflow.documentRequested(f.input);
  f.end();
  await f.workflow.tick();
  await f.post(`/${c}/messages`, {
    text: 'can i pay that back in installments?',
    requestId: 'installment-question',
  });
  await f.workflow.tick();
  const detail = f.workflow.detail(c);
  assert.equal(detail.conversation.status, 'active');
  assert.match(detail.messages.at(-1).body, /three monthly installments/);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
  assert.equal(
    one(f.db, 'SELECT review_required FROM cases WHERE id=?', f.saved.caseId).review_required,
    0,
  );
});
