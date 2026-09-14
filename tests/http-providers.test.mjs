import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import {
  configuration,
  capabilities,
  dispatch,
  twilioSignature,
  validTwilio,
  validSendgrid,
} from '../server/providers.mjs';
import { claimNext } from '../server/service.mjs';
import { one, run } from '../server/db.mjs';
import { fixture, campaign, liveConfig, server } from './helpers.mjs';

test('authenticated import/case APIs hide verification hashes and export formula cells safely', async (t) => {
  const f = fixture(t, [['=SUM(1)', 'Ana', '11987654321', 'ana@example.test', '12', '']]);
  // Existing databases may still contain private hashes from the previous code flow.
  run(
    f.db,
    'UPDATE cases SET verification_hash=? WHERE id=?',
    'legacy-private-hash',
    f.cases[0].id,
  );
  const base = await server(t, createApp(f.db, configuration({})));
  assert.equal((await fetch(base + '/api/cases')).status, 401);
  assert.equal(
    (
      await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://hostile.test' },
        body: JSON.stringify({ password: 'rescova-demo' }),
      })
    ).status,
    403,
  );
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'rescova-demo' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  for (const path of [
    '/api/cases',
    '/api/cases/' + f.cases[0].id,
    '/api/imports/' + one(f.db, 'SELECT id FROM imports').id + '/report',
  ]) {
    const res = await fetch(base + path, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body.includes('verification_hash'), false);
    assert.equal(body.includes('legacy-private-hash'), false);
    assert.equal(body.includes('has_verification'), false);
  }
  const csv = await (await fetch(base + '/api/cases/export', { headers: { cookie } })).text();
  assert.ok(csv.includes("'=SUM(1)"));
  assert.equal(csv.includes('verification_hash'), false);
  await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal((await fetch(base + '/api/cases', { headers: { cookie } })).status, 401);
});
test('Twilio webhook checks signature/account, accepts authentic callback once and rejects simulation in live mode', async (t) => {
  const f = fixture(t),
    config = liveConfig();
  campaign(f, ['sms'], 'live');
  const { attempt } = claimNext(f.db, capabilities(config), 'live', new Date(), true);
  const base = await server(t, createApp(f.db, config)),
    path = '/hooks/twilio/status/' + attempt.id;
  const params = {
    AccountSid: config.accountSid,
    MessageSid: 'SMtest',
    MessageStatus: 'delivered',
  };
  const send = (p, signature) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      body: new URLSearchParams(p),
    });
  assert.equal((await send(params, 'invalid')).status, 403);
  assert.equal(one(f.db, 'SELECT status FROM attempts').status, 'dispatching');
  const wrong = { ...params, AccountSid: 'ACwrong' };
  assert.equal(
    (await send(wrong, twilioSignature(config.authToken, config.publicUrl + path, wrong))).status,
    403,
  );
  const signature = twilioSignature(config.authToken, config.publicUrl + path, params);
  assert.equal((await send(params, signature)).status, 200);
  assert.deepEqual(await (await send(params, signature)).json(), { duplicate: true });
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: config.password }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (
      await fetch(base + '/api/demo/step', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
});
test('signed SendGrid events reject payload tampering and expired timestamps', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    config = {
      sendgridPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
  const raw = Buffer.from('[{"event":"delivered"}]'),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    'sha256',
    Buffer.concat([Buffer.from(timestamp), raw]),
    privateKey,
  ).toString('base64');
  assert.ok(validSendgrid(config, raw, timestamp, signature));
  assert.equal(validSendgrid(config, Buffer.from('[]'), timestamp, signature), false);
  assert.equal(validSendgrid(config, raw, '1', signature), false);
  const url = 'https://pilot.example.test/hook',
    params = { Body: 'Olá', From: '+5511987654321' };
  const twilio = twilioSignature('secret', url, params);
  assert.ok(validTwilio({ authToken: 'secret' }, url, params, twilio));
  assert.equal(validTwilio({ authToken: 'secret' }, url + '?other', params, twilio), false);
});
test('email inbound route authenticates, correlates and deduplicates human-review responses', async (t) => {
  const f = fixture(t),
    config = { ...liveConfig(), inboundSecret: 'inbound-test-secret' };
  campaign(f, ['email'], 'live');
  const { attempt } = claimNext(f.db, { email: { available: true } }, 'live', new Date(), true);
  const base = await server(t, createApp(f.db, config));
  const payload = {
    messageId: 'email-unique-1',
    from: 'Ana <ana@example.test>',
    text: 'Já paguei, por favor confira.',
  };
  const send = (authorization) =>
    fetch(base + '/hooks/email/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(payload),
    });
  assert.equal((await send('Basic wrong')).status, 403);
  const auth = 'Basic ' + Buffer.from('rescova:' + config.inboundSecret).toString('base64');
  assert.deepEqual(await (await send(auth)).json(), { matched: 1 });
  assert.deepEqual(await (await send(auth)).json(), { duplicate: true });
  assert.equal(
    one(f.db, 'SELECT outcome FROM attempts WHERE id=?', attempt.id).outcome,
    'human_review',
  );
  assert.equal(one(f.db, 'SELECT amount_minor FROM cases').amount_minor, 123456);
});
test('provider dispatch requires explicit live configuration and allowlist; mocked SMS contains no debt details', async () => {
  let calls = 0;
  const mock = async (url, options) => {
    calls++;
    assert.match(url, /Messages\.json$/);
    assert.equal(options.body.get('To'), '+5511987654321');
    assert.equal(options.body.get('Body').includes('1234'), false);
    return { ok: true, json: async () => ({ sid: 'SMtest' }) };
  };
  const a = { id: 'attempt', channel: 'sms', destination: '+5511987654321' },
    c = { name: 'Ana Silva', amount_minor: 123456, reference: 'DEBT-SECRET' };
  await assert.rejects(dispatch(configuration({}), a, c, mock), /disabled/i);
  await assert.rejects(dispatch({ ...liveConfig(), allowlist: [] }, a, c, mock));
  assert.equal(calls, 0);
  const result = await dispatch(liveConfig(), a, c, mock);
  assert.equal(calls, 1);
  assert.equal(result.sid, 'SMtest');
  assert.equal(result.message.includes('DEBT-SECRET'), false);
  assert.equal(capabilities(liveConfig()).whatsapp.available, false);
});
