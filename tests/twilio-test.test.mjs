import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { configuration, twilioSignature } from '../server/providers.mjs';
import { one, all } from '../server/db.mjs';
import { fixture, server } from './helpers.mjs';

const callSid = 'CA' + 'a'.repeat(32);
const destination = '+5511987654321';
function testConfig(overrides = {}) {
  return configuration({
    OUTREACH_MODE: 'demo',
    LIVE_SEND_ENABLED: 'false',
    TWILIO_TEST_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'AC' + 'b'.repeat(32),
    TWILIO_AUTH_TOKEN: 'private-twilio-token',
    TWILIO_PHONE_NUMBER: '+551133334444',
    OPENAI_API_KEY: 'private-openai-key',
    PUBLIC_BASE_URL: 'https://pilot.rescova.app',
    OUTBOUND_ALLOWLIST: destination,
    ...overrides,
  });
}
async function login(base) {
  const response = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'rescova-demo' }),
  });
  return response.headers.get('set-cookie').split(';')[0];
}
function request(base, cookie, path = '', body, method = body === undefined ? 'GET' : 'POST') {
  return fetch(base + '/api/twilio-test' + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function setup(t, config = testConfig(), fake) {
  let app;
  t.after(async () => {
    await app?.locals.twilioTests.closeAll();
  });
  const f = fixture(t),
    calls = [];
  const twilioFetch = async (url, options) => {
    calls.push({ url, options });
    if (fake) return fake(url, options, calls);
    assert.ok(url.startsWith('https://api.twilio.com/2010-04-01/Accounts/AC'));
    return Response.json({
      sid: callSid,
      status: url.endsWith('/Calls.json') ? 'queued' : 'completed',
    });
  };
  app = createApp(f.db, config, { twilioFetch });
  const base = await server(t, app),
    cookie = await login(base);
  return { ...f, app, config, base, cookie, calls };
}
function start(f, requestId = randomUUID(), extra = {}) {
  return request(f.base, f.cookie, '/calls', { destination, confirmed: true, requestId, ...extra });
}
async function callback(f, id, status, sequence, extra = {}, valid = true, endpoint = 'status') {
  const path = `/hooks/twilio-test/${endpoint}/${id}`;
  const params = {
    AccountSid: f.config.accountSid,
    CallSid: callSid,
    CallStatus: status,
    ...(sequence === undefined ? {} : { SequenceNumber: String(sequence) }),
    ...extra,
  };
  return fetch(f.base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': valid
        ? twilioSignature(f.config.authToken, f.config.publicUrl + path, params)
        : 'invalid',
    },
    body: new URLSearchParams(params),
  });
}

test('isolated phone test requires authentication, explicit consent and allowlist; request ID prevents redial', async (t) => {
  const f = await setup(t);
  assert.equal((await fetch(f.base + '/api/twilio-test')).status, 401);
  const config = await (await request(f.base, f.cookie)).json();
  assert.equal(config.available, true);
  assert.equal(config.model, 'gpt-live-1');
  assert.deepEqual(config.destinations, [destination]);
  assert.ok(!JSON.stringify(config).includes('private-'));
  assert.equal((await start(f, randomUUID(), { confirmed: false })).status, 400);
  assert.equal((await start(f, randomUUID(), { destination: '+5511987650000' })).status, 403);
  assert.equal(f.calls.length, 0);
  const requestId = randomUUID();
  const created = await start(f, requestId);
  assert.equal(created.status, 201);
  const call = await created.json();
  assert.equal(call.state, 'queued');
  assert.equal(call.providerSid, callSid);
  const body = f.calls[0].options.body;
  assert.equal(body.get('To'), destination);
  assert.equal(body.get('From'), f.config.fromPhone);
  assert.equal(body.get('Record'), 'false');
  assert.equal(body.get('TimeLimit'), '300');
  assert.equal(body.get('Timeout'), '25');
  assert.ok(body.get('Url').endsWith('/hooks/twilio-test/voice/' + call.id));
  assert.deepEqual(body.getAll('StatusCallbackEvent'), [
    'initiated',
    'ringing',
    'answered',
    'completed',
  ]);
  assert.equal((await (await start(f, requestId)).json()).id, call.id);
  assert.equal(f.calls.length, 1);
  assert.equal((await start(f)).status, 409);
  const other = await login(f.base);
  assert.equal((await request(f.base, other, '/calls/' + call.id)).status, 404);
  assert.equal(
    (await request(f.base, other, '/calls', { destination, confirmed: true, requestId })).status,
    404,
  );
  assert.equal((await request(f.base, f.cookie, '/calls/' + call.id + '/end', {})).status, 200);
  const ended = await (await request(f.base, f.cookie, '/calls/' + call.id)).json();
  assert.equal(ended.state, 'completed');
  assert.equal(ended.closed, true);
  assert.equal(f.calls[1].options.body.get('Status'), 'completed');
});

test('phone test stays unavailable without independent flag and public callback configuration', async (t) => {
  const f = await setup(
    t,
    testConfig({ TWILIO_TEST_ENABLED: 'false', PUBLIC_BASE_URL: 'https://localhost:3001' }),
  );
  const settings = await (await request(f.base, f.cookie)).json();
  assert.equal(settings.available, false);
  assert.equal(settings.checks.find((x) => x.key === 'enabled').configured, false);
  assert.equal(settings.checks.find((x) => x.key === 'publicUrl').configured, false);
  assert.equal((await start(f)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('signed phone callbacks bind the correct SID, enforce monotonic states and expose no debt in TwiML', async (t) => {
  const f = await setup(t),
    call = await (await start(f)).json();
  assert.equal((await callback(f, call.id, 'ringing', 0, {}, false)).status, 403);
  assert.equal(
    (await callback(f, call.id, 'ringing', 0, { CallSid: 'CA' + 'c'.repeat(32) })).status,
    403,
  );
  assert.equal(
    (await callback(f, call.id, 'ringing', 0, { AccountSid: 'AC' + 'c'.repeat(32) })).status,
    403,
  );
  assert.equal((await callback(f, call.id, 'ringing', 0)).status, 200);
  await callback(f, call.id, 'in-progress', 1);
  await callback(f, call.id, 'queued', 2);
  await callback(f, call.id, 'ringing', 0);
  assert.equal(
    (await (await request(f.base, f.cookie, '/calls/' + call.id)).json()).state,
    'in-progress',
  );
  const xml = await (
    await callback(f, call.id, 'in-progress', undefined, {}, true, 'voice')
  ).text();
  assert.match(xml, /<Connect><Stream/);
  assert.ok(xml.includes('wss://pilot.rescova.app/twilio-test-media/' + call.id));
  assert.ok(!xml.includes('1250') && !xml.includes('Ana') && !xml.includes('BROWSER-TEST'));
  await callback(f, call.id, 'completed', 3);
  await callback(f, call.id, 'ringing', 4);
  assert.equal(
    (await (await request(f.base, f.cookie, '/calls/' + call.id)).json()).state,
    'completed',
  );
  assert.equal(f.app.locals.twilioTests.getSession(call.id), undefined);
});

test('phone tools persist only derived test results and leave portfolio cases, tasks and attempts unchanged', async (t) => {
  const f = await setup(t),
    before = JSON.stringify(all(f.db, 'SELECT * FROM cases'));
  const call = await (await start(f)).json(),
    session = f.app.locals.twilioTests.getSession(call.id);
  const denied = session.execute(
    'record_outcome',
    { outcome: 'paid_reported', note: 'Already paid' },
    'unconfirmed',
  );
  assert.ok(denied.error);
  const identity = session.execute(
    'confirm_identity',
    { confirmed: true, name: 'Ana Silva' },
    'identity',
  );
  assert.equal(identity.assurance, 'self_reported_name');
  const recorded = session.execute(
    'record_outcome',
    { outcome: 'paid_reported', note: 'Already paid; 123.456.789-01' },
    'outcome',
  );
  assert.equal(recorded.recorded, true);
  assert.deepEqual(
    session.execute('record_outcome', { outcome: 'opt_out', note: 'Changed replay' }, 'outcome'),
    recorded,
  );
  const details = await (await request(f.base, f.cookie, '/calls/' + call.id)).json();
  assert.equal(details.identityConfirmation, 'self_reported_name');
  assert.equal(details.outcome, 'paid_reported');
  assert.ok(!JSON.stringify(details).includes('123.456.789-01'));
  assert.equal(JSON.stringify(all(f.db, 'SELECT * FROM cases')), before);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 0);
  await request(f.base, f.cookie, '/calls/' + call.id + '/end', {});
});

test('uncertain Twilio create is durable and never redials when request is retried', async (t) => {
  const f = await setup(t, testConfig(), async () => {
    throw new Error('private-twilio-token network failure');
  });
  const requestId = randomUUID(),
    call = await (await start(f, requestId)).json();
  assert.equal(call.state, 'unknown');
  assert.ok(!JSON.stringify(call).includes('private-twilio-token'));
  assert.equal((await (await start(f, requestId)).json()).id, call.id);
  assert.equal(f.calls.length, 1);
  assert.equal((await start(f)).status, 409);
  assert.equal(one(f.db, 'SELECT state FROM twilio_test_calls').state, 'unknown');
  assert.equal((await (await request(f.base, f.cookie)).json()).available, false);
});

test('phone demo agreement persists as derived test data after the isolated session ends', async (t) => {
  const f = await setup(t);
  const call = await (await start(f)).json();
  const session = f.app.locals.twilioTests.getSession(call.id);
  session.execute('confirm_identity', { confirmed: true, name: 'Ana Silva' }, 'name');
  const result = session.execute(
    'agree_payment_solution',
    { offerId: 'upfront_10_percent', accepted: true },
    'agree',
  );
  assert.equal(result.agreed, true);
  assert.equal(result.agreement.totalMinor, 112500);
  await request(f.base, f.cookie, '/calls/' + call.id + '/end', {});
  const details = await (await request(f.base, f.cookie, '/calls/' + call.id)).json();
  assert.equal(details.agreement.id, result.agreement.id);
  assert.equal(details.agreement.demo, true);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM attempts').n, 0);
});
