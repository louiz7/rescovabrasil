import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { openDb, one } from '../server/db.mjs';
import { createVoiceDebug } from '../server/voice-debug.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, enabled = true) {
  const db = openDb(),
    dir = mkdtempSync(join(tmpdir(), 'rescova-voice-debug-')),
    jobs = [];
  const config = {
    voiceDebugEnabled: enabled,
    whisperPython: process.execPath,
    ffmpegPath: process.execPath,
    whisperModel: dir,
    voiceDebugDir: join(dir, 'recordings'),
  };
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.kill = () => {};
    jobs.push({ command, args, options, child });
    return child;
  };
  const debug = createVoiceDebug(db, config, { spawnImpl, retryDelayMs: 0 });
  t.after(() => {
    debug.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, config, debug, jobs, spawnImpl };
}
test('disabled local debug creates no recording directory and cannot launch workers', async (t) => {
  const f = fixture(t, false);
  assert.equal(existsSync(f.config.voiceDebugDir), false);
  assert.throws(() => f.debug.create({ owner: 'owner', provider: 'grok' }), /disabled/);
  await tick();
  assert.equal(f.jobs.length, 0);
});
test('debug PCM timeline inserts correct PCMU silence and single worker persists speaker segments and safe events', async (t) => {
  const f = fixture(t),
    first = f.debug.create({ owner: 'owner', provider: 'twilio', sourceId: 'call-id' }),
    second = f.debug.create({ owner: 'owner', provider: 'grok' });
  const bytes = Buffer.alloc(80, 128);
  f.debug.append(first.id, {
    speaker: 'user',
    audio: bytes,
    encoding: 'pcmu',
    sampleRate: 8000,
    timestampMs: 100,
  });
  f.debug.append(first.id, {
    speaker: 'user',
    audio: bytes,
    encoding: 'pcmu',
    sampleRate: 8000,
    timestampMs: 120,
  });
  const raw = readFileSync(join(f.config.voiceDebugDir, first.id, 'user.raw'));
  assert.equal(raw.length, 240);
  assert.ok(raw.subarray(80, 160).every((v) => v === 255));
  f.debug.recordEvent(first.id, {
    type: 'response.tool.done',
    name: 'confirm_identity',
    timestampMs: 110,
    arguments: 'not stored',
  });
  assert.ok(
    !one(f.db, 'SELECT events FROM debug_voice_sessions WHERE id=?', first.id).events.includes(
      'not stored',
    ),
  );
  assert.throws(
    () =>
      f.debug.append(first.id, {
        speaker: 'user',
        audio: bytes,
        encoding: 'pcmu',
        sampleRate: 8000,
        timestampMs: 300000,
      }),
    /five minutes/,
  );
  assert.throws(
    () => f.debug.recordEvent(first.id, { type: 'secret-key', timestampMs: 0 }),
    /Invalid debug/,
  );
  f.debug.append(second.id, {
    speaker: 'assistant',
    audio: Buffer.alloc(960),
    encoding: 'pcm16',
    sampleRate: 24000,
    timestampMs: 0,
  });
  f.debug.finish(first.id);
  f.debug.finish(second.id);
  await tick();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].options.shell, false);
  assert.equal(f.jobs[0].options.env.HF_HUB_OFFLINE, '1');
  const metadata = JSON.parse(readFileSync(f.jobs[0].args[1], 'utf8'));
  assert.equal(metadata.tracks.user.offsetMs, 100);
  writeFileSync(
    f.jobs[0].args[2],
    JSON.stringify({ segments: [{ speaker: 'user', start: 0.1, end: 0.13, text: 'Hello' }] }),
  );
  f.jobs[0].child.emit('close', 0);
  await tick();
  assert.equal(
    one(f.db, 'SELECT status FROM debug_voice_sessions WHERE id=?', first.id).status,
    'completed',
  );
  assert.equal(f.jobs.length, 2);
  f.jobs[1].child.emit('close', 20);
  await tick();
  assert.equal(
    one(f.db, 'SELECT status FROM debug_voice_sessions WHERE id=?', second.id).status,
    'failed',
  );
});
test('debug HTTP upload writes only for owner, supports offsets and private read/purge without launching cloud calls', async (t) => {
  const f = fixture(t),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.sessionToken = req.headers.cookie;
    if (!req.sessionToken) return res.status(401).end();
    next();
  });
  app.use('/api/voice-debug', f.debug.router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api/voice-debug`;
  assert.equal((await fetch(base)).status, 401);
  const request = (path, options = {}) =>
    fetch(base + path, { ...options, headers: { cookie: 'owner', ...options.headers } });
  const info = await (await request('/sessions')).json();
  assert.equal(info.enabled, true);
  assert.equal(info.available, true);
  const created = await (
    await request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', sourceId: 'browser-id' }),
    })
  ).json();
  const audioPath = `/${created.id}/audio?speaker=user&offsetMs=250`;
  const sourceRequest = (sourceId, cookie = 'owner') =>
    request(`/${created.id}/source`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId }),
    });
  assert.equal((await sourceRequest('browser-id', 'foreign')).status, 403);
  assert.equal((await sourceRequest('browser-id')).status, 200);
  assert.equal((await sourceRequest('other-id')).status, 409);
  assert.equal(
    (
      await request(audioPath, {
        method: 'POST',
        headers: { cookie: 'foreign', 'content-type': 'audio/webm' },
        body: 'webm',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(audioPath, {
        method: 'POST',
        headers: { 'content-type': 'audio/webm;codecs=opus' },
        body: 'synthetic-webm',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(audioPath, {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: 'duplicate',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/${created.id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'session.started', timestampMs: 0 }] }),
      })
    ).status,
    200,
  );
  const detail = await (await request('/' + created.id)).json();
  assert.equal(detail.events.length, 1);
  assert.deepEqual(detail.speakers, ['user']);
  assert.equal(await (await request(`/${created.id}/audio/user`)).text(), 'synthetic-webm');
  assert.equal((await request('/' + created.id, { method: 'DELETE' })).status, 200);
  assert.equal(existsSync(join(f.config.voiceDebugDir, created.id)), false);
  assert.equal((await request('/' + created.id)).status, 404);
});
test('local worker shutdown preserves queued recovery and never leaks worker output on failure', async (t) => {
  const f = fixture(t),
    created = f.debug.create({ owner: 'owner', provider: 'grok' });
  f.debug.append(created.id, {
    speaker: 'user',
    audio: Buffer.alloc(960),
    encoding: 'pcm16',
    sampleRate: 24000,
    timestampMs: 0,
  });
  f.debug.finish(created.id);
  await tick();
  f.debug.closeAll();
  assert.equal(one(f.db, 'SELECT status FROM debug_voice_sessions').status, 'queued');
  const resumed = createVoiceDebug(f.db, f.config, { spawnImpl: f.spawnImpl });
  t.after(() => resumed.closeAll());
  await tick();
  assert.equal(f.jobs.length, 2);
  writeFileSync(f.jobs[1].args[2], 'private raw malformed transcript');
  f.jobs[1].child.emit('close', 0);
  await tick();
  const row = one(f.db, 'SELECT * FROM debug_voice_sessions');
  assert.equal(row.status, 'failed');
  assert.ok(!row.error.includes('private'));
});

test('transient recognition failure retries once, removes stale output and preserves bounded diagnostics', async (t) => {
  const f = fixture(t),
    created = f.debug.create({ owner: 'owner', provider: 'openai' });
  f.debug.append(created.id, {
    speaker: 'user',
    audio: Buffer.alloc(960),
    encoding: 'pcm16',
    sampleRate: 24000,
  });
  f.debug.recordEvent(created.id, {
    type: 'tool.backend.completed',
    timestampMs: 20,
    responseId: 'resp_123',
    callId: 'call_456',
    text: 'Bearer private-secret sk-secret ' + 'x'.repeat(5000),
    arguments: 'discard',
  });
  const event = JSON.parse(one(f.db, 'SELECT events FROM debug_voice_sessions').events)[0];
  assert.equal(event.responseId, 'resp_123');
  assert.equal(event.callId, 'call_456');
  assert.ok(event.text.length <= 4000);
  assert.ok(!event.text.includes('private-secret'));
  assert.ok(!event.text.includes('sk-secret'));
  assert.equal(event.arguments, undefined);
  f.debug.finish(created.id);
  await tick();
  writeFileSync(f.jobs[0].args[2], JSON.stringify({ segments: [] }));
  f.jobs[0].child.emit('close', 22);
  await tick();
  assert.equal(f.jobs.length, 2);
  assert.equal(existsSync(f.jobs[1].args[2]), false);
  f.jobs[1].child.emit('close', 22);
  await tick();
  const row = one(f.db, 'SELECT * FROM debug_voice_sessions');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.match(row.error, /speech recognition; attempt 2\/2/);
  assert.equal(f.jobs.length, 2);
});
test('second transcription attempt can complete successfully', async (t) => {
  const f = fixture(t),
    created = f.debug.create({ owner: 'owner', provider: 'openai' });
  f.debug.append(created.id, {
    speaker: 'user',
    audio: Buffer.alloc(960),
    encoding: 'pcm16',
    sampleRate: 24000,
  });
  f.debug.finish(created.id);
  await tick();
  f.jobs[0].child.emit('close', 1);
  await tick();
  writeFileSync(f.jobs[1].args[2], JSON.stringify({ segments: [] }));
  f.jobs[1].child.emit('close', 0);
  await tick();
  const row = one(f.db, 'SELECT * FROM debug_voice_sessions');
  assert.equal(row.status, 'completed');
  assert.equal(row.error, null);
  assert.equal(row.attempts, 2);
});
