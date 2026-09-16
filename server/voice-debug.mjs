import express from 'express';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id, now, one, all, run, transaction } from './db.mjs';
import { assert, AppError } from './domain.mjs';
const limit = 30 * 1024 * 1024;
const speakers = ['user', 'assistant'];
const ownerHash = (owner) => createHash('sha256').update(owner).digest('hex');
const executable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const script = fileURLToPath(new URL('../scripts/transcribe-debug.py', import.meta.url));
export function createVoiceDebug(db, config, { spawnImpl = spawn } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS debug_voice_sessions (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, source_id TEXT,
    status TEXT NOT NULL, tracks TEXT NOT NULL DEFAULT '{}', segments TEXT NOT NULL DEFAULT '[]',
    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  run(
    db,
    "UPDATE debug_voice_sessions SET status='queued',updated_at=? WHERE status='transcribing'",
    now(),
  );
  run(
    db,
    "UPDATE debug_voice_sessions SET status='failed',error='Recording interrupted by server restart.',updated_at=? WHERE status='recording'",
    now(),
  );
  if (
    !all(db, 'PRAGMA table_info(debug_voice_sessions)').some((column) => column.name === 'events')
  )
    db.exec("ALTER TABLE debug_voice_sessions ADD COLUMN events TEXT NOT NULL DEFAULT '[]'");
  const root = resolve(config.voiceDebugDir || 'data/voice-debug');
  const router = express.Router(),
    timers = new Map();
  let running = null,
    stopped = false,
    poll;
  const available = () =>
    config.voiceDebugEnabled === true &&
    executable(config.whisperPython) &&
    executable(config.ffmpegPath) &&
    typeof config.whisperModel === 'string' &&
    existsSync(config.whisperModel);
  const reason = () =>
    !config.voiceDebugEnabled
      ? 'Local voice debug recording is disabled.'
      : !executable(config.whisperPython)
        ? 'Configure a local Python runtime with Whisper.'
        : !executable(config.ffmpegPath)
          ? 'Configure an executable local ffmpeg path.'
          : !config.whisperModel || !existsSync(config.whisperModel)
            ? 'Configure a locally cached Whisper model.'
            : null;
  const record = (sessionId) => {
    assert(
      typeof sessionId === 'string' && /^[a-f0-9-]{36}$/.test(sessionId),
      'Invalid debug session ID.',
    );
    const row = one(db, 'SELECT * FROM debug_voice_sessions WHERE id=?', sessionId);
    assert(row, 'Debug recording not found.', 404);
    return row;
  };
  const directory = (sessionId) => join(root, sessionId);
  const summary = (row, detail = false) => ({
    id: row.id,
    provider: row.provider,
    sourceId: row.source_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    speakers: Object.keys(JSON.parse(row.tracks)),
    ...(detail
      ? { segments: JSON.parse(row.segments), events: JSON.parse(row.events || '[]') }
      : {}),
  });
  const status = (sessionId, value, error = null) =>
    run(
      db,
      'UPDATE debug_voice_sessions SET status=?,error=?,updated_at=? WHERE id=?',
      value,
      error,
      now(),
      sessionId,
    );
  const writable = (row) => {
    assert(row.status === 'recording', 'Debug recording is no longer accepting audio.', 409);
    assert(
      Date.now() - new Date(row.created_at).getTime() <= 310000,
      'Debug recording time limit reached.',
      409,
    );
  };
  function create({ owner, provider, sourceId = null }) {
    assert(available(), reason() || 'Local transcription is unavailable.', 503);
    assert(
      typeof owner === 'string' && owner.length > 0,
      'Authenticated recording owner required.',
      401,
    );
    assert(['openai', 'grok', 'twilio'].includes(provider), 'Invalid voice debug provider.');
    assert(
      sourceId === null || (typeof sourceId === 'string' && sourceId.length <= 100),
      'Invalid source session.',
    );
    assert(
      one(
        db,
        "SELECT COUNT(*) n FROM debug_voice_sessions WHERE status IN ('recording','queued','transcribing')",
      ).n < 10,
      'Local transcription queue is full.',
      429,
    );
    const sessionId = id(),
      timestamp = now();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(directory(sessionId), { mode: 0o700 });
    run(
      db,
      'INSERT INTO debug_voice_sessions (id,owner,provider,source_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      sessionId,
      ownerHash(owner),
      provider,
      sourceId,
      'recording',
      timestamp,
      timestamp,
    );
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      try {
        finish(sessionId);
      } catch {}
    }, 310000);
    timer.unref?.();
    timers.set(sessionId, timer);
    return { id: sessionId };
  }
  function saveTrack(row, speaker, track) {
    const tracks = JSON.parse(row.tracks);
    tracks[speaker] = track;
    run(
      db,
      'UPDATE debug_voice_sessions SET tracks=?,updated_at=? WHERE id=?',
      JSON.stringify(tracks),
      now(),
      row.id,
    );
  }
  function append(sessionId, { speaker, audio, encoding, sampleRate, timestampMs = 0 }) {
    const row = record(sessionId);
    writable(row);
    assert(
      speakers.includes(speaker) &&
        Buffer.isBuffer(audio) &&
        audio.length > 0 &&
        audio.length <= limit,
      'Invalid debug audio chunk.',
    );
    assert(
      ['pcmu', 'pcm16'].includes(encoding) &&
        [8000, 16000, 24000, 48000].includes(sampleRate) &&
        (encoding !== 'pcmu' || sampleRate === 8000),
      'Unsupported debug PCM encoding.',
    );
    assert(
      Number.isFinite(timestampMs) && timestampMs >= 0 && timestampMs <= 300000,
      'Invalid debug audio timestamp.',
    );
    const tracks = JSON.parse(row.tracks),
      previous = tracks[speaker],
      bytesPerSecond = sampleRate * (encoding === 'pcm16' ? 2 : 1);
    assert(encoding !== 'pcm16' || audio.length % 2 === 0, 'Incomplete PCM sample.');
    assert(
      timestampMs + (audio.length / bytesPerSecond) * 1000 <= 300000,
      'Debug recording exceeds five minutes.',
    );
    assert(
      !previous ||
        (previous.encoding === encoding &&
          previous.sampleRate === sampleRate &&
          !previous.uploaded),
      'Debug audio track format changed.',
    );
    const track = previous || {
      file: speaker + '.raw',
      encoding,
      sampleRate,
      offsetMs: timestampMs,
      bytes: 0,
    };
    const target =
      Math.round((Math.max(0, timestampMs - track.offsetMs) / 1000) * sampleRate) *
      (encoding === 'pcm16' ? 2 : 1);
    const padding = Math.max(0, target - track.bytes);
    assert(track.bytes + padding + audio.length <= limit, 'Debug audio track exceeds 30 MB.');
    assert(
      track.bytes + padding + audio.length <=
        Math.floor(((300000 - track.offsetMs) / 1000) * bytesPerSecond),
      'Debug audio track exceeds the five-minute timeline.',
    );
    const path = join(directory(sessionId), track.file);
    if (padding)
      appendFileSync(path, Buffer.alloc(padding, encoding === 'pcmu' ? 255 : 0), { mode: 0o600 });
    appendFileSync(path, audio, { mode: 0o600 });
    track.bytes += padding + audio.length;
    saveTrack(row, speaker, track);
  }
  function recordEvent(sessionId, input) {
    const row = record(sessionId);
    assert(['recording', 'queued'].includes(row.status), 'Debug event timeline is closed.', 409);
    assert(
      input &&
        typeof input.type === 'string' &&
        /^(session|response|test|input_audio_buffer|tool|recording|playback|connection)[._a-z0-9-]{0,100}$/.test(
          input.type,
        ),
      'Invalid debug event type.',
    );
    assert(
      input.name === undefined ||
        [
          'confirm_identity',
          'record_outcome',
          'agree_payment_solution',
          'get_test_context',
        ].includes(input.name),
      'Invalid debug tool name.',
    );
    assert(
      Number.isFinite(input.timestampMs) && input.timestampMs >= 0 && input.timestampMs <= 300000,
      'Invalid debug event timestamp.',
    );
    const events = JSON.parse(row.events || '[]');
    assert(events.length < 500, 'Debug event limit reached.', 429);
    events.push({
      type: input.type,
      ...(input.name ? { name: input.name } : {}),
      timestampMs: input.timestampMs,
    });
    run(
      db,
      'UPDATE debug_voice_sessions SET events=?,updated_at=? WHERE id=?',
      JSON.stringify(events),
      now(),
      row.id,
    );
  }
  function finish(sessionId) {
    const row = record(sessionId);
    if (row.status !== 'recording') return summary(row, true);
    clearTimeout(timers.get(sessionId));
    timers.delete(sessionId);
    if (!Object.keys(JSON.parse(row.tracks)).length)
      status(sessionId, 'failed', 'No recorded audio was received.');
    else status(sessionId, 'queued');
    queueMicrotask(pump);
    return summary(record(sessionId), true);
  }
  function pump() {
    if (stopped || running || !available()) return;
    const row = one(
      db,
      "SELECT * FROM debug_voice_sessions WHERE status='queued' ORDER BY created_at LIMIT 1",
    );
    if (!row) return;
    const dir = directory(row.id),
      tracks = JSON.parse(row.tracks),
      metadata = join(dir, 'metadata.json'),
      output = join(dir, 'transcript.json');
    try {
      assert(
        Object.values(tracks).every(
          (track) =>
            /^(user|assistant)\.(raw|webm|mp4)$/.test(track.file) &&
            existsSync(join(dir, track.file)),
        ),
        'Missing recording file.',
      );
      writeFileSync(
        metadata,
        JSON.stringify({
          tracks,
          model: config.whisperModel,
          ffmpeg: config.ffmpegPath,
          engine: config.whisperEngine || 'auto',
        }),
        { mode: 0o600 },
      );
      status(row.id, 'transcribing');
      const child = spawnImpl(config.whisperPython, [script, metadata, output], {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || '',
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
      });
      const job = { id: row.id, child, done: false };
      running = job;
      job.timeout = setTimeout(
        () => {
          job.timeoutExpired = true;
          child.kill('SIGKILL');
        },
        15 * 60 * 1000,
      );
      job.timeout.unref?.();
      const complete = (code) => {
        if (job.done) return;
        job.done = true;
        clearTimeout(job.timeout);
        running = null;
        try {
          if (code !== 0 || job.timeoutExpired) throw new Error('worker failed');
          assert(statSync(output).size <= 2 * 1024 * 1024, 'Transcript output too large.');
          const result = JSON.parse(readFileSync(output, 'utf8'));
          assert(
            !result.error && Array.isArray(result.segments) && result.segments.length <= 10000,
            'Invalid transcription result.',
          );
          const segments = result.segments.map((segment) => {
            assert(
              speakers.includes(segment.speaker) &&
                Number.isFinite(segment.start) &&
                Number.isFinite(segment.end) &&
                segment.start >= 0 &&
                segment.end >= segment.start &&
                segment.end <= 301 &&
                typeof segment.text === 'string' &&
                segment.text.length <= 10000,
              'Invalid transcript segment.',
            );
            return {
              speaker: segment.speaker,
              start: segment.start,
              end: segment.end,
              text: segment.text,
            };
          });
          run(
            db,
            "UPDATE debug_voice_sessions SET status='completed',segments=?,error=NULL,updated_at=? WHERE id=?",
            JSON.stringify(segments),
            now(),
            row.id,
          );
        } catch {
          status(
            row.id,
            'failed',
            job.timeoutExpired
              ? 'Local transcription timed out.'
              : 'Local transcription failed. Check the installed Whisper engine, cached model and recording format.',
          );
        }
        if (!stopped) queueMicrotask(pump);
      };
      child.once('error', () => complete(1));
      child.once('close', complete);
    } catch {
      running = null;
      status(
        row.id,
        'failed',
        'Recorded audio is missing or the local transcription worker could not start.',
      );
      if (!stopped) queueMicrotask(pump);
    }
  }
  const own = (req) => {
    const row = record(req.params.id);
    assert(
      row.owner === ownerHash(req.sessionToken),
      'This recording belongs to another session.',
      403,
    );
    return row;
  };
  const listing = (_req, res) =>
    res.json({
      enabled: config.voiceDebugEnabled === true,
      available: available(),
      reason: reason(),
      sessions: all(
        db,
        'SELECT * FROM debug_voice_sessions ORDER BY created_at DESC LIMIT 100',
      ).map((row) => summary(row)),
    });
  router.get('/', listing);
  router.get('/sessions', listing);
  router.post('/sessions', (req, res) => {
    assert(req.body?.provider === 'openai', 'Invalid browser debug provider.');
    res.json(
      create({
        owner: req.sessionToken,
        provider: req.body.provider,
        sourceId: req.body.sourceId ?? null,
      }),
    );
  });
  router.post(
    '/:id/audio',
    express.raw({ type: ['audio/webm', 'audio/mp4'], limit }),
    (req, res) => {
      const row = own(req);
      writable(row);
      const speaker = req.query.speaker,
        offsetMs = Number(req.query.offsetMs || 0),
        type = req.headers['content-type']?.split(';')[0];
      assert(
        speakers.includes(speaker) &&
          Buffer.isBuffer(req.body) &&
          req.body.length > 0 &&
          req.body.length <= limit,
        'Upload a WebM or MP4 audio recording up to 30 MB.',
      );
      assert(
        Number.isFinite(offsetMs) && offsetMs >= 0 && offsetMs <= 300000,
        'Invalid recording offset.',
      );
      assert(!JSON.parse(row.tracks)[speaker], 'This speaker recording was already uploaded.', 409);
      const track = {
        file: `${speaker}.${type === 'audio/mp4' ? 'mp4' : 'webm'}`,
        encoding: type,
        offsetMs,
        bytes: req.body.length,
        uploaded: true,
      };
      writeFileSync(join(directory(row.id), track.file), req.body, { mode: 0o600 });
      saveTrack(row, speaker, track);
      res.json({ ok: true });
    },
  );
  router.post('/:id/events', (req, res) => {
    const row = own(req),
      entries = req.body?.events;
    assert(Array.isArray(entries) && entries.length <= 500, 'Provide up to 500 debug events.');
    transaction(db, () => {
      for (const entry of entries) recordEvent(row.id, entry);
    });
    res.json({ ok: true });
  });
  router.post('/:id/finish', (req, res) => res.json(finish(own(req).id)));
  router.get('/:id', (req, res) => res.json(summary(record(req.params.id), true)));
  router.get('/:id/audio/:speaker', (req, res) => {
    const row = record(req.params.id),
      speaker = req.params.speaker;
    assert(speakers.includes(speaker), 'Invalid speaker.');
    const track = JSON.parse(row.tracks)[speaker];
    assert(track, 'Speaker audio is unavailable.', 404);
    const dir = directory(row.id),
      wav = join(dir, speaker + '.wav');
    const path = existsSync(wav) ? wav : track.uploaded ? join(dir, track.file) : null;
    assert(path && existsSync(path), 'Playback is available after audio conversion.', 404);
    res
      .set('Cache-Control', 'no-store')
      .type(path.endsWith('.wav') ? 'audio/wav' : track.encoding)
      .sendFile(path);
  });
  router.delete('/:id', (req, res) => {
    const row = record(req.params.id);
    assert(
      row.status !== 'transcribing',
      'Wait for local transcription to finish before deleting.',
      409,
    );
    clearTimeout(timers.get(row.id));
    timers.delete(row.id);
    rmSync(directory(row.id), { recursive: true, force: true });
    run(db, 'DELETE FROM debug_voice_sessions WHERE id=?', row.id);
    res.json({ ok: true });
  });
  router.use((error, req, res, next) => {
    if (!(error instanceof AppError) || res.headersSent) return next(error);
    res.status(error.status).json({ error: error.message });
  });
  poll = setInterval(pump, 1000);
  poll.unref?.();
  queueMicrotask(pump);
  function closeAll() {
    stopped = true;
    clearInterval(poll);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (running) {
      const job = running;
      job.done = true;
      clearTimeout(job.timeout);
      job.child.kill('SIGKILL');
      status(job.id, 'queued');
      running = null;
    }
  }
  return { router, create, append, finish, recordEvent, closeAll };
}
