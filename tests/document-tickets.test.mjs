import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb, one, all, run } from '../server/db.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { createEmailWorkflows } from '../server/email-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { agentTaskList } from '../server/agent-task-list.mjs';
import { getDocumentTicket } from '../server/document-tickets.mjs';

async function fixture(t, backend, options = {}) {
  let admin, schema;
  let db;
  if (backend === 'postgres') {
    admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
    schema = 'tickets_' + process.pid + '_' + Math.random().toString(36).slice(2);
    admin.query('CREATE SCHEMA ' + schema);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', '-csearch_path=' + schema);
    db = openDb(url.href);
  } else db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true, emailTestEnabled: true };
  const source = { provider: 'openai', sessionId: 'durable-document-ticket' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const sends = [];
  let calls = 0;
  const runAgent = async (input) => {
    calls++;
    return options.runAgent
      ? options.runAgent(input)
      : { action: 'reply', text: 'Here is your requested agreement.' };
  };
  const transport = {
    status: () => ({ configured: true }),
    verifyMailbox: async () => ({ emailAddress: 'louiz@rescova.de' }),
    getThread: async () => [],
    async send(input) {
      await input.beforeSend();
      sends.push(input);
      if (options.uncertain)
        throw Object.assign(new Error('Mock timeout after submission'), { uncertain: true });
      return {
        providerMessageId: 'mock-message-' + sends.length,
        threadId: 'mock-thread',
        messageId: '<' + input.id + '@rescova.test>',
      };
    },
  };
  let workflow = createAgentWorkflows(db, config, { runAgent });
  let email = createEmailWorkflows(db, config, workflow, { transport });
  const app = express();
  app.use(express.json());
  app.use('/documents/:caseId', (req, res, next) => workflow.library.router(req, res, next));
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const input = {
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'request-original',
    deliveryChannel: 'email',
  };
  t.after(async () => {
    await email.closeAll();
    await workflow.closeAll();
    await workflow.library.closeIngestion();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
    if (admin) {
      admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      admin.close();
    }
  });
  return {
    db,
    config,
    input,
    saved,
    sends,
    get calls() {
      return calls;
    },
    get workflow() {
      return workflow;
    },
    get email() {
      return email;
    },
    end() {
      workflow.sourceEnded(source.provider, source.sessionId);
    },
    ticket(id) {
      return getDocumentTicket(db, id);
    },
    async drain() {
      await workflow.tick();
      await email.tick();
    },
    async restart() {
      await email.closeAll();
      await workflow.closeAll();
      await workflow.library.closeIngestion();
      workflow = createAgentWorkflows(db, config, { runAgent });
      email = createEmailWorkflows(db, config, workflow, { transport });
    },
    async upload({ title, content }) {
      const response = await fetch(
        'http://127.0.0.1:' + server.address().port + '/documents/' + saved.caseId,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, content, kind: 'loan_agreement' }),
        },
      );
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).document;
    },
  };
}

for (const backend of ['sqlite', 'postgres']) {
  const opts = { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL };
  test(
    backend +
      ': document ticket deduplicates, waits for source end, survives worker recreation and completes only with exact provider receipt',
    opts,
    async (t) => {
      const f = await fixture(t, backend);
      const request = f.workflow.documentRequested(f.input);
      assert.ok(request.ticketId);
      const duplicate = f.workflow.documentRequested({
        ...f.input,
        deliveryChannel: 'virtual_sms',
      });
      assert.equal(duplicate.ticketId, request.ticketId);
      assert.equal(f.ticket(request.ticketId).channel, 'email');
      await f.drain();
      assert.equal(f.calls, 0);
      assert.equal(f.sends.length, 0);
      assert.equal(f.ticket(request.ticketId).status, 'waiting_source_end');
      await f.restart();
      f.end();
      await f.workflow.tick();
      assert.ok(
        ['awaiting_delivery', 'awaiting_configuration'].includes(f.ticket(request.ticketId).status),
      );
      assert.equal(f.sends.length, 0);
      await f.email.tick();
      const ticket = f.ticket(request.ticketId);
      assert.equal(ticket.status, 'completed');
      const projected = agentTaskList(f.db, { state: 'all' });
      assert.equal(
        projected.rows.length,
        1,
        'Linked draft and email appear only within their parent ticket',
      );
      assert.equal(projected.rows[0].source, 'document_ticket');
      assert.equal(projected.counts.completed, 1);
      assert.ok(ticket.completedAt);
      const receipt = one(f.db, 'SELECT * FROM email_deliveries WHERE id=?', ticket.deliveryId);
      assert.ok(receipt);
      assert.equal(receipt.status, 'submitted');
      assert.equal(receipt.provider_message_id, 'mock-message-1');
      assert.equal(receipt.message_id, ticket.messageId);
      const attachment = one(
        f.db,
        'SELECT * FROM agent_message_documents WHERE message_id=?',
        ticket.messageId,
      );
      assert.equal(attachment.document_id, ticket.documentId);
      assert.equal(f.sends.length, 1);
      assert.equal(f.sends[0].attachments.length, 1);
      await f.restart();
      f.workflow.documentRequested(f.input);
      await f.drain();
      assert.equal(f.sends.length, 1);
      assert.equal(one(f.db, 'SELECT COUNT(*) n FROM document_tickets').n, 1);
      assert.equal(
        one(f.db, 'SELECT COUNT(*) n FROM agent_jobs WHERE purpose=?', 'document_followup').n,
        1,
      );
    },
  );

  test(
    backend +
      ': a pinned document version remains unchanged when a newer version arrives before delivery',
    opts,
    async (t) => {
      const f = await fixture(t, backend);
      const request = f.workflow.documentRequested(f.input);
      f.end();
      await f.workflow.tick();
      const pinned = f.ticket(request.ticketId);
      const original = one(f.db, 'SELECT * FROM case_documents WHERE id=?', pinned.documentId);
      assert.ok(original);
      const next = await f.upload({
        title: original.title,
        content: 'A different version uploaded after the original was selected.',
      });
      assert.equal(next.version, original.version + 1);
      await f.restart();
      await f.drain();
      assert.equal(f.ticket(request.ticketId).documentId, original.id);
      assert.equal(f.ticket(request.ticketId).documentVersion, original.version);
      assert.equal(f.sends.length, 1);
      assert.equal(f.sends[0].attachments[0].content, original.content);
    },
  );

  test(
    backend +
      ': missing document stays owned and resumes automatically after upload without creating another ticket',
    opts,
    async (t) => {
      const f = await fixture(t, backend);
      run(
        f.db,
        "DELETE FROM case_documents WHERE case_id=? AND kind='loan_agreement'",
        f.saved.caseId,
      );
      const request = f.workflow.documentRequested({ ...f.input, deliveryChannel: 'virtual_sms' });
      f.end();
      await f.workflow.tick();
      assert.equal(f.ticket(request.ticketId).status, 'waiting_information');
      assert.ok(f.ticket(request.ticketId).owner);
      assert.ok(f.ticket(request.ticketId).nextAction);
      assert.equal(f.calls, 0);
      assert.equal(f.workflow.detail(request.conversationId).messages.length, 0);
      await f.restart();
      const uploaded = await f.upload({
        title: 'Available later',
        content: 'Fictional agreement supplied after the request.',
      });
      await f.workflow.tick();
      await f.workflow.tick();
      const ticket = f.ticket(request.ticketId);
      assert.equal(ticket.status, 'simulated_completed');
      assert.equal(ticket.documentId, uploaded.id);
      assert.equal(one(f.db, 'SELECT COUNT(*) n FROM document_tickets').n, 1);
      assert.equal(f.workflow.detail(request.conversationId).messages.length, 1);
      assert.equal(f.sends.length, 0);
    },
  );

  test(
    backend + ': deadline expiry stops queued work without invoking the model or provider',
    opts,
    async (t) => {
      const f = await fixture(t, backend);
      const request = f.workflow.documentRequested(f.input);
      run(
        f.db,
        "UPDATE document_tickets SET deadline_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        request.ticketId,
      );
      f.end();
      await f.drain();
      assert.equal(f.ticket(request.ticketId).status, 'failed');
      assert.equal(f.calls, 0);
      assert.equal(f.sends.length, 0);
    },
  );

  test(
    backend + ': uncertain provider result never completes or automatically resends after restart',
    opts,
    async (t) => {
      const f = await fixture(t, backend, { uncertain: true });
      const request = f.workflow.documentRequested(f.input);
      f.end();
      await f.drain();
      assert.equal(f.ticket(request.ticketId).status, 'uncertain');
      assert.equal(f.sends.length, 1);
      assert.equal(f.ticket(request.ticketId).completedAt, null);
      await f.restart();
      await f.drain();
      await f.drain();
      assert.equal(f.ticket(request.ticketId).status, 'uncertain');
      assert.equal(f.sends.length, 1);
    },
  );

  test(
    backend +
      ': STOP received during drafting cancels the parent ticket and prevents external submission',
    opts,
    async (t) => {
      let release, entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const f = await fixture(t, backend, {
        runAgent: async () => {
          entered();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      const request = f.workflow.documentRequested(f.input);
      f.end();
      const pending = f.workflow.tick();
      await started;
      f.workflow.receiveInbound(request.conversationId, {
        text: 'STOP',
        requestId: 'stop-ticket',
        channel: 'virtual_sms',
      });
      release({ action: 'reply', text: 'This draft must not be delivered.' });
      await pending;
      await f.email.tick();
      assert.equal(f.ticket(request.ticketId).status, 'cancelled');
      assert.equal(f.sends.length, 0);
      assert.equal(all(f.db, "SELECT * FROM agent_messages WHERE direction='outbound'").length, 0);
    },
  );

  test(
    backend + ': transient drafting failures retry only up to the ticket attempt limit',
    opts,
    async (t) => {
      const f = await fixture(t, backend, {
        runAgent: async () => {
          throw new Error('Mock model unavailable');
        },
      });
      const request = f.workflow.documentRequested(f.input);
      f.end();
      for (let i = 0; i < 6; i++) {
        run(
          f.db,
          "UPDATE agent_jobs SET due_at='2000-01-01T00:00:00.000Z' WHERE conversation_id=?",
          request.conversationId,
        );
        await f.workflow.tick();
      }
      const ticket = f.ticket(request.ticketId);
      assert.equal(ticket.status, 'failed');
      assert.equal(f.calls, ticket.maxAttempts);
      assert.equal(ticket.attempts, ticket.maxAttempts);
      assert.equal(f.sends.length, 0);
      await f.restart();
      await f.drain();
      assert.equal(f.calls, ticket.maxAttempts);
    },
  );
}
