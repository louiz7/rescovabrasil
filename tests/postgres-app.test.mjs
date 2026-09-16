import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../server/postgres.mjs';
import { openDb, one } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { configuration } from '../server/providers.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { lookupCaseInformation } from '../server/case-context.mjs';

const url = process.env.TEST_DATABASE_URL;
async function fixture(t, agentRun) {
  const admin = new PostgresDatabase(url);
  const schema = 'test_app_' + process.pid + '_' + Math.random().toString(36).slice(2);
  admin.query('CREATE SCHEMA ' + schema);
  const scoped = new URL(url);
  scoped.searchParams.set('options', '-csearch_path=' + schema);
  const db = openDb(scoped.href);
  const sends = [];
  const config = configuration({ AGENT_WORKFLOWS_ENABLED: 'true', EMAIL_TEST_ENABLED: 'true' });
  const app = createApp(db, config, {
    agentRun,
    emailTransport: {
      status: () => ({ configured: true }),
      verifyMailbox: async () => {},
      getThread: async () => [],
      send: async (input) => {
        input.beforeSend();
        sends.push(input);
        return {
          providerMessageId: 'mock-' + input.id,
          messageId: '<' + input.id + '>',
          threadId: 'thread-' + input.id,
        };
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await app.locals.emailWorkflows.closeAll();
    await app.locals.agentWorkflows.closeAll();
    await app.locals.agentWorkflows.library.closeIngestion();
    await app.locals.voiceTests?.closeAll?.();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
    admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    admin.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/cases')).status, 401);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: config.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function req(path, body) {
    const response = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, path + ': ' + (await response.clone().text()));
    return response.json();
  }
  return { db, app, config, req, sends };
}

test(
  'PostgreSQL authenticated app imports a portfolio, serves case details, and retrieves uploaded document evidence',
  { skip: !url },
  async (t) => {
    const f = await fixture(t, async () => ({ action: 'reply', text: 'Ready.' }));
    const portfolio = await f.req('/portfolios', {
      name: 'Postgres integration portfolio',
      creditor: 'Integration Bank',
    });
    const csv =
      'referencia,nome,telefone,email,saldo,vencimento\nPG-1,Ana Silva,11987654321,ana@example.test,1200,2025-01-31\n';
    const staged = await f.req('/imports', {
      portfolioId: portfolio.id,
      filename: 'cases.csv',
      content: Buffer.from(csv).toString('base64'),
    });
    await f.req('/imports/' + staged.id + '/preview', { mapping: staged.mapping });
    await f.req('/imports/' + staged.id + '/commit', {
      mapping: staged.mapping,
      selectedRows: [2],
    });
    const list = await f.req('/cases?portfolio=' + portfolio.id);
    assert.equal(list.rows.length, 1);
    const caseId = list.rows[0].id;
    const detail = await f.req('/cases/' + caseId);
    assert.equal(detail.creditor, 'Integration Bank');
    await f.req('/cases/' + caseId + '/documents', {
      title: 'Integration contract',
      kind: 'loan_agreement',
      content:
        'Monthly installments are payable according to the approved schedule. Interest is fixed.',
    });
    const evidence = lookupCaseInformation(f.db, caseId, {
      topic: 'document_search',
      query: 'installments',
    });
    assert.equal(evidence.items.length, 1);
    assert.equal(evidence.items[0].title, 'Integration contract');
    assert.ok(evidence.items[0].untrustedContent);
    const failures = [];
    for (const path of [
      '/dashboard',
      '/portfolios',
      '/portfolios/' + portfolio.id,
      '/imports',
      '/imports/' + staged.id + '/report',
      '/agents',
      '/agent-workflows',
      '/agent-workflows/escalations',
    ]) {
      try {
        await f.req(path);
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  'PostgreSQL app delivers a mocked email offer and saves SMS acceptance exactly once with shared case context',
  { skip: !url },
  async (t) => {
    const seen = [];
    const f = await fixture(t, async ({ context, messages }) => {
      seen.push(context);
      if (context.purpose === 'document_followup')
        return {
          action: 'reply',
          text: 'Here is your document and approved installment option.',
          presentedOfferIds: ['three_installments'],
        };
      return {
        action: 'accept_payment_offer',
        offerId: 'three_installments',
        acceptanceQuote: messages.at(-1).content,
        text: '',
      };
    });
    const source = { provider: 'openai', sessionId: 'pg-cross-channel' };
    const saved = ensureDemoVoiceCase(f.db, f.config, source);
    const workflows = f.app.locals.agentWorkflows;
    const { conversationId } = workflows.documentRequested({
      ...source,
      caseId: saved.caseId,
      kind: 'loan_agreement',
      requestId: 'contract',
      deliveryChannel: 'email',
    });
    workflows.sourceEnded(source.provider, source.sessionId);
    await workflows.tick();
    await f.app.locals.emailWorkflows.tick();
    assert.equal(f.sends.length, 1);
    assert.equal(one(f.db, 'SELECT status FROM email_deliveries').status, 'submitted');
    const message = {
      text: 'Yes, I accept the three installment plan.',
      requestId: 'pg-sms-accept',
    };
    await f.req('/agent-workflows/' + conversationId + '/messages', message);
    await workflows.tick();
    const detail = await f.req('/agent-workflows/' + conversationId);
    assert.ok(detail.conversation.agreementId);
    assert.equal(detail.messages.at(-1).channel, 'virtual_sms');
    assert.match(detail.messages.at(-1).body, /payment agreement is recorded/);
    assert.ok(seen.at(-1).conversationHistory.some((m) => m.channel === 'email'));
    await f.req('/agent-workflows/' + conversationId + '/messages', message);
    await workflows.tick();
    await f.app.locals.emailWorkflows.tick();
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 1);
    assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_followup_jobs').n, 1);
    assert.equal(f.sends.length, 1);
    await f.req('/cases/' + saved.caseId);
  },
);
