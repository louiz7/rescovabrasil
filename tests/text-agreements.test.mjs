import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../server/postgres.mjs';
import { openDb, one, run } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';

const config = { mode: 'demo', agentWorkflowsEnabled: true };
async function fixture(
  t,
  {
    offerId = 'three_installments',
    quote,
    present = true,
    repeatSupervisorAcceptance = false,
    multipleOffers = false,
  } = {},
) {
  let admin, schema;
  let db;
  if (process.env.TEST_DATABASE_URL) {
    admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
    schema = 'consent_' + process.pid + '_' + Math.random().toString(36).slice(2);
    admin.query('CREATE SCHEMA ' + schema);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', '-csearch_path=' + schema);
    db = openDb(url.href);
  } else db = openDb();
  const source = { provider: 'openai', sessionId: 'written-acceptance' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async ({ context, messages, supervisor }) => {
      if (supervisor && repeatSupervisorAcceptance)
        return {
          action: 'accept_payment_offer',
          offerId,
          acceptanceQuote: 'Yes, I accept.',
          text: 'Accept the plan.',
        };
      if (supervisor)
        return {
          action: 'awaiting_information',
          text: 'Please clarify the selected offer.',
          reason: 'Need clear current consent.',
        };
      if (context.purpose === 'document_followup')
        return { action: 'reply', text: 'Here is the document.' };
      if (messages.at(-1).content === 'What are my options?')
        return {
          action: 'reply',
          text: 'The approved plan has three monthly installments.',
          presentedOfferIds: present
            ? multipleOffers
              ? ['three_installments', 'six_installments']
              : ['three_installments']
            : [],
        };
      return {
        action: 'accept_payment_offer',
        offerId,
        acceptanceQuote: quote ?? messages.at(-1).content,
        text: 'Record the selected offer.',
      };
    },
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
    if (admin) {
      admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      admin.close();
    }
  });
  const { conversationId } = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'document',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  workflow.receiveInbound(conversationId, { text: 'What are my options?', requestId: 'options' });
  await workflow.tick();
  return {
    db,
    workflow,
    conversationId,
    async accept(text = 'Yes, I accept the three installment plan.', requestId = 'accept') {
      workflow.receiveInbound(conversationId, { text, requestId });
      await workflow.tick();
    },
  };
}

test('written acceptance persists shared agreement and payment details once, survives duplicate and repeated acceptance', async (t) => {
  const f = await fixture(t);
  f.workflow.setDeliveryChannel(f.conversationId, 'email');
  f.db.exec('CREATE TABLE email_deliveries(message_id TEXT, status TEXT)');
  const presentation = one(f.db, 'SELECT message_id FROM agent_presented_offers');
  run(f.db, 'INSERT INTO email_deliveries VALUES (?,?)', presentation.message_id, 'submitted');
  assert.equal(f.workflow.deliveryContext(f.conversationId).context.channel, 'email');
  await f.accept();
  const first = f.workflow.detail(f.conversationId);
  assert.ok(first.conversation.agreementId);
  assert.match(first.messages.at(-1).body, /agreement is recorded/);
  assert.match(first.messages.at(-1).body, /DEMO-PIX-NOT-PAYABLE/);
  assert.doesNotMatch(first.messages.at(-1).body, /Simulated SMS/);
  await f.accept();
  await f.accept('Yes, I accept the three installment plan.', 'accept-again');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_followup_jobs').n, 1);
  assert.equal(
    f.workflow.detail(f.conversationId).conversation.agreementId,
    first.conversation.agreementId,
  );
});

for (const scenario of [
  { name: 'question', text: 'Can I accept the plan?' },
  { name: 'negated consent', text: 'I do not accept the plan.' },
  { name: 'fabricated quote', text: 'Please explain it.', quote: 'I accept' },
  { name: 'unauthorized offer', text: 'Yes, I accept.', offerId: 'invented_offer' },
  { name: 'unexplained offer', text: 'Yes, I accept.', present: false },
])
  test(`written agreement rejects ${scenario.name} without saving an agreement`, async (t) => {
    const f = await fixture(t, scenario);
    await f.accept(scenario.text);
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
    const ordinaryClarification = ['question', 'negated consent', 'fabricated quote'].includes(
      scenario.name,
    );
    assert.equal(
      f.workflow.detail(f.conversationId).conversation.status,
      ordinaryClarification ? 'active' : 'awaiting_information',
    );
    if (ordinaryClarification)
      assert.equal(
        one(f.db, "SELECT COUNT(*) n FROM agent_jobs WHERE purpose='supervisor_review'").n,
        0,
      );
  });

test('stale offer cannot move due dates silently when accepting', async (t) => {
  const f = await fixture(t);
  const stored = one(f.db, 'SELECT offer_json FROM agent_presented_offers');
  const offer = JSON.parse(stored.offer_json);
  offer.expiresOn = '2000-01-01';
  run(f.db, 'UPDATE agent_presented_offers SET offer_json=?', JSON.stringify(offer));
  await f.accept();
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
});

test('agreement amendment is not permitted through a second acceptance', async (t) => {
  const f = await fixture(t);
  await f.accept();
  const before = one(f.db, 'SELECT agreement_json FROM demo_voice_results').agreement_json;
  run(
    f.db,
    'UPDATE demo_voice_results SET agreement_json=?',
    JSON.stringify({ ...JSON.parse(before), offerId: 'six_installments' }),
  );
  await f.accept('Yes, I accept.', 'different-offer');
  assert.equal(
    JSON.parse(one(f.db, 'SELECT agreement_json FROM demo_voice_results').agreement_json).offerId,
    'six_installments',
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
});

test('presented offers include exact deterministic compact terms even when model gives only an introduction', async (t) => {
  const f = await fixture(t);
  const message = f.workflow.detail(f.conversationId).messages.at(-1).body;
  assert.match(message, /Total: BRL 1250.00/);
  assert.match(message, /3 monthly payments: 2 × BRL 416.67 and 1 × BRL 416.66/);
  assert.match(message, /First due \d{4}-\d{2}-\d{2}; final due \d{4}-\d{2}-\d{2}/);
  assert.match(message, /Interest: 0%/);
  await f.accept('Yes.');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
});

for (const deliveryStatus of ['queued', 'failed', 'uncertain', null])
  test(`email consent cannot accept an offer with delivery state ${deliveryStatus}`, async (t) => {
    const f = await fixture(t);
    f.workflow.setDeliveryChannel(f.conversationId, 'email');
    run(
      f.db,
      "UPDATE agent_messages SET channel='email' WHERE id IN (SELECT message_id FROM agent_presented_offers)",
    );
    if (deliveryStatus) {
      f.db.exec('CREATE TABLE email_deliveries(message_id TEXT, status TEXT)');
      const presentation = one(f.db, 'SELECT message_id FROM agent_presented_offers');
      run(
        f.db,
        'INSERT INTO email_deliveries VALUES (?,?)',
        presentation.message_id,
        deliveryStatus,
      );
    }
    await f.accept();
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
    assert.equal(f.workflow.detail(f.conversationId).conversation.status, 'awaiting_information');
  });

test('installment selection prompts once without Rafael and explicit confirmation then succeeds', async (t) => {
  const f = await fixture(t, { multipleOffers: true });
  await f.accept('3 installments please');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
  assert.match(f.workflow.detail(f.conversationId).messages.at(-1).body, /Please reply/);
  assert.equal(
    one(f.db, "SELECT COUNT(*) n FROM agent_jobs WHERE purpose='supervisor_review'").n,
    0,
  );
  const before = f.workflow.detail(f.conversationId).messages.length;
  for (let i = 0; i < 5; i++) await f.workflow.tick();
  assert.equal(f.workflow.detail(f.conversationId).messages.length, before);
  await f.accept('I accept the 3-installment plan', 'explicit-confirmation');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
});

test('supervisor payment validation failure cannot recursively enqueue another supervisor', async (t) => {
  const f = await fixture(t, { present: false, repeatSupervisorAcceptance: true });
  run(
    f.db,
    'INSERT INTO agent_escalations VALUES (?,?,?,?,?,?,?,?,?)',
    'old-escalation',
    'old-loop',
    f.conversationId,
    'marina_uncertainty',
    'Previous loop',
    'queued',
    'Review',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await f.accept('Yes, I accept.');
  for (let i = 0; i < 6; i++) await f.workflow.tick();
  assert.equal(
    one(f.db, "SELECT COUNT(*) n FROM agent_jobs WHERE purpose='supervisor_review'").n,
    1,
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
  assert.equal(f.workflow.detail(f.conversationId).conversation.status, 'awaiting_specialist');
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM agent_escalations WHERE status='queued'").n, 0);
});
