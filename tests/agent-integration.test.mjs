import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { configuration } from '../server/providers.mjs';
import { one } from '../server/db.mjs';
import { fixture, server } from './helpers.mjs';
import { persistDemoAgreement } from '../server/demo-platform.mjs';
import { isolatedDatabase, executeTestTool } from '../server/browser-voice.mjs';
const offer =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
test('accepted voice agreement waits for source end then continues as one durable virtual SMS conversation', async (t) => {
  const f = fixture(t),
    calls = [];
  const app = createApp(
    f.db,
    configuration({ AGENT_WORKFLOWS_ENABLED: 'true', OPENAI_API_KEY: 'private-model-key' }),
    {
      voiceFetch: async (url) =>
        url.endsWith('/hangup')
          ? new Response(null)
          : Response.json({
              session: { id: 'live_agent_integration' },
              transport: { sdp: 'v=0\r\nanswer' },
            }),
      agentRun: async (input) => {
        calls.push(input);
        return {
          action: 'reply',
          text: input.messages.length
            ? 'I can help you with your agreed schedule.'
            : 'Thanks for agreeing. Here are your demo payment details.',
          model: 'test-model',
          provider: 'test',
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
  async function req(path, body, method = body === undefined ? 'GET' : 'POST') {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(r.ok, await r.clone().text());
    return r.json();
  }
  const s = await req('/voice-test/session', { sdp: offer });
  await req(`/voice-test/${s.id}/tool`, {
    name: 'confirm_identity',
    args: { confirmed: true, name: 'Ana Silva' },
    callId: 'identity',
  });
  const agreement = await req(`/voice-test/${s.id}/tool`, {
    name: 'agree_payment_solution',
    args: { offerId: 'three_installments', accepted: true },
    callId: 'agree',
  });
  const listing = await req('/agent-workflows');
  assert.equal(listing.conversations.length, 1);
  const c = listing.conversations[0];
  assert.equal(c.caseId, agreement.platform.caseId);
  await app.locals.agentWorkflows.tick();
  assert.equal(calls.length, 0);
  await req(`/voice-test/${s.id}`, undefined, 'DELETE');
  await app.locals.agentWorkflows.tick();
  assert.equal(calls.length, 1);
  let d = await req('/agent-workflows/' + c.id);
  assert.equal(d.messages.length, 1);
  assert.equal(d.messages[0].status, 'simulated_delivered');
  const message = { text: 'When is the first installment?', requestId: 'stable-inbound-key' };
  await req(`/agent-workflows/${c.id}/messages`, message);
  await req(`/agent-workflows/${c.id}/messages`, message);
  await app.locals.agentWorkflows.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.length, 2);
  d = await req('/agent-workflows/' + c.id);
  assert.equal(d.messages.length, 3);
  const registry = await req('/agents');
  assert.equal(registry.agents.length, 6);
  assert.ok(!JSON.stringify(registry).includes('private-model-key'));
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  await app.locals.agentWorkflows.closeAll();
});
test('agreement persistence rolls back if durable agent handoff cannot be stored', (t) => {
  const f = fixture(t),
    voice = isolatedDatabase('atomic-agent-test');
  t.after(() => voice.close());
  executeTestTool(voice, 'atomic-agent-test', 'confirm_identity', {
    confirmed: true,
    name: 'Ana Silva',
  });
  const { agreement } = executeTestTool(voice, 'atomic-agent-test', 'agree_payment_solution', {
    offerId: 'three_installments',
    accepted: true,
  });
  assert.throws(
    () =>
      persistDemoAgreement(
        f.db,
        configuration({}),
        { provider: 'openai', sessionId: 'atomic-agent-test', agreement },
        {
          onSaved: () => {
            throw new Error('handoff failed');
          },
        },
      ),
    /handoff failed/,
  );
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM demo_voice_results').n, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM payment_followup_jobs').n, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM cases').n, 1);
});
