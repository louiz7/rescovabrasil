import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { configuration } from '../server/providers.mjs';
import { one } from '../server/db.mjs';
import { fixture, server } from './helpers.mjs';

const offer =
  'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
async function login(base) {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'rescova-demo' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
function request(base, cookie, path, body, method = 'POST') {
  return fetch(base + '/api/voice-test' + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
test('browser voice uses authenticated isolated synthetic context and never mutates portfolio cases', async (t) => {
  const f = fixture(t),
    calls = [];
  const voiceFetch = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/hangup')) return new Response(null, { status: 200 });
    assert.equal(url, 'https://api.openai.com/v1/live/sessions');
    assert.equal(options.headers.Authorization, 'Bearer sk-test-private');
    const payload = JSON.parse(options.body);
    assert.equal(payload.transport.sdp, offer);
    assert.equal(payload.transport.type, 'webrtc');
    const session = payload.session;
    assert.equal(session.model, 'gpt-live-1');
    assert.equal(session.delegation.type, 'responses');
    assert.equal(session.delegation.responses.model, 'gpt-5.6-terra');
    assert.equal(session.delegation.responses.parallel_tool_calls, false);
    assert.ok(!session.audio?.input?.turn_detection);
    assert.ok(session.instructions.includes('BROWSER-TEST-001'));
    assert.ok(session.instructions.includes('Ana Silva'));
    assert.match(session.instructions, /English/);
    assert.ok(!session.instructions.includes('Fale exclusivamente em português brasileiro'));
    assert.ok(!session.instructions.includes(f.cases[0].reference));
    assert.ok(session.delegation.responses.tools.some((x) => x.name === 'confirm_identity'));
    assert.ok(session.delegation.responses.instructions.includes('BROWSER-TEST-001'));
    return Response.json(
      { session: { id: 'live_test123' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } },
      { status: 201 },
    );
  };
  const app = createApp(f.db, configuration({ OPENAI_API_KEY: 'sk-test-private' }), { voiceFetch });
  const base = await server(t, app);
  assert.equal((await fetch(base + '/api/voice-test')).status, 401);
  const cookie = await login(base),
    other = await login(base);
  const config = await (await request(base, cookie, '', undefined, 'GET')).json();
  assert.equal(config.available, true);
  assert.ok(!JSON.stringify(config).includes('sk-test-private'));
  assert.equal((await request(base, cookie, '/session', { sdp: 'invalid' })).status, 400);
  const created = await request(base, cookie, '/session', { sdp: offer });
  assert.equal(created.status, 200);
  const session = await created.json();
  assert.equal(session.sdp, 'v=0\r\nanswer');
  assert.ok(!JSON.stringify(session).includes('sk-test-private'));
  const endpoint = '/' + session.id + '/tool';
  assert.ok(
    [403, 404].includes(
      (
        await request(base, other, endpoint, {
          name: 'confirm_identity',
          args: { confirmed: true, name: 'Ana Silva' },
          callId: 'c1',
        })
      ).status,
    ),
  );
  const identity = {
    name: 'confirm_identity',
    args: { confirmed: true, name: 'Ana Silva' },
    callId: 'c1',
  };
  assert.equal((await (await request(base, cookie, endpoint, identity)).json()).confirmed, true);
  const outcome = {
    name: 'record_outcome',
    args: { outcome: 'paid_reported', note: 'Already paid, requires review.' },
    callId: 'c2',
  };
  const result = await (await request(base, cookie, endpoint, outcome)).json();
  assert.equal(result.recorded, true);
  assert.deepEqual(await (await request(base, cookie, endpoint, outcome)).json(), result);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM cases').n, 1);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 0);
  assert.equal(one(f.db, 'SELECT outcome FROM cases').outcome, null);
  assert.equal((await request(base, cookie, '/' + session.id, undefined, 'DELETE')).status, 200);
  assert.ok(calls.some((url) => url.endsWith('/hangup')));
  assert.ok([404, 410].includes((await request(base, cookie, endpoint, identity)).status));
});
test('browser voice missing key and provider rejection fail clearly without leaking secrets', async (t) => {
  const f = fixture(t);
  let count = 0;
  const missing = createApp(f.db, configuration({}), {
    voiceFetch: async () => {
      count++;
    },
  });
  const base = await server(t, missing),
    cookie = await login(base);
  assert.equal((await (await request(base, cookie, '', undefined, 'GET')).json()).available, false);
  assert.ok((await request(base, cookie, '/session', { sdp: offer })).status >= 400);
  assert.equal(count, 0);
  const app = createApp(f.db, configuration({ OPENAI_API_KEY: 'sk-test-private' }), {
    voiceFetch: async () => new Response('secret sk-test-private', { status: 401 }),
  });
  const second = await server(t, app),
    auth = await login(second);
  const rejected = await request(second, auth, '/session', { sdp: offer });
  assert.ok(rejected.status >= 400);
  const body = await rejected.text();
  assert.ok(!body.includes('sk-test-private'));
  assert.match(body, /OpenAI/i);
});

test('browser test expiry closes the provider session and invalidates tool access', async (t) => {
  const f = fixture(t);
  let ended = 0;
  const app = createApp(f.db, configuration({ OPENAI_API_KEY: 'sk-test-private' }), {
    voiceTestTtlMs: 40,
    voiceFetch: async (url) =>
      url.endsWith('/hangup')
        ? (ended++, new Response(null, { status: 200 }))
        : Response.json(
            { session: { id: 'live_expiry' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } },
            { status: 201 },
          ),
  });
  const base = await server(t, app),
    cookie = await login(base);
  const session = await (await request(base, cookie, '/session', { sdp: offer })).json();
  assert.ok(session.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ended, 1);
  assert.ok(
    [404, 410].includes(
      (
        await request(base, cookie, '/' + session.id + '/tool', {
          name: 'confirm_identity',
          args: { confirmed: true, name: 'Ana Silva' },
          callId: 'expired',
        })
      ).status,
    ),
  );
});

test('accepted browser demo agreement creates a durable platform case and editable unsent follow-up exactly once', async (t) => {
  const f = fixture(t);
  const app = createApp(f.db, configuration({ OPENAI_API_KEY: 'fake' }), {
    voiceFetch: async (url) =>
      url.endsWith('/hangup')
        ? new Response(null, { status: 200 })
        : Response.json({
            session: { id: 'demo-platform-test' },
            transport: { sdp: 'v=0\r\nanswer' },
          }),
  });
  const base = await server(t, app),
    cookie = await login(base);
  const session = await (await request(base, cookie, '/session', { sdp: offer })).json();
  const endpoint = '/' + session.id + '/tool';
  await request(base, cookie, endpoint, {
    name: 'confirm_identity',
    args: { confirmed: true, name: 'Ana Silva' },
    callId: 'name',
  });
  const body = {
    name: 'agree_payment_solution',
    args: { offerId: 'three_installments', accepted: true },
    callId: 'agreement',
  };
  const result = await (await request(base, cookie, endpoint, body)).json();
  assert.equal(result.agreed, true);
  assert.ok(result.platform.caseId);
  assert.ok(result.platform.jobId);
  const again = await (
    await request(base, cookie, endpoint, { ...body, callId: 'retry-agreement' })
  ).json();
  assert.equal(again.platform.caseId, result.platform.caseId);
  assert.equal(again.platform.jobId, result.platform.jobId);
  await request(base, cookie, '/' + session.id, undefined, 'DELETE');
  const detail = await (
    await fetch(base + '/api/cases/' + result.platform.caseId, { headers: { cookie } })
  ).json();
  assert.equal(detail.paymentAgreements.length, 1);
  assert.equal(detail.paymentFollowups.length, 1);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.amount_minor, 125000);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  const job = detail.paymentFollowups[0];
  assert.equal(job.status, 'draft');
  assert.match(job.message, /DEMO/i);
  const edited = await fetch(base + '/api/payment-followups/' + job.id, {
    method: 'PATCH',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: 'sms',
      destination: '+4917645997563',
      paymentDetails: 'DEMO ONLY: https://payments.example.invalid/test; Pix DEMO-PIX-NOT-PAYABLE',
    }),
  });
  assert.equal(edited.status, 200);
  const updated = await edited.json();
  assert.equal(updated.channel, 'sms');
  assert.equal(updated.status, 'draft');
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
});
