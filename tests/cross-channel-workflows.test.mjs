import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, one, run } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';

function fixture(t, runAgent) {
  const db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true };
  const source = { provider: 'openai', sessionId: 'cross-channel' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const workflow = createAgentWorkflows(db, config, { runAgent });
  const { conversationId } = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'initial',
    deliveryChannel: 'email',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  return { db, workflow, conversationId, saved, source };
}
for (const submitted of [true, false]) {
  test(`email offer -> SMS acceptance requires original email submission (${submitted})`, async (t) => {
    const seen = [];
    const f = fixture(t, async ({ context, messages }) => {
      seen.push({ context, messages });
      if (context.purpose === 'document_followup')
        return {
          action: 'reply',
          text: 'Here is the requested document and installment option.',
          presentedOfferIds: ['three_installments'],
        };
      if (context.purpose === 'supervisor_review')
        return {
          action: 'awaiting_information',
          text: 'The offer needs to be delivered first.',
          reason: 'Missing delivery evidence',
        };
      return {
        action: 'accept_payment_offer',
        offerId: 'three_installments',
        acceptanceQuote: 'Yes, I accept the three installment plan.',
        text: '',
      };
    });
    await f.workflow.tick();
    const offerMessage = f.workflow.detail(f.conversationId).messages[0];
    assert.equal(offerMessage.channel, 'email');
    f.db.exec('CREATE TABLE email_deliveries (message_id TEXT,status TEXT)');
    run(
      f.db,
      'INSERT INTO email_deliveries VALUES (?,?)',
      offerMessage.id,
      submitted ? 'submitted' : 'queued',
    );
    f.workflow.receiveInbound(f.conversationId, {
      text: 'Yes, I accept the three installment plan.',
      requestId: 'sms-accept',
    });
    await f.workflow.tick();
    const detail = f.workflow.detail(f.conversationId);
    assert.equal(Boolean(detail.conversation.agreementId), submitted);
    if (submitted) {
      assert.equal(detail.messages.at(-1).channel, 'virtual_sms');
      assert.match(detail.messages.at(-1).body, /payment agreement is recorded/);
      assert.ok(
        seen[1].context.conversationHistory.some(
          (m) => m.id === offerMessage.id && m.channel === 'email',
        ),
      );
      assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
      f.workflow.receiveInbound(f.conversationId, {
        text: 'Yes, I accept the three installment plan.',
        requestId: 'sms-accept',
      });
      await f.workflow.tick();
      assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
    } else {
      assert.ok(!seen[1].messages.some((m) => m.content === offerMessage.body));
      assert.equal(detail.conversation.resolution.status, 'awaiting_information');
    }
  });
}
test('queued turns keep their own channel and duplicate inbound cannot reset routing', async (t) => {
  const channels = [];
  const f = fixture(t, async ({ context }) => {
    channels.push(context.channel);
    return { action: 'reply', text: 'I have your case context.' };
  });
  await f.workflow.tick();
  f.workflow.receiveInbound(f.conversationId, {
    text: 'Email question',
    requestId: 'email-turn',
    channel: 'email',
  });
  f.workflow.receiveInbound(f.conversationId, {
    text: 'SMS question',
    requestId: 'sms-turn',
    channel: 'virtual_sms',
  });
  f.workflow.receiveInbound(f.conversationId, {
    text: 'Email question',
    requestId: 'email-turn',
    channel: 'email',
  });
  assert.equal(f.workflow.detail(f.conversationId).conversation.channel, 'sms');
  await f.workflow.tick();
  assert.deepEqual(channels, ['email', 'email', 'sms']);
  assert.deepEqual(
    f.workflow
      .detail(f.conversationId)
      .messages.filter((m) => m.direction === 'outbound')
      .map((m) => m.channel),
    ['email', 'email', 'virtual_sms'],
  );
});
test('written explicit email document request schedules email while SMS history stays on the same case', async (t) => {
  const f = fixture(t, async ({ context }) =>
    context.purpose === 'reply'
      ? { action: 'request_account_statement', text: '', deliveryChannel: 'email' }
      : { action: 'reply', text: 'Here is your requested document.' },
  );
  await f.workflow.tick();
  f.workflow.receiveInbound(f.conversationId, {
    text: 'Please email my statement',
    requestId: 'sms-document',
  });
  await f.workflow.tick();
  const detail = f.workflow.detail(f.conversationId);
  assert.equal(detail.messages.at(-1).channel, 'email');
  assert.equal(detail.messages.at(-1).documents[0].kind, 'account_statement');
  const retry = f.workflow.documentRequested({
    ...f.source,
    caseId: f.saved.caseId,
    kind: 'loan_agreement',
    requestId: 'initial',
    deliveryChannel: 'sms',
  });
  assert.equal(retry.conversationId, f.conversationId);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM agent_conversations').n, 1);
  assert.equal(detail.tasks[0].delivery_channel, 'email');
});

test('email to SMS creditor question looks up portfolio facts without injecting them into every turn', async (t) => {
  const seen = [];
  const f = fixture(t, async ({ context }) => {
    seen.push(context);
    if (context.purpose === 'document_followup')
      return { action: 'reply', text: 'Here is your document.' };
    if (!context.lookupResults.length)
      return { action: 'lookup_case_information', lookupTopic: 'case_details', text: '' };
    return {
      action: 'reply',
      text: `The case creditor is ${context.lookupResults[0].result.facts.creditor}.`,
    };
  });
  await f.workflow.tick();
  const message = f.workflow.detail(f.conversationId).messages[0];
  f.db.exec('CREATE TABLE email_deliveries (message_id TEXT,status TEXT)');
  run(f.db, 'INSERT INTO email_deliveries VALUES (?,?)', message.id, 'submitted');
  f.workflow.receiveInbound(f.conversationId, {
    text: 'I got your email. What bank was the receivable from?',
    requestId: 'creditor-question',
    channel: 'virtual_sms',
  });
  await f.workflow.tick();
  assert.equal(seen[0].caseKnowledge, undefined);
  assert.equal(seen[1].case.creditor, undefined);
  assert.equal(seen[1].portfolio, undefined);
  const context = seen.at(-1);
  assert.equal(context.lookupResults[0].result.facts.creditor, 'Banco Horizonte (fictional)');
  assert.match(f.workflow.detail(f.conversationId).messages.at(-1).body, /Banco Horizonte/);
  assert.ok(f.workflow.detail(f.conversationId).events.some((e) => e.kind === 'case.lookup'));
  const current = f.workflow.deliveryContext(f.conversationId);
  const before = current.snapshot;
  run(
    f.db,
    'UPDATE portfolios SET creditor=? WHERE id=?',
    'Updated demo creditor',
    current.context.portfolio.id,
  );
  assert.notEqual(f.workflow.deliveryContext(f.conversationId).snapshot, before);
});

test('repeated case lookups stop rather than loop or send intermediate tool text', async (t) => {
  const f = fixture(t, async () => ({
    action: 'lookup_case_information',
    lookupTopic: 'case_details',
    text: '',
  }));
  await f.workflow.tick();
  assert.ok(f.workflow.detail(f.conversationId).runs.length < 10);
  assert.ok(f.workflow.detail(f.conversationId).conversation.resolution);
  assert.ok(f.workflow.detail(f.conversationId).events.some((e) => e.kind === 'case.lookup'));
});
