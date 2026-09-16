import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, one, run, all } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { createEmailWorkflows } from '../server/email-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';

async function fixture(t, options = {}) {
  const db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true, emailTestEnabled: true };
  const source = { provider: 'openai', sessionId: 'email-flow' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const workflow = createAgentWorkflows(db, config, {
    runAgent:
      options.runAgent ||
      (async () => ({ action: 'reply', text: 'Here is the requested demo document.' })),
  });
  const { conversationId } = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'first',
    deliveryChannel: options.deliveryChannel,
  });
  if (!options.waitForCallEnd) workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  const sends = [],
    incoming = [];
  const transport = {
    status: () => ({ configured: true }),
    verifyMailbox: async () => ({ emailAddress: 'louiz@rescova.de' }),
    getThread: async () => incoming,
    async send(input) {
      if (options.beforeSend) await options.beforeSend({ workflow, conversationId, db });
      await input.beforeSend();
      sends.push(input);
      if (options.fail)
        throw Object.assign(new Error('private provider error'), { uncertain: true });
      return {
        providerMessageId: `sent${sends.length}`,
        threadId: 'thread123',
        messageId: `<${input.id}@rescova.de>`,
      };
    },
  };
  let email = createEmailWorkflows(db, config, workflow, { transport });
  t.after(async () => {
    await email.closeAll();
    await workflow.closeAll();
    db.close();
  });
  return {
    db,
    config,
    workflow,
    sends,
    incoming,
    conversationId,
    saved,
    source,
    get email() {
      return email;
    },
    async restart() {
      await email.closeAll();
      email = createEmailWorkflows(db, config, workflow, { transport });
    },
    humanReply(id = 'human1', text = 'Can you explain this document?') {
      incoming.push({
        id,
        threadId: 'thread123',
        from: 'Louiz <louiz@rescova.de>',
        text,
        inReplyTo: `<${sends[0].id}@rescova.de>`,
        messageId: `<${id}@gmail.com>`,
      });
    },
  };
}
test('email preview and activation send one exact case attachment, self messages do not loop, human reply resumes same case', async (t) => {
  const f = await fixture(t);
  const p = f.email.preview(f.conversationId);
  assert.equal(p.recipient, 'louiz@rescova.de');
  assert.equal(p.attachments.length, 1);
  assert.match(p.attachments[0].content, /Ana Silva/);
  await f.email.start(f.conversationId);
  assert.equal(f.sends.length, 1);
  assert.equal(f.workflow.detail(f.conversationId).conversation.channel, 'email');
  f.incoming.push({
    id: 'sent1',
    text: 'Own outgoing',
    from: 'louiz@rescova.de',
    ownDeliveryId: f.sends[0].id,
  });
  f.incoming.push({
    id: 'auto',
    text: 'Auto reply',
    automatic: true,
    from: 'louiz@rescova.de',
    inReplyTo: `<${f.sends[0].id}@rescova.de>`,
  });
  await f.email.tick();
  assert.equal(f.sends.length, 1);
  f.humanReply();
  await f.email.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].threadId, 'thread123');
  assert.equal(
    f.workflow.detail(f.conversationId).messages.filter((m) => m.direction === 'inbound').length,
    1,
  );
  await f.email.tick();
  await f.restart();
  await f.email.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.email.status().deliveries[0].status, 'submitted');
});
test('uncertain sends survive restart without retries or later-message overtaking', async (t) => {
  const f = await fixture(t, { fail: true });
  await f.email.start(f.conversationId);
  assert.equal(f.email.status().deliveries[0].status, 'uncertain');
  await f.restart();
  await f.email.tick();
  assert.equal(f.sends.length, 1);
  assert.doesNotMatch(JSON.stringify(f.email.status()), /private provider error/);
});
test('pause, mailbox suppression and changed case state prevent external delivery', async (t) => {
  const f = await fixture(t, {
    beforeSend: ({ db, saved, conversationId }) => {
      run(db, "UPDATE agent_conversations SET status='paused' WHERE id=?", conversationId);
    },
  });
  await f.email.start(f.conversationId);
  assert.equal(f.sends.length, 0);
  assert.equal(f.email.status().deliveries[0].status, 'queued');
});
test('STOP reply cancels future delivery; duplicates are not reprocessed', async (t) => {
  const f = await fixture(t);
  await f.email.start(f.conversationId);
  f.humanReply('stop1', 'STOP');
  await f.email.tick();
  await f.email.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.workflow.detail(f.conversationId).conversation.status, 'opted_out');
  assert.equal(
    one(f.db, "SELECT COUNT(*) n FROM email_inbound_receipts WHERE status='received'").n,
    1,
  );
});
test('new unrelated thread participants and quoted content cannot become fresh customer messages', async (t) => {
  const f = await fixture(t);
  await f.email.start(f.conversationId);
  f.incoming.push({
    id: 'stranger',
    from: 'other@example.com',
    text: 'I accept',
    inReplyTo: `<${f.sends[0].id}@rescova.de>`,
  });
  f.incoming.push({
    id: 'unrelated',
    from: 'louiz@rescova.de',
    text: 'I accept',
    inReplyTo: '<other@example.com>',
  });
  f.humanReply('quote', 'Explain the terms please.\nOn Tuesday Marina wrote:\nI accept the plan');
  await f.email.tick();
  const inbound = f.workflow
    .detail(f.conversationId)
    .messages.filter((m) => m.direction === 'inbound');
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].body, 'Explain the terms please.');
});
test('email disabled and operator-uploaded documents cannot be externally released', async (t) => {
  const f = await fixture(t);
  f.config.emailTestEnabled = false;
  await assert.rejects(f.email.start(f.conversationId), /Enable EMAIL_TEST_ENABLED/);
  f.config.emailTestEnabled = true;
  run(
    f.db,
    "UPDATE case_documents SET source='operator_demo_upload' WHERE case_id=?",
    f.saved.caseId,
  );
  assert.throws(() => f.email.preview(f.conversationId), /seeded fictional/);
  assert.equal(f.sends.length, 0);
});

test('email reply can present terms then save a single accepted agreement and send payment details', async (t) => {
  const f = await fixture(t, {
    runAgent: async ({ context, messages }) => {
      const text = messages.at(-1)?.content || '';
      if (text.includes('installments?'))
        return {
          action: 'reply',
          text: 'Here is the three-month option.',
          presentedOfferIds: ['three_installments'],
        };
      if (text.includes('I accept'))
        return {
          action: 'accept_payment_offer',
          offerId: 'three_installments',
          acceptanceQuote: text,
          text: '',
        };
      return { action: 'reply', text: 'Here is your demo loan agreement.' };
    },
  });
  await f.email.start(f.conversationId);
  f.humanReply('options1', 'Can I pay in three installments?');
  await f.email.tick();
  assert.equal(f.sends.length, 2);
  f.humanReply('accept1', 'Yes, I accept the three installment plan.');
  await f.email.tick();
  assert.equal(f.sends.length, 3);
  assert.match(f.sends[2].text, /DEMO-PIX-NOT-PAYABLE/);
  assert.ok(f.workflow.detail(f.conversationId).conversation.agreementId);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
  await f.email.tick();
  assert.equal(f.sends.length, 3);
});

test('an oversized reply cannot starve a later STOP in the same thread', async (t) => {
  const f = await fixture(t);
  await f.email.start(f.conversationId);
  f.humanReply('long1', 'x'.repeat(3000));
  f.humanReply('stop2', 'STOP');
  await f.email.tick();
  assert.equal(f.workflow.detail(f.conversationId).conversation.status, 'opted_out');
  assert.equal(
    one(f.db, "SELECT status FROM email_inbound_receipts WHERE provider_message_id='long1'").status,
    'rejected_too_long',
  );
  assert.equal(f.sends.length, 1);
});

test('agent-requested email runs automatically after observed call end without preview or start', async (t) => {
  const f = await fixture(t, { deliveryChannel: 'email', waitForCallEnd: true });
  await f.email.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.email.status().bindings[0].status, 'active');
  f.workflow.sourceEnded(f.source.provider, f.source.sessionId);
  await f.email.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].attachments.length, 1);
  await f.email.tick();
  assert.equal(f.sends.length, 1);
});

test('missing email setup remains a durable dependency and resumes without per-case activation', async (t) => {
  const f = await fixture(t, { deliveryChannel: 'email' });
  f.config.emailTestEnabled = false;
  await f.email.tick();
  assert.equal(f.email.status().bindings[0].status, 'awaiting_configuration');
  assert.equal(f.sends.length, 0);
  await f.restart();
  f.config.emailTestEnabled = true;
  await f.email.tick();
  assert.equal(f.email.status().bindings[0].status, 'active');
  assert.equal(f.sends.length, 1);
});

test('email offer can be accepted by demo SMS in the same case without sending the SMS reply as email', async (t) => {
  const f = await fixture(t, {
    deliveryChannel: 'email',
    runAgent: async ({ messages, context }) => {
      const text = messages.at(-1)?.content || '';
      if (text.includes('installments?'))
        return {
          action: 'reply',
          text: 'Here is the plan.',
          presentedOfferIds: ['three_installments'],
        };
      if (text.includes('I accept'))
        return {
          action: 'accept_payment_offer',
          offerId: 'three_installments',
          acceptanceQuote: text,
          text: '',
        };
      return { action: 'reply', text: 'Here is your loan agreement.' };
    },
  });
  await f.email.tick();
  assert.equal(f.sends.length, 1);
  f.humanReply('offerCross', 'Can I pay in three installments?');
  await f.email.tick();
  assert.equal(f.sends.length, 2);
  f.workflow.receiveInbound(f.conversationId, {
    text: 'Yes, I accept the three installment plan.',
    requestId: 'sms_accept',
    channel: 'virtual_sms',
  });
  await f.workflow.tick();
  await f.email.tick();
  const detail = f.workflow.detail(f.conversationId);
  assert.ok(detail.conversation.agreementId);
  assert.equal(detail.messages.at(-1).channel, 'virtual_sms');
  assert.match(detail.messages.at(-1).body, /agreement is recorded/);
  assert.equal(f.sends.length, 2);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM agent_conversations').n, 1);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
});
