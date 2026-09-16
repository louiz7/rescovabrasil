import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createBrowserVoiceTests,
  isolatedDatabase,
  executeTestTool,
} from '../server/browser-voice.mjs';
import { run } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { configuration } from '../server/providers.mjs';
import { fixture, server } from './helpers.mjs';

test('document tool requires identity, rejects unknown kinds and stopped case states, needs no agreement', (t) => {
  const db = isolatedDatabase('doc-test');
  t.after(() => db.close());
  const request = () =>
    executeTestTool(db, 'doc-test', 'request_case_document', { kind: 'loan_agreement' });
  assert.throws(request, /Confirm the named person/);
  executeTestTool(db, 'doc-test', 'confirm_identity', { confirmed: true, name: 'Ana Silva' });
  assert.deepEqual(request(), {
    documentRequested: true,
    kind: 'loan_agreement',
    deliveryChannel: 'sms',
  });
  assert.throws(() => executeTestTool(db, 'doc-test', 'request_case_document', { kind: 'other' }));
  for (const deliveryChannel of ['sms', 'email', null]) {
    assert.equal(
      executeTestTool(db, 'doc-test', 'request_case_document', {
        kind: 'loan_agreement',
        deliveryChannel,
      }).deliveryChannel,
      deliveryChannel ?? 'sms',
    );
  }
  assert.throws(() =>
    executeTestTool(db, 'doc-test', 'request_case_document', {
      kind: 'loan_agreement',
      deliveryChannel: 'whatsapp',
    }),
  );
  assert.throws(() =>
    executeTestTool(db, 'doc-test', 'request_case_document', {
      kind: 'loan_agreement',
      caseId: 'other',
    }),
  );
  for (const outcome of [
    'opt_out',
    'invalid_contact',
    'human_review',
    'disputed',
    'paid_reported',
  ]) {
    run(db, 'UPDATE cases SET outcome=?', outcome);
    assert.throws(request, /stopped or awaits case resolution/);
  }
  run(db, 'UPDATE cases SET outcome=NULL,suppressed=1');
  assert.throws(request);
  run(db, 'UPDATE cases SET suppressed=0,review_required=1');
  assert.throws(request);
});

for (const [configured, deliveryChannel, deliveryStatus] of [
  [false, undefined],
  [true, undefined],
  [true, 'email', 'queued'],
  [true, 'email', 'awaiting_configuration'],
]) {
  test(`browser document callback ${configured ? 'persists once with tool ID' : 'fails without claiming a saved request'} (${deliveryChannel ?? 'default'}, ${deliveryStatus ?? 'virtual'})`, async (t) => {
    const calls = [];
    const voice = createBrowserVoiceTests(
      { openaiKey: 'test' },
      {
        fetchImpl: async (url) =>
          url.endsWith('/hangup')
            ? new Response()
            : Response.json({ session: { id: 'provider' }, transport: { sdp: 'v=0\r\nanswer' } }),
        ...(configured
          ? {
              onDocument: (input) => {
                calls.push(input);
                return {
                  request: { id: 'request-1' },
                  delivery: {
                    channel: deliveryChannel ?? 'sms',
                    status: deliveryStatus ?? 'queued',
                    reason:
                      deliveryStatus === 'awaiting_configuration' ? 'Gmail setup required' : null,
                  },
                };
              },
            }
          : {}),
      },
    );
    t.after(() => voice.closeAll());
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.sessionToken = 'operator';
      next();
    });
    app.use(voice.router);
    const base = await server(t, app);
    const post = async (path, body) =>
      (
        await fetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const session = await post('/session', { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
    await post(`/${session.id}/tool`, {
      name: 'confirm_identity',
      args: { confirmed: true, name: 'Ana Silva' },
      callId: 'identity',
    });
    const body = {
      name: 'request_case_document',
      args: { kind: 'account_statement', ...(deliveryChannel ? { deliveryChannel } : {}) },
      callId: 'document-call',
    };
    const result = await post(`/${session.id}/tool`, body);
    assert.deepEqual(await post(`/${session.id}/tool`, body), result);
    if (configured) {
      assert.equal(result.documentRequested, true);
      assert.equal(result.platform.request.id, 'request-1');
      assert.equal(result.platform.delivery.channel, deliveryChannel ?? 'sms');
      assert.equal(result.platform.delivery.status, deliveryStatus ?? 'queued');
      if (deliveryStatus === 'awaiting_configuration')
        assert.equal(result.platform.delivery.reason, 'Gmail setup required');
      assert.deepEqual(calls, [
        {
          sessionId: session.id,
          kind: 'account_statement',
          deliveryChannel: deliveryChannel ?? 'sms',
          requestId: 'document-call',
        },
      ]);
    } else {
      assert.ok(result.error);
      assert.equal(result.documentRequested, undefined);
      assert.equal(calls.length, 0);
    }
  });
}

test('authenticated document-only call hands off after end, delivers exact attachment and retains context in replies', async (t) => {
  const f = fixture(t),
    calls = [];
  const app = createApp(
    f.db,
    configuration({ AGENT_WORKFLOWS_ENABLED: 'true', OPENAI_API_KEY: 'test' }),
    {
      voiceFetch: async (url) =>
        url.endsWith('/hangup')
          ? new Response()
          : Response.json({
              session: { id: 'document-integration' },
              transport: { sdp: 'v=0\r\nanswer' },
            }),
      agentRun: async (input) => {
        calls.push(input);
        return {
          action: 'reply',
          text: 'Here is the fictional document you requested.',
          provider: 'test',
          model: 'test',
        };
      },
    },
  );
  const base = await server(t, app);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'rescova-demo' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const voice = await req('/voice-test/session', {
    sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
  });
  await req(`/voice-test/${voice.id}/tool`, {
    name: 'confirm_identity',
    args: { confirmed: true, name: 'Ana Silva' },
    callId: 'identity',
  });
  const body = {
    name: 'request_case_document',
    args: { kind: 'loan_agreement' },
    callId: 'request-document',
  };
  const saved = await req(`/voice-test/${voice.id}/tool`, body);
  assert.equal(saved.documentRequested, true);
  assert.ok(saved.platform.documentRequestId);
  assert.deepEqual(await req(`/voice-test/${voice.id}/tool`, body), saved);
  const { conversationId, caseId } = saved.platform;
  await app.locals.agentWorkflows.tick();
  assert.equal(calls.length, 0);
  assert.equal((await req('/agent-workflows/' + conversationId)).messages.length, 0);
  await req(`/voice-test/${voice.id}`, undefined, 'DELETE');
  await app.locals.agentWorkflows.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.agreement, null);
  assert.equal(calls[0].context.documentResult.kind, 'loan_agreement');
  const detail = await req('/agent-workflows/' + conversationId);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].status, 'simulated_delivered');
  assert.equal(detail.messages[0].documents.length, 1);
  const attachment = detail.messages[0].documents[0];
  assert.equal((await fetch(base + attachment.url)).status, 401);
  const download = await fetch(base + attachment.url, { headers: { cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match(await download.text(), /FICTIONAL DEMO/);
  assert.equal(calls[0].context.documentResult.content, undefined);
  const wrongCase = attachment.url.replace(caseId, f.cases[0].id);
  assert.equal((await fetch(base + wrongCase, { headers: { cookie } })).status, 404);
  await req(`/agent-workflows/${conversationId}/messages`, {
    text: 'What does this document say?',
    requestId: 'question-about-document',
  });
  await app.locals.agentWorkflows.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].context.deliveredDocuments[0].id, attachment.id);
  assert.equal(calls[1].messages.length, 2);
  await app.locals.agentWorkflows.closeAll();
});

test('spoken email request automatically delivers after call end without manual activation', async (t) => {
  const f = fixture(t);
  const sends = [];
  const app = createApp(
    f.db,
    configuration({
      AGENT_WORKFLOWS_ENABLED: 'true',
      OPENAI_API_KEY: 'test',
      EMAIL_TEST_ENABLED: 'true',
    }),
    {
      voiceFetch: async (url) =>
        url.endsWith('/hangup')
          ? new Response()
          : Response.json({
              session: { id: 'email-voice-integration' },
              transport: { sdp: 'v=0\r\nanswer' },
            }),
      agentRun: async () => ({
        action: 'reply',
        text: 'Here is your requested fictional loan agreement.',
        provider: 'test',
        model: 'test',
      }),
      emailTransport: {
        status: () => ({ configured: true }),
        verifyMailbox: async () => ({ emailAddress: 'louiz@rescova.de' }),
        getThread: async () => [],
        async send(input) {
          await input.beforeSend();
          sends.push(input);
          return {
            providerMessageId: 'voice-email-1',
            threadId: 'voice-thread-1',
            messageId: `<${input.id}@rescova.de>`,
          };
        },
      },
    },
  );
  t.after(async () => {
    await app.locals.emailWorkflows.closeAll();
    await app.locals.agentWorkflows.closeAll();
    await app.locals.browserVoiceTests?.closeAll();
  });
  const base = await server(t, app);
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'rescova-demo' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (path, body, method = 'POST') => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const voice = await req('/voice-test/session', {
    sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
  });
  await req(`/voice-test/${voice.id}/tool`, {
    name: 'confirm_identity',
    args: { confirmed: true, name: 'Ana Silva' },
    callId: 'name',
  });
  const tool = {
    name: 'request_case_document',
    args: { kind: 'loan_agreement', deliveryChannel: 'email' },
    callId: 'email-doc',
  };
  const saved = await req(`/voice-test/${voice.id}/tool`, tool);
  assert.equal(saved.documentRequested, true);
  assert.equal(saved.platform.delivery.channel, 'email');
  assert.equal(saved.platform.delivery.status, 'queued');
  assert.deepEqual(await req(`/voice-test/${voice.id}/tool`, tool), saved);
  await app.locals.agentWorkflows.tick();
  await app.locals.emailWorkflows.tick();
  assert.equal(sends.length, 0);
  await req(`/voice-test/${voice.id}`, undefined, 'DELETE');
  await app.locals.agentWorkflows.tick();
  await app.locals.emailWorkflows.tick();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].attachments.length, 1);
  assert.match(sends[0].attachments[0].content, /Ana Silva/);
  await app.locals.emailWorkflows.tick();
  assert.equal(sends.length, 1);
  const detail = app.locals.agentWorkflows.detail(saved.platform.conversationId);
  assert.equal(detail.messages[0].channel, 'email');
  assert.equal(detail.messages[0].delivery.status, 'submitted');
});
