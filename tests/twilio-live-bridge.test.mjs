import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { bridgeTwilioTest, validTestHandshake } from '../server/twilio-live-bridge.mjs';
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  receive(event) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}
function fixture() {
  const phone = new Socket(),
    ai = new Socket(),
    captured = [],
    calls = [],
    updates = [],
    finished = [];
  const config = {
    accountSid: 'ACtest',
    openaiKey: 'fake',
    liveModel: 'gpt-live-1',
    liveBackendModel: 'gpt-5.6-terra',
  };
  const session = {
    providerSid: 'CAtest',
    startDebug: () => {},
    debugAudio: (chunk) => captured.push(chunk),
    update: (...v) => updates.push(v),
    finish: (r) => finished.push(r),
    execute: (...v) => {
      calls.push(v);
      return { confirmed: true };
    },
  };
  const bridge = bridgeTwilioTest(phone, session, config, {
    connect: (url) => {
      assert.equal(url, 'wss://api.openai.com/v1/live/sessions');
      return ai;
    },
  });
  const start = (overrides = {}) =>
    phone.receive({
      event: 'start',
      streamSid: 'MZtest',
      start: {
        accountSid: 'ACtest',
        callSid: 'CAtest',
        streamSid: 'MZtest',
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        ...overrides,
      },
    });
  return { phone, ai, captured, calls, updates, finished, bridge, start };
}
test('Twilio PCMU audio flows through native Live with managed tools, no manual speech response', async () => {
  const h = fixture();
  h.start();
  h.ai.emit('open');
  const session = h.ai.sent[0].session;
  assert.deepEqual(session.audio.format, { type: 'audio/pcmu', rate: 8000 });
  assert.equal(session.delegation.responses.tools.length, 6);
  const audio = Buffer.alloc(160, 255).toString('base64');
  h.phone.receive({ event: 'media', streamSid: 'MZtest', media: { payload: audio } });
  assert.equal(h.ai.sent.length, 1);
  h.ai.receive({ type: 'session.started' });
  assert.ok(h.ai.sent.some((e) => e.type === 'session.input_audio.append' && e.audio === audio));
  h.ai.receive({ type: 'session.instructions.appended', client_event_id: 'phone_greeting' });
  h.ai.receive({ type: 'session.output_audio.delta', delta: audio });
  assert.deepEqual(h.phone.sent[0], {
    event: 'media',
    streamSid: 'MZtest',
    media: { payload: audio },
  });
  h.phone.receive({ event: 'mark', streamSid: 'MZtest', mark: h.phone.sent[1].mark });
  assert.equal(h.ai.sent.filter((e) => e.type === 'response.create').length, 0);
  assert.deepEqual(
    h.captured.map((chunk) => chunk.speaker),
    ['user', 'assistant'],
  );
  assert.ok(
    h.captured.every(
      (chunk) =>
        chunk.encoding === 'pcmu' &&
        chunk.sampleRate === 8000 &&
        Number.isFinite(chunk.timestampMs),
    ),
  );
  assert.ok(h.captured.every((chunk) => chunk.audio.equals(Buffer.alloc(160, 255))));
  const response = (event) => h.ai.receive({ type: 'response.event', delegation_id: 'd1', event });
  response({ type: 'response.created', response: { id: 'r1' } });
  response({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      name: 'confirm_identity',
      call_id: 'c1',
      arguments: '{"confirmed":true,"name":"Ana Silva"}',
    },
  });
  response({ type: 'response.completed', response: { id: 'r1', output: [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.ai.sent.filter((e) => e.type === 'session.instructions.append').length,
    1,
    'Only the startup greeting may inject instructions',
  );
  assert.equal(h.ai.sent.filter((e) => e.type === 'session.commentary.append').length, 1);
  assert.equal(h.phone.readyState, 1, 'Tool results preserve the active audio connection');
  assert.equal(h.ai.sent.filter((e) => e.type === 'response.create').length, 1);
  h.phone.receive({ event: 'stop', streamSid: 'MZtest' });
  assert.equal(h.ai.readyState, 3);
  assert.equal(h.finished.length, 1);
});
test('phone bridge rejects foreign call and unsupported media before OpenAI connection', () => {
  for (const change of [
    { callSid: 'CAforeign' },
    { mediaFormat: { encoding: 'pcm', sampleRate: 16000, channels: 1 } },
  ]) {
    const h = fixture();
    h.start(change);
    assert.equal(h.ai.sent.length, 0);
    assert.equal(h.phone.readyState, 3);
    assert.equal(h.finished.length, 1);
  }
});
test('phone bridge bounds queued playback and ignores messages after close', () => {
  const h = fixture();
  h.start();
  h.ai.emit('open');
  h.ai.receive({ type: 'session.started' });
  const delta = Buffer.alloc(16000).toString('base64');
  for (let i = 0; i < 6; i++) h.ai.receive({ type: 'session.output_audio.delta', delta });
  assert.equal(h.finished.length, 1);
  assert.equal(h.phone.readyState, 3);
  h.ai.receive({ type: 'session.started' });
  assert.equal(h.finished.length, 1);
});
test('websocket handshake uses configured public origin and rejects forged path/signature', () => {
  const config = { publicUrl: 'https://pilot.rescova.app', authToken: 'test-token' };
  const path = '/twilio-test-media/12345678-1234-4234-8234-123456789012';
  const signature = createHmac('sha1', config.authToken)
    .update(config.publicUrl + path)
    .digest('base64');
  assert.equal(validTestHandshake(config, path, signature), true);
  assert.equal(validTestHandshake(config, path + '?spoof=1', signature), false);
  assert.equal(validTestHandshake(config, path, 'forged'), false);
  assert.equal(
    validTestHandshake({ ...config, publicUrl: 'http://pilot.rescova.app' }, path, signature),
    false,
  );
});
