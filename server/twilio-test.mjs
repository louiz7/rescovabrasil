import express from 'express';
import { demoPaymentOffers } from './demo-payment.mjs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { id, now, one, all, run, transaction } from './db.mjs';
import { assert, AppError } from './domain.mjs';
import { validTwilio, xmlEscape } from './providers.mjs';
import { browserTestCase, isolatedDatabase, executeTestTool } from './browser-voice.mjs';

const terminal = new Set(['completed', 'busy', 'no-answer', 'canceled', 'failed']);
const ranks = { starting: 0, queued: 1, initiated: 2, ringing: 3, 'in-progress': 4 };
const phone = /^\+[1-9]\d{7,14}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sidPattern = /^CA[a-f0-9]{32}$/i;
const ownerKey = (token) => createHash('sha256').update(token).digest('hex');
export function validTestPublicUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.hostname.includes('.') &&
      !isIP(u.hostname.replace(/^\[|\]$/g, '')) &&
      !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(u.hostname) &&
      !u.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
export function createTwilioTests(
  db,
  config,
  { fetchImpl = fetch, ttlMs = 300000, onAgreement, onOutcome, voiceDebug, onEnded } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS twilio_test_calls (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
    destination TEXT NOT NULL, provider_sid TEXT UNIQUE, state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
    identity_confirmation TEXT, outcome TEXT, events TEXT NOT NULL DEFAULT '[]',
    sequence INTEGER NOT NULL DEFAULT -1, end_requested INTEGER NOT NULL DEFAULT 0
  );`);
  if (
    !all(db, 'PRAGMA table_info(twilio_test_calls)').some((column) => column.name === 'agreement')
  )
    db.exec('ALTER TABLE twilio_test_calls ADD COLUMN agreement TEXT');
  if (!all(db, 'PRAGMA table_info(twilio_test_calls)').some((column) => column.name === 'platform'))
    db.exec('ALTER TABLE twilio_test_calls ADD COLUMN platform TEXT');
  if (!all(db, 'PRAGMA table_info(twilio_test_calls)').some((column) => column.name === 'debug_id'))
    db.exec('ALTER TABLE twilio_test_calls ADD COLUMN debug_id TEXT');
  // A restart cannot establish whether Twilio accepted an in-flight create request.
  run(
    db,
    "UPDATE twilio_test_calls SET state='unknown',error='Server restarted; awaiting provider reconciliation. Never redial automatically.',updated_at=? WHERE state NOT IN ('completed','busy','no-answer','canceled','failed')",
    now(),
  );
  const router = express.Router(),
    hooks = express.Router(),
    active = new Map();
  const row = (callId) => one(db, 'SELECT * FROM twilio_test_calls WHERE id=?', callId);
  const publicRow = (r) =>
    r && {
      id: r.id,
      state: r.state,
      destination: r.destination,
      providerSid: r.provider_sid,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      error: r.error,
      identityConfirmation: r.identity_confirmation,
      outcome: r.outcome,
      agreement: r.agreement ? JSON.parse(r.agreement) : null,
      platform: r.platform ? JSON.parse(r.platform) : null,
      debugId: r.debug_id || null,
      events: JSON.parse(r.events),
      closed: terminal.has(r.state),
      endRequested: !!r.end_requested,
    };
  const append = (callId, kind, detail) => {
    const r = row(callId),
      events = JSON.parse(r.events);
    events.push({ kind, detail, at: now() });
    run(
      db,
      'UPDATE twilio_test_calls SET events=?,updated_at=? WHERE id=?',
      JSON.stringify(events.slice(-100)),
      now(),
      callId,
    );
  };
  function release(callId) {
    const session = active.get(callId);
    if (!session || session.closed) return;
    session.closed = true;
    active.delete(callId);
    clearTimeout(session.timer);
    try {
      session.onClose?.();
    } catch {
      // Media shutdown cannot prevent isolated data cleanup.
    } finally {
      session.finishDebug?.();
      session.db.close();
    }
  }
  function update(callId, state, detail, sequence = null) {
    const r = row(callId);
    if (!r || terminal.has(r.state)) return;
    if (!terminal.has(state) && !(state in ranks) && state !== 'unknown') return;
    if (sequence !== null && sequence <= r.sequence) return;
    if (
      !terminal.has(state) &&
      state !== 'unknown' &&
      r.state !== 'unknown' &&
      ranks[state] < ranks[r.state]
    )
      return;
    run(
      db,
      'UPDATE twilio_test_calls SET state=?,updated_at=?,sequence=?,error=? WHERE id=?',
      state,
      now(),
      sequence ?? r.sequence,
      state === 'unknown' ? detail || 'Provider state unconfirmed.' : null,
      callId,
    );
    if (state !== r.state || detail) append(callId, 'status', detail || state);
    if (terminal.has(state)) {
      release(callId);
      onEnded?.(callId);
    }
  }
  const authHeaders = () => ({
    Authorization:
      'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid || '')}/Calls`;
  const finishing = new Map();
  async function finish(callId, reason = 'Call ended by operator') {
    if (finishing.has(callId)) return finishing.get(callId);
    const r = row(callId);
    if (!r || terminal.has(r.state)) return;
    run(db, 'UPDATE twilio_test_calls SET end_requested=1,updated_at=? WHERE id=?', now(), callId);
    append(callId, 'end_requested', reason);
    // Protect against bridge shutdown re-entering finish synchronously.
    finishing.set(callId, Promise.resolve());
    // Stop AI/media immediately; Twilio termination is independently confirmed below.
    release(callId);
    if (!r.provider_sid) {
      finishing.delete(callId);
      return;
    }
    const operation = (async () => {
      try {
        const response = await fetchImpl(`${callsUrl}/${encodeURIComponent(r.provider_sid)}.json`, {
          method: 'POST',
          headers: authHeaders(),
          body: new URLSearchParams({ Status: 'completed' }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error('unconfirmed');
        const result = await response.json();
        if (result.sid !== r.provider_sid || !terminal.has(result.status))
          throw new Error('unconfirmed');
        update(callId, result.status, 'Twilio confirmed call termination.');
      } catch {
        update(callId, 'unknown', 'Call termination unconfirmed. Check Twilio; do not redial.');
      } finally {
        finishing.delete(callId);
      }
    })();
    finishing.set(callId, operation);
    return operation;
  }
  function makeSession(callId, owner) {
    const isolated = isolatedDatabase(callId),
      results = new Map();
    const session = {
      id: callId,
      db: isolated,
      closed: false,
      startDebug() {
        if (!voiceDebug || !config.voiceDebugEnabled || session.debugId) return;
        try {
          session.debugId = voiceDebug.create({ owner, provider: 'twilio', sourceId: callId }).id;
          session.debugStarted = Date.now();
          run(db, 'UPDATE twilio_test_calls SET debug_id=? WHERE id=?', session.debugId, callId);
        } catch {
          append(callId, 'debug', 'Local debug recording could not start.');
        }
      },
      debugAudio(chunk) {
        if (!session.debugId) return;
        try {
          voiceDebug.append(session.debugId, chunk);
        } catch {
          if (!session.debugAudioFailed)
            append(callId, 'debug', 'Debug audio capture failed; call continues.');
          session.debugAudioFailed = true;
        }
      },
      debugEvent(type, name) {
        if (!session.debugId) return;
        try {
          voiceDebug.recordEvent(session.debugId, {
            type,
            name,
            timestampMs: Date.now() - session.debugStarted,
          });
        } catch {}
      },
      finishDebug() {
        if (!session.debugId || session.debugFinished) return;
        session.debugFinished = true;
        try {
          voiceDebug.finish(session.debugId);
        } catch {
          append(callId, 'debug', 'Debug recording could not be queued for transcription.');
        }
      },
      get providerSid() {
        return row(callId).provider_sid;
      },
      update: (state, detail) => update(callId, state, detail),
      finish: (reason) => finish(callId, reason),
      execute(name, args, callIdKey) {
        assert(!session.closed, 'Phone test session closed.', 409);
        assert(
          typeof callIdKey === 'string' && callIdKey.length > 0 && callIdKey.length <= 200,
          'Invalid tool call identifier.',
        );
        if (results.has(callIdKey)) return results.get(callIdKey);
        assert(results.size < 50, 'Phone test tool limit reached.', 429);
        assert(
          [
            'confirm_identity',
            'record_outcome',
            'get_test_context',
            'agree_payment_solution',
          ].includes(name),
          'Tool not allowed.',
        );
        assert(
          args &&
            typeof args === 'object' &&
            !Array.isArray(args) &&
            JSON.stringify(args).length <= 5000,
          'Invalid tool arguments.',
        );
        const safe = { ...args };
        if (typeof safe.note === 'string')
          safe.note = safe.note.replace(
            /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
            '[identifier omitted]',
          );
        let result;
        try {
          result = executeTestTool(isolated, callId, name, safe);
          if (result.recorded && onOutcome) onOutcome({ sessionId: callId, args: safe });
          if (result.agreed && onAgreement)
            result = {
              ...result,
              platform: onAgreement({
                sessionId: callId,
                agreement: result.agreement,
                destination: row(callId).destination,
              }),
            };
        } catch {
          result = {
            error: 'Tool request could not be applied. Check identity and outcome arguments.',
            next: 'human_review',
          };
        }
        session.debugEvent('tool.result', name);
        results.set(callIdKey, result);
        if (result.confirmed)
          run(
            db,
            "UPDATE twilio_test_calls SET identity_confirmation='self_reported_name' WHERE id=?",
            callId,
          );
        if (result.recorded)
          run(db, 'UPDATE twilio_test_calls SET outcome=? WHERE id=?', result.outcome, callId);
        if (result.agreed)
          run(
            db,
            'UPDATE twilio_test_calls SET agreement=? WHERE id=?',
            JSON.stringify(result.agreement),
            callId,
          );
        if (result.platform)
          run(
            db,
            'UPDATE twilio_test_calls SET platform=? WHERE id=?',
            JSON.stringify(result.platform),
            callId,
          );
        append(callId, 'tool', {
          name,
          confirmed: result.confirmed === true,
          recorded: result.recorded === true,
          agreed: result.agreed === true,
          outcome: result.outcome || null,
          error: !!result.error,
        });
        return result;
      },
    };
    session.timer = setTimeout(
      () => void finish(callId, 'Five-minute phone test limit reached.'),
      ttlMs,
    );
    session.timer.unref?.();
    active.set(callId, session);
    return session;
  }
  function checks(owner) {
    const activeCall = one(
      db,
      "SELECT id,owner FROM twilio_test_calls WHERE state NOT IN ('completed','busy','no-answer','canceled','failed') LIMIT 1",
    );
    return [
      {
        key: 'enabled',
        label: 'Phone test enabled',
        configured: config.twilioTestEnabled === true,
        detail: 'TWILIO_TEST_ENABLED=true enables only this isolated test.',
      },
      {
        key: 'twilio',
        label: 'Twilio credentials and caller number',
        configured:
          /^AC[a-f0-9]{32}$/i.test(config.accountSid || '') &&
          !!config.authToken &&
          phone.test(config.fromPhone || ''),
        detail: 'Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and an E.164 TWILIO_PHONE_NUMBER.',
      },
      {
        key: 'openai',
        label: 'OpenAI API key',
        configured: !!config.openaiKey,
        detail: 'Configure OPENAI_API_KEY with GPT-Live and backend model access.',
      },
      {
        key: 'publicUrl',
        label: 'Public HTTPS/WSS callback URL',
        configured: validTestPublicUrl(config.publicUrl),
        detail: 'A publicly reachable HTTPS URL with WSS support is required.',
      },
      {
        key: 'destinations',
        label: 'Authorized test recipients',
        configured: config.allowlist.some((value) => phone.test(value)),
        detail: 'Add your own authorized E.164 test number to OUTBOUND_ALLOWLIST.',
      },
      {
        key: 'idle',
        label: 'No unresolved phone test',
        configured: !activeCall,
        detail: activeCall
          ? 'An active or uncertain call must end and be confirmed by Twilio before another test.'
          : 'Ready for one test call at a time.',
      },
    ];
  }
  const owned = (req) => {
    const r = row(req.params.id);
    assert(r && r.owner === ownerKey(req.sessionToken), 'Phone test not found.', 404);
    return r;
  };
  router.get('/', (req, res) => {
    const owner = ownerKey(req.sessionToken),
      c = checks(owner);
    res.json({
      available: c.every((v) => v.configured),
      checks: c,
      destinations: config.allowlist.filter((v) => phone.test(v)),
      fromPhone: config.fromPhone || null,
      publicUrl: config.publicUrl || null,
      model: config.liveModel || 'gpt-live-1',
      backendModel: config.liveBackendModel || 'gpt-5.6-terra',
      case: browserTestCase,
      offers: demoPaymentOffers,
      maxSeconds: 300,
      debugRecordingEnabled: !!config.voiceDebugEnabled,
      currentCall: publicRow(
        one(
          db,
          'SELECT * FROM twilio_test_calls WHERE owner=? ORDER BY created_at DESC LIMIT 1',
          owner,
        ),
      ),
    });
  });
  router.get('/calls/:id', (req, res) => res.json(publicRow(owned(req))));
  router.post('/calls/:id/end', async (req, res) => {
    const r = owned(req);
    await finish(r.id);
    res.json(publicRow(row(r.id)));
  });
  router.post('/calls', async (req, res) => {
    const { destination, confirmed, requestId } = req.body || {},
      owner = ownerKey(req.sessionToken);
    assert(confirmed === true, 'Confirm that this is your authorized test number.');
    assert(typeof requestId === 'string' && uuid.test(requestId), 'A UUID requestId is required.');
    const existing = one(db, 'SELECT * FROM twilio_test_calls WHERE request_id=?', requestId);
    if (existing) {
      assert(existing.owner === owner, 'Phone test not found.', 404);
      assert(
        existing.destination === destination,
        'Request already belongs to another destination.',
        409,
      );
      return res.json(publicRow(existing));
    }
    assert(
      checks(owner).every((v) => v.configured),
      'Phone test configuration is incomplete or another call is unresolved.',
      409,
    );
    assert(
      typeof destination === 'string' &&
        phone.test(destination) &&
        config.allowlist.includes(destination),
      'Destination is not on the authorized test allowlist.',
      403,
    );
    const callId = id();
    transaction(db, () => {
      assert(
        !one(
          db,
          "SELECT id FROM twilio_test_calls WHERE state NOT IN ('completed','busy','no-answer','canceled','failed') LIMIT 1",
        ),
        'Another call is unresolved.',
        409,
      );
      run(
        db,
        'INSERT INTO twilio_test_calls (id,request_id,owner,destination,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        callId,
        requestId,
        owner,
        destination,
        'starting',
        now(),
        now(),
      );
    });
    makeSession(callId, req.sessionToken);
    append(callId, 'authorized', 'Operator explicitly confirmed this allowlisted test recipient.');
    try {
      const body = new URLSearchParams({
        To: destination,
        From: config.fromPhone,
        Url: `${config.publicUrl}/hooks/twilio-test/voice/${callId}`,
        Method: 'POST',
        StatusCallback: `${config.publicUrl}/hooks/twilio-test/status/${callId}`,
        StatusCallbackMethod: 'POST',
        Timeout: '25',
        TimeLimit: '300',
        Record: 'false',
      });
      for (const v of ['initiated', 'ringing', 'answered', 'completed'])
        body.append('StatusCallbackEvent', v);
      const response = await fetchImpl(`${callsUrl}.json`, {
        method: 'POST',
        headers: authHeaders(),
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const state = response.status >= 400 && response.status < 500 ? 'failed' : 'unknown';
        if (!row(callId).provider_sid)
          update(
            callId,
            state,
            `Twilio did not confirm call creation (HTTP ${response.status}). Check configuration before any new test.`,
          );
      } else {
        const result = await response.json();
        assert(sidPattern.test(result.sid || ''), 'Invalid provider call identifier.', 502);
        const current = row(callId);
        assert(
          !current.provider_sid || current.provider_sid === result.sid,
          'Provider call identifier mismatch.',
          502,
        );
        run(db, 'UPDATE twilio_test_calls SET provider_sid=? WHERE id=?', result.sid, callId);
        update(
          callId,
          result.status in ranks || terminal.has(result.status) ? result.status : 'queued',
        );
        if (row(callId).end_requested)
          await finish(callId, 'Deferred call termination after creation.');
      }
    } catch {
      if (!row(callId).provider_sid)
        update(
          callId,
          'unknown',
          'Call creation unconfirmed. Check Twilio; never retry with a new request ID.',
        );
    }
    res.status(201).json(publicRow(row(callId)));
  });
  hooks.use(express.raw({ type: () => true, limit: '64kb' }));
  hooks.use((req, res, next) => {
    assert(
      req.headers['content-type']?.includes('application/x-www-form-urlencoded'),
      'Invalid webhook format.',
      415,
    );
    const params = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
    assert(
      validTestPublicUrl(config.publicUrl) &&
        validTwilio(
          config,
          config.publicUrl + req.originalUrl,
          params,
          req.headers['x-twilio-signature'],
        ),
      'Invalid Twilio signature.',
      403,
    );
    assert(
      params.AccountSid === config.accountSid && sidPattern.test(params.CallSid || ''),
      'Invalid Twilio call source.',
      403,
    );
    req.provider = params;
    next();
  });
  const bind = (req) => {
    const r = row(req.params.id);
    assert(r, 'Phone test not found.', 404);
    assert(
      !r.provider_sid || r.provider_sid === req.provider.CallSid,
      'Twilio call does not match test.',
      403,
    );
    if (!r.provider_sid)
      run(db, 'UPDATE twilio_test_calls SET provider_sid=? WHERE id=?', req.provider.CallSid, r.id);
    return row(r.id);
  };
  hooks.post('/status/:id', async (req, res) => {
    const r = bind(req),
      status = req.provider.CallStatus,
      seq = req.provider.SequenceNumber;
    assert(status in ranks || terminal.has(status), 'Invalid Twilio call status.');
    assert(seq === undefined || /^\d+$/.test(seq), 'Invalid callback sequence.');
    update(r.id, status, null, seq === undefined ? null : Number(seq));
    if (row(r.id).end_requested && !terminal.has(row(r.id).state))
      await finish(r.id, 'Terminate after provider callback.');
    res.json({ ok: true });
  });
  hooks.post('/voice/:id', (req, res) => {
    const r = bind(req),
      session = active.get(r.id);
    if (terminal.has(r.state) || r.end_requested || !session || session.closed)
      return res.type('xml').send('<Response><Hangup/></Response>');
    const stream = config.publicUrl.replace(/^https:/, 'wss:') + '/twilio-test-media/' + r.id;
    res
      .type('xml')
      .send(
        `<Response><Connect><Stream url="${xmlEscape(stream)}"/></Connect><Hangup/></Response>`,
      );
  });
  const errors = (error, req, res, next) => {
    if (!(error instanceof AppError) || res.headersSent) return next(error);
    res.status(error.status).json({ error: error.message });
  };
  router.use(errors);
  hooks.use(errors);
  async function reconcileUnknown() {
    for (const r of all(
      db,
      "SELECT * FROM twilio_test_calls WHERE state='unknown' AND provider_sid IS NOT NULL",
    )) {
      if (!config.accountSid || !config.authToken) continue;
      try {
        const response = await fetchImpl(`${callsUrl}/${encodeURIComponent(r.provider_sid)}.json`, {
          headers: authHeaders(),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) continue;
        const result = await response.json();
        if (result.sid === r.provider_sid && terminal.has(result.status))
          update(r.id, result.status, 'Terminal status reconciled with Twilio.');
      } catch {
        /* An uncertain call remains blocked until a signed callback or lookup confirms it. */
      }
    }
  }
  const reconciliation = setInterval(() => void reconcileUnknown(), 30000);
  reconciliation.unref?.();
  const closeAll = async () => {
    clearInterval(reconciliation);
    await Promise.all([...active.keys()].map((callId) => finish(callId, 'Server shutting down.')));
  };
  return { router, hooks, getSession: (callId) => active.get(callId), closeAll, reconcileUnknown };
}
