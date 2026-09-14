import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { openDb, run, one, all, now } from '../server/db.mjs';
import {
  bridgeRealtime,
  realtimeInstructions,
  executeTool,
  validMediaHandshake,
} from '../server/realtime.mjs';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  receive(value) {
    this.emit('message', JSON.stringify(value));
  }
}
const callSid = 'CA' + 'a'.repeat(32),
  streamSid = 'MZ' + 'b'.repeat(32);
test('media handshake accepts secure scheme and documented trailing-slash variants', () => {
  const config = { publicUrl: 'https://voice.example.test', authToken: 'test-token' };
  const path = '/media/12345678-1234-1234-1234-123456789abc';
  const signature = (url) => createHmac('sha1', config.authToken).update(url).digest('base64');
  for (const scheme of ['https', 'wss'])
    for (const trailing of ['', '/']) {
      const signed = signature(`${scheme}://voice.example.test${path}${trailing}`);
      assert.equal(validMediaHandshake(config, path, signed), true);
      assert.equal(validMediaHandshake(config, path + '/', signed), true);
    }
});
test('media handshake rejects altered host, path, scheme, token and arbitrary request URLs', () => {
  const config = { publicUrl: 'https://voice.example.test', authToken: 'test-token' };
  const path = '/media/12345678-1234-1234-1234-123456789abc';
  const sign = (url, token = config.authToken) =>
    createHmac('sha1', token).update(url).digest('base64');
  for (const url of [
    `https://evil.example${path}`,
    `http://voice.example.test${path}`,
    `https://voice.example.test${path.replace('abc', 'def')}`,
  ]) {
    assert.equal(validMediaHandshake(config, path, sign(url)), false);
  }
  assert.equal(
    validMediaHandshake(config, path, sign(config.publicUrl + path, 'wrong-token')),
    false,
  );
  const correct = sign(config.publicUrl + path);
  for (const invalid of [
    `//evil.example${path}`,
    config.publicUrl + path,
    path + '?extra=1',
    path + '//',
    '/other/' + path,
  ])
    assert.equal(validMediaHandshake(config, invalid, correct), false);
  assert.equal(validMediaHandshake(config, path, undefined), false);
  assert.equal(validMediaHandshake({ ...config, authToken: '' }, path, correct), false);
});
function setup(t, options = {}) {
  const db = openDb();
  run(
    db,
    'INSERT INTO portfolios VALUES (?,?,?,?,?)',
    'p',
    'Carteira',
    'Credor Brasil',
    'America/Sao_Paulo',
    now(),
  );
  run(
    db,
    `INSERT INTO cases (id,portfolio_id,reference,name,phone,amount_minor,currency,due_date,timezone,verification_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'c',
    'p',
    'REF-123',
    'Maria Silva',
    '+5511999990000',
    12345,
    'BRL',
    '2025-01-01',
    'America/Sao_Paulo',
    null,
    now(),
  );
  run(
    db,
    `INSERT INTO attempts (id,case_id,channel,mode,status,provider_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    'a',
    'c',
    'voice',
    'live',
    'ringing',
    callSid,
    now(),
    now(),
  );
  const twilio = new Socket(),
    ai = new Socket(),
    attempt = one(db, 'SELECT * FROM attempts WHERE id=?', 'a');
  let connections = 0;
  const bridge = bridgeRealtime(
    twilio,
    attempt,
    db,
    { accountSid: 'AC-test', openaiKey: 'test-secret', realtimeModel: 'gpt-realtime' },
    {
      connect: () => {
        connections++;
        return ai;
      },
      ...options,
    },
  );
  t.after(() => {
    bridge.close();
    db.close();
  });
  const start = (overrides = {}) =>
    twilio.receive({
      event: 'start',
      start: {
        accountSid: 'AC-test',
        callSid,
        streamSid,
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        ...overrides,
      },
    });
  const ready = () => {
    start();
    ai.emit('open');
    ai.receive({ type: 'session.updated' });
  };
  const tool = (name, args, call_id = 'tool-1') =>
    ai.receive({
      type: 'response.function_call_arguments.done',
      name,
      arguments: JSON.stringify(args),
      call_id,
    });
  return { db, twilio, ai, start, ready, tool, connections: () => connections };
}

test('model receives complete debt context immediately, never verification secrets', () => {
  const prompt = realtimeInstructions(
    {
      name: 'Maria Silva',
      reference: 'REF-123',
      amount_minor: 12345,
      currency: 'BRL',
      due_date: '2025-01-01',
      timezone: 'America/Sao_Paulo',
      verification_hash: 'secret-hash',
      verification_code: 'secret-code',
    },
    'Credor Brasil',
  );
  for (const value of ['Credor Brasil', 'REF-123', '123.45', '2025-01-01', 'confirmed=true'])
    assert.ok(prompt.includes(value));
  assert.ok(!prompt.includes('secret-hash') && !prompt.includes('secret-code'));
});
test('first session update includes tools, Brazilian Portuguese, creditor and PCMU', (t) => {
  const f = setup(t);
  f.start();
  f.ai.emit('open');
  const update = f.ai.sent[0];
  assert.equal(update.type, 'session.update');
  assert.deepEqual(
    update.session.tools.map((t) => t.name),
    ['confirm_identity', 'record_outcome'],
  );
  assert.equal(update.session.audio.input.format.type, 'audio/pcmu');
  assert.equal(update.session.audio.output.format.type, 'audio/pcmu');
  assert.equal(update.session.audio.input.transcription.language, 'pt');
  assert.ok(update.session.instructions.includes('Credor Brasil'));
  f.ai.receive({ type: 'session.updated' });
  f.ai.receive({ type: 'session.updated' });
  assert.equal(f.ai.sent.filter((m) => m.type === 'session.update').length, 1);
  assert.equal(f.ai.sent.filter((m) => m.type === 'response.create').length, 1);
});
test('startup audio survives session initialization and interruption truncates played audio', (t) => {
  const f = setup(t);
  f.start();
  f.twilio.receive({
    event: 'media',
    streamSid,
    media: { timestamp: '100', payload: 'AAAA', track: 'inbound' },
  });
  f.ai.emit('open');
  f.ai.receive({ type: 'session.updated' });
  assert.equal(f.ai.sent.find((m) => m.type === 'input_audio_buffer.append').audio, 'AAAA');
  f.ai.receive({ type: 'response.output_audio.delta', item_id: 'speech-1', delta: 'BBBB' });
  f.twilio.receive({ event: 'media', streamSid, media: { timestamp: '340', payload: 'CCCC' } });
  f.ai.receive({ type: 'input_audio_buffer.speech_started' });
  assert.ok(f.twilio.sent.some((m) => m.event === 'clear'));
  assert.equal(f.ai.sent.find((m) => m.type === 'conversation.item.truncate').audio_end_ms, 240);
});
test('unverified financial outcome fails but opt-out works and duplicates are idempotent', (t) => {
  const f = setup(t);
  f.ready();
  f.tool('record_outcome', { outcome: 'paid_reported', note: 'Já pago' }, 'bad');
  assert.equal(one(f.db, 'SELECT outcome FROM attempts WHERE id=?', 'a').outcome, null);
  f.tool('record_outcome', { outcome: 'opt_out', note: 'Não deseja contatos' }, 'stop');
  f.tool('record_outcome', { outcome: 'opt_out', note: 'Não deseja contatos' }, 'stop');
  assert.equal(one(f.db, 'SELECT suppressed FROM cases WHERE id=?', 'c').suppressed, 1);
  assert.equal(all(f.db, "SELECT * FROM events WHERE kind='outcome'").length, 1);
  assert.equal(
    f.ai.sent.filter((m) => m.type === 'conversation.item.create' && m.item.call_id === 'stop')
      .length,
    1,
  );
  f.ai.receive({ type: 'response.created', response: { id: 'farewell' } });
  f.ai.receive({
    type: 'response.done',
    response: { id: 'farewell', status: 'completed', output: [{ type: 'message' }] },
  });
  assert.equal(f.twilio.readyState, 3);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 0);
});
test('self-declared name unlocks financial result; CPF is redacted and no raw transcript persists', (t) => {
  const f = setup(t);
  f.ready();
  f.ai.receive({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'atendimento-42',
  });
  f.tool('confirm_identity', { confirmed: true, name: 'Maria Silva' }, 'confirm');
  assert.equal(
    one(f.db, 'SELECT identity_verified FROM attempts WHERE id=?', 'a').identity_verified,
    1,
  );
  assert.equal(
    one(f.db, 'SELECT identity_method FROM attempts WHERE id=?', 'a').identity_method,
    'self_reported_name',
  );
  f.tool(
    'record_outcome',
    { outcome: 'paid_reported', note: 'Relatou pagamento CPF 123.456.789-00' },
    'paid',
  );
  const events = JSON.stringify(all(f.db, 'SELECT * FROM events'));
  assert.ok(!events.includes('atendimento-42') && !events.includes('123.456.789-00'));
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 1);
});
test('farewell waits until Twilio acknowledges queued audio', (t) => {
  const f = setup(t);
  f.ready();
  f.tool('record_outcome', { outcome: 'human_review', note: 'Atendente solicitado' });
  f.ai.receive({ type: 'response.output_audio.delta', item_id: 'bye', delta: 'AAAA' });
  f.ai.receive({ type: 'response.created', response: { id: 'farewell' } });
  f.ai.receive({
    type: 'response.done',
    response: { id: 'farewell', status: 'completed', output: [{ type: 'message' }] },
  });
  assert.equal(f.twilio.readyState, 1);
  f.twilio.receive({ event: 'mark', streamSid, mark: { name: 'unknown' } });
  assert.equal(f.twilio.readyState, 1);
  const mark = f.twilio.sent.find((m) => m.event === 'mark');
  f.twilio.receive(mark);
  assert.equal(f.twilio.readyState, 3);
});
test('mismatched call SID never connects OpenAI and creates a human task', (t) => {
  const f = setup(t);
  f.start({ callSid: 'CA' + 'c'.repeat(32) });
  assert.equal(f.connections(), 0);
  assert.equal(f.twilio.readyState, 3);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 1);
});
test('different stream SID is rejected before forwarding audio', (t) => {
  const f = setup(t);
  f.ready();
  f.twilio.receive({
    event: 'media',
    streamSid: 'MZ' + 'c'.repeat(32),
    media: { timestamp: '0', payload: 'AAAA' },
  });
  assert.equal(f.twilio.readyState, 3);
  assert.equal(f.ai.sent.filter((m) => m.type === 'input_audio_buffer.append').length, 0);
});
test('persisted stream receipt rejects replay', (t) => {
  const f = setup(t);
  run(f.db, 'INSERT INTO receipts VALUES (?,?)', 'stream:a', now());
  f.start();
  assert.equal(f.connections(), 0);
  assert.equal(f.twilio.readyState, 3);
});
test('OpenAI failure or missing final outcome produces only one human task', (t) => {
  const f = setup(t);
  f.ready();
  f.ai.receive({ type: 'error', error: { code: 'invalid_request_error' } });
  f.ai.emit('error', new Error('second failure'));
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM tasks').n, 1);
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM events WHERE kind='realtime_error'").n, 1);
});
test('duration limit closes both sockets and routes to human review', async (t) => {
  const f = setup(t, { timeoutMs: 5 });
  f.ready();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.ai.readyState, 3);
  assert.equal(f.twilio.readyState, 3);
  assert.equal(one(f.db, 'SELECT outcome FROM cases WHERE id=?', 'c').outcome, 'human_review');
});
test('name confirmation requires explicit true and matching full name; no code tool exists', (t) => {
  const f = setup(t);
  for (const args of [
    { confirmed: false, name: 'Maria Silva' },
    { confirmed: 'true', name: 'Maria Silva' },
    { confirmed: true, name: 'Maria' },
    { confirmed: true, name: 'Outra Pessoa' },
    { confirmed: true },
    {},
  ]) {
    assert.equal(executeTool(f.db, 'a', 'confirm_identity', args).confirmed, false);
    assert.equal(
      one(f.db, 'SELECT identity_verified FROM attempts WHERE id=?', 'a').identity_verified,
      0,
    );
  }
  assert.throws(
    () => executeTool(f.db, 'a', 'verify_identity', { code: 'atendimento-42' }),
    /autorizada/,
  );
  const result = executeTool(f.db, 'a', 'confirm_identity', {
    confirmed: true,
    name: '  MARIA   SILVA ',
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.assurance, 'self_reported_name');
  const events = all(f.db, "SELECT * FROM events WHERE kind='identity_self_reported'");
  assert.equal(events.length, 1);
  assert.ok(events[0].detail.includes('not verified against documents'));
  executeTool(f.db, 'a', 'confirm_identity', { confirmed: true, name: 'Maria Silva' });
  assert.equal(one(f.db, "SELECT COUNT(*) n FROM events WHERE kind='identity_self_reported'").n, 1);
});
test('case without name cannot be confirmed', (t) => {
  const f = setup(t);
  run(f.db, 'UPDATE cases SET name=NULL WHERE id=?', 'c');
  assert.equal(
    executeTool(f.db, 'a', 'confirm_identity', { confirmed: true, name: 'Maria Silva' }).confirmed,
    false,
  );
});
test('tool follow-up waits for original response.done before generating farewell', (t) => {
  const f = setup(t);
  f.ready();
  const count = f.ai.sent.filter((m) => m.type === 'response.create').length;
  f.ai.receive({
    type: 'response.function_call_arguments.done',
    response_id: 'original',
    call_id: 'final',
    name: 'record_outcome',
    arguments: JSON.stringify({ outcome: 'opt_out', note: 'Parar contato' }),
  });
  assert.equal(f.ai.sent.filter((m) => m.type === 'response.create').length, count);
  f.ai.receive({
    type: 'response.done',
    response: {
      id: 'original',
      status: 'completed',
      output: [{ type: 'message' }, { type: 'function_call' }],
    },
  });
  assert.equal(f.ai.sent.filter((m) => m.type === 'response.create').length, count + 1);
  assert.equal(f.twilio.readyState, 1);
  f.ai.receive({ type: 'response.created', response: { id: 'farewell' } });
  f.ai.receive({
    type: 'response.done',
    response: { id: 'farewell', status: 'completed', output: [{ type: 'message' }] },
  });
  assert.equal(f.twilio.readyState, 3);
});
