import { createAgentWorkflows } from './agent-workflows.mjs';
import { createAgentRunner } from './agent-models.mjs';
import { agentRegistry } from './agent-registry.mjs';
import {
  adoptLegacyPortfolios,
  portfolioList,
  portfolioDetail,
  activatePortfolio,
  pausePortfolio,
  reconcilePortfolios,
} from './portfolio-operations.mjs';
import express from 'express';
import { createVoiceDebug } from './voice-debug.mjs';
import {
  ensureDemoPlatform,
  syncDemoOutcome,
  persistDemoAgreement,
  getCasePaymentData,
  updatePaymentFollowup,
} from './demo-platform.mjs';
import { createGrokVoiceTests } from './grok-voice.mjs';
import { createTwilioTests } from './twilio-test.mjs';
import { createBrowserVoiceTests } from './browser-voice.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { id, now, all, one, run, event, transaction } from './db.mjs';
import { assert, clean, OUTCOMES, csvCell, AppError } from './domain.mjs';
import {
  decodeFile,
  suggestMapping,
  validateRows,
  publicReport,
  commitImport,
} from './importer.mjs';
import {
  createPortfolio,
  publicCase,
  policy,
  savePolicy,
  createCampaign,
  campaignAction,
  campaignList,
  dashboard,
  recordOutcome,
  claimNext,
  finishDispatch,
  finishCampaigns,
  advanceWaiting,
} from './service.mjs';
import { capabilities, validTwilio, validSendgrid, safeEqual, xmlEscape } from './providers.mjs';
import { providerStatus, inboundMessage, receiveOnce } from './webhooks.mjs';

export function createApp(
  db,
  config,
  { voiceFetch, voiceTestTtlMs, twilioFetch, grokConnect, grokTestTtlMs, agentRun } = {},
) {
  assert(
    config.password.length >= 12 || config.mode === 'demo',
    'Set OPERATOR_PASSWORD to at least 12 characters.',
  );
  const app = express(),
    sessions = new Map(),
    logins = new Map();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const voiceDebug = createVoiceDebug(db, config);
  app.locals.voiceDebug = voiceDebug;
  ensureDemoPlatform(db);
  adoptLegacyPortfolios(db);
  const agentWorkflows = createAgentWorkflows(db, config, {
    runAgent: agentRun || createAgentRunner(config),
  });
  app.locals.agentWorkflows = agentWorkflows;
  const saveDemoAgreement = (provider) => (details) =>
    config.mode === 'demo'
      ? persistDemoAgreement(
          db,
          config,
          { ...details, provider },
          {
            onSaved: config.agentWorkflowsEnabled
              ? (saved) => agentWorkflows.agreementSaved(saved)
              : undefined,
          },
        )
      : null;
  const saveDemoOutcome = (provider) => (details) => {
    if (config.mode !== 'demo') return null;
    const result = syncDemoOutcome(db, config, { ...details, provider });
    agentWorkflows.outcomeChanged({ ...details, provider });
    return result;
  };
  const sourceEnded = (provider) => (sessionId) => {
    if (config.mode === 'demo' && config.agentWorkflowsEnabled)
      agentWorkflows.sourceEnded(provider, sessionId);
  };
  const twilioTests = createTwilioTests(db, config, {
    fetchImpl: twilioFetch,
    onAgreement: saveDemoAgreement('twilio'),
    onOutcome: saveDemoOutcome('twilio'),
    onEnded: sourceEnded('twilio'),
    voiceDebug,
  });
  app.locals.twilioTests = twilioTests;
  // Recover a terminal phone state committed immediately before a process stopped.
  if (config.mode === 'demo' && config.agentWorkflowsEnabled)
    for (const ended of all(
      db,
      `SELECT c.session_id FROM agent_conversations c JOIN twilio_test_calls t ON t.id=c.session_id WHERE c.provider='twilio' AND t.state IN ('completed','busy','no-answer','canceled','failed') AND NOT EXISTS(SELECT 1 FROM agent_source_ends e WHERE e.provider=c.provider AND e.session_id=c.session_id)`,
    ))
      agentWorkflows.sourceEnded('twilio', ended.session_id);
  app.use('/hooks/twilio-test', twilioTests.hooks);
  app.use('/hooks', express.raw({ type: () => true, limit: '1mb' }));
  const twilioGuard = (req, res, next) => {
    assert(config.mode === 'live', 'Live webhooks are not accepted in demo mode.', 403);
    assert(
      req.headers['content-type']?.includes('application/x-www-form-urlencoded'),
      'Invalid format.',
      415,
    );
    const params = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
    assert(
      validTwilio(
        config,
        config.publicUrl + req.originalUrl,
        params,
        req.headers['x-twilio-signature'],
      ),
      'Invalid Twilio signature.',
      403,
    );
    assert(params.AccountSid === config.accountSid, 'Invalid Twilio account.', 403);
    req.provider = params;
    next();
  };
  app.post('/hooks/twilio/status/:id', twilioGuard, (req, res) => {
    const b = req.provider;
    const a = one(db, 'SELECT * FROM attempts WHERE id=?', req.params.id);
    assert(a, 'Attempt not found.', 404);
    const voice = a.channel === 'voice';
    const status =
      (voice ? b.CallStatus : b.MessageStatus) === 'in-progress'
        ? 'answered'
        : voice
          ? b.CallStatus
          : b.MessageStatus;
    const result = providerStatus(db, a.id, voice ? b.CallSid : b.MessageSid, status, b.ErrorCode);
    res.json(result);
  });
  app.post('/hooks/twilio/inbound', twilioGuard, (req, res) => {
    const b = req.provider;
    assert(b.To === config.fromPhone, 'Recipient does not match the channel.', 403);
    inboundMessage(db, { key: b.MessageSid, from: b.From, text: b.Body, channel: 'sms' });
    res.type('xml').send('<Response/>');
  });
  app.post('/hooks/twilio/voice/:id', twilioGuard, (req, res) => {
    const a = one(db, 'SELECT * FROM attempts WHERE id=?', req.params.id);
    assert(
      a &&
        a.channel === 'voice' &&
        a.mode === 'live' &&
        (!a.provider_sid || a.provider_sid === req.provider.CallSid),
      'Invalid call.',
      403,
    );
    run(
      db,
      'UPDATE attempts SET provider_sid=COALESCE(provider_sid,?) WHERE id=?',
      req.provider.CallSid,
      a.id,
    );
    const url = config.publicUrl.replace(/^https:/, 'wss:') + '/media/' + a.id;
    res
      .type('xml')
      .send(
        `<Response><Connect><Stream url="${xmlEscape(url)}"/></Connect><Say language="pt-BR">O atendimento foi encerrado. Obrigada.</Say></Response>`,
      );
  });
  app.post('/hooks/sendgrid/events', (req, res) => {
    assert(
      config.mode === 'live' &&
        validSendgrid(
          config,
          req.body,
          req.headers['x-twilio-email-event-webhook-timestamp'],
          req.headers['x-twilio-email-event-webhook-signature'],
        ),
      'Invalid SendGrid signature.',
      403,
    );
    const events = JSON.parse(req.body);
    assert(Array.isArray(events) && events.length <= 1000, 'Invalid events.');
    for (const e of events) {
      const a = one(
        db,
        'SELECT * FROM attempts WHERE id=?',
        e.attempt_id || e.custom_args?.attempt_id || '',
      );
      if (
        !a ||
        a.channel !== 'email' ||
        a.mode !== 'live' ||
        e.email?.toLowerCase() !== a.destination
      )
        continue;
      const status = {
        processed: 'accepted',
        delivered: 'delivered',
        bounce: 'undelivered',
        dropped: 'failed',
        deferred: 'sending',
      }[e.event];
      if (status) providerStatus(db, a.id, a.provider_sid || e.sg_message_id, status, e.reason);
      if (['unsubscribe', 'spamreport', 'group_unsubscribe'].includes(e.event))
        receiveOnce(db, `email:${e.sg_event_id}`, () =>
          recordOutcome(
            db,
            a.case_id,
            { outcome: 'opt_out', note: 'Contact preference received through SendGrid' },
            'provider',
            a.id,
          ),
        );
    }
    res.json({ ok: true });
  });
  app.post('/hooks/email/inbound', (req, res) => {
    assert(
      config.mode === 'live' &&
        config.inboundSecret &&
        safeEqual(
          req.headers.authorization,
          'Basic ' + Buffer.from(`rescova:${config.inboundSecret}`).toString('base64'),
        ),
      'Invalid inbound reply credential.',
      403,
    );
    const type = req.headers['content-type'] || '';
    let body;
    if (type.includes('application/json')) body = JSON.parse(req.body);
    else if (type.includes('multipart/form-data')) {
      const boundary = type
        .match(/boundary=(?:"([^"]+)"|([^;]+))/)
        ?.slice(1)
        .find(Boolean);
      assert(boundary, 'Invalid multipart data.');
      body = {};
      for (const part of req.body.toString('utf8').split('--' + boundary)) {
        const split = part.indexOf('\r\n\r\n');
        if (split < 0) continue;
        const header = part.slice(0, split),
          name = header.match(/name="([^"]+)"/)?.[1];
        if (['from', 'text', 'headers', 'envelope'].includes(name) && !header.includes('filename='))
          body[name] = part.slice(split + 4).replace(/\r\n$/, '');
      }
      body.messageId = body.headers?.match(/^Message-I[Dd]:\s*(.+)$/im)?.[1]?.trim();
    } else throw new AppError('Invalid reply format.', 415);
    const from = body.from?.match(/<([^>]+)>/)?.[1] || body.from;
    assert(body.messageId, 'Reply has no Message-ID.');
    res.json(inboundMessage(db, { key: body.messageId, from, text: body.text, channel: 'email' }));
  });
  app.use('/api', express.json({ limit: '15mb' }));
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = new Set([
      `http://localhost:${config.port}`,
      `http://127.0.0.1:${config.port}`,
      config.publicUrl,
    ]);
    if (config.mode === 'demo') {
      allowed.add('http://localhost:5173');
      allowed.add('http://127.0.0.1:5173');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      assert(!origin || allowed.has(origin), 'Origin not allowed.', 403);
    const cookie = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('rescova_session='))
      ?.split('=')[1];
    const session = sessions.get(cookie);
    if (session && session.expires > Date.now()) req.session = session;
    else if (cookie) sessions.delete(cookie);
    req.sessionToken = cookie;
    next();
  });
  app.get('/api/session', (req, res) =>
    res.json({
      authenticated: !!req.session,
      mode: config.mode,
      user: req.session ? 'Operator' : null,
    }),
  );
  app.post('/api/login', (req, res) => {
    const key = req.socket.remoteAddress,
      previous = logins.get(key);
    const attempts =
      previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 600000 };
    assert(attempts.count < 10, 'Too many attempts. Try again in 10 minutes.', 429);
    attempts.count++;
    logins.set(key, attempts);
    assert(safeEqual(req.body.password, config.password), 'Incorrect password.', 401);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + 8 * 3600000 });
    logins.delete(key);
    res
      .cookie('rescova_session', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.mode === 'live',
        maxAge: 8 * 3600000,
        path: '/',
      })
      .json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    assert(req.session, 'Sign in to access the workspace.', 401);
    next();
  });
  const voiceTests = createBrowserVoiceTests(config, {
    fetchImpl: voiceFetch,
    ttlMs: voiceTestTtlMs,
    onAgreement: saveDemoAgreement('openai'),
    onOutcome: saveDemoOutcome('openai'),
    onEnded: sourceEnded('openai'),
  });
  app.locals.voiceTests = voiceTests;
  app.use('/api/voice-test', voiceTests.router);
  app.use('/api/voice-debug', voiceDebug.router);
  app.use('/api/agent-workflows', agentWorkflows.router);
  app.get('/api/agents', (_req, res) => res.json(agentRegistry(config, agentWorkflows)));
  const grokTests = createGrokVoiceTests(config, {
    connect: grokConnect,
    ttlMs: grokTestTtlMs,
    onAgreement: saveDemoAgreement('grok'),
    onOutcome: saveDemoOutcome('grok'),
    onEnded: sourceEnded('grok'),
  });
  app.locals.grokTests = grokTests;
  app.use('/api/grok-voice-test', grokTests.router);
  app.use('/api/twilio-test', twilioTests.router);
  app.post('/api/logout', async (req, res) => {
    sessions.delete(req.sessionToken);
    await Promise.all([
      voiceTests.closeOwner(req.sessionToken),
      grokTests.closeOwner(req.sessionToken),
    ]);
    res.clearCookie('rescova_session', { path: '/' }).json({ ok: true });
  });
  app.get('/api/dashboard', (_req, res) => res.json(dashboard(db, config.mode)));
  app.get('/api/settings', (_req, res) =>
    res.json({
      mode: config.mode,
      capabilities: capabilities(config),
      policy: policy(db),
      model: config.realtimeModel,
      language: 'pt-BR',
      currency: 'BRL',
      publicUrl: config.publicUrl || null,
    }),
  );
  app.put('/api/settings/policy', (req, res) => res.json(savePolicy(db, req.body)));
  app.get('/api/portfolios', (_req, res) => res.json(portfolioList(db, config.mode)));
  app.get('/api/portfolios/:id', (req, res) =>
    res.json(portfolioDetail(db, req.params.id, config.mode)),
  );
  app.post('/api/portfolios/:id/activate', (req, res) =>
    res.json(activatePortfolio(db, req.params.id, req.body, config.mode)),
  );
  app.post('/api/portfolios/:id/pause', (req, res) =>
    res.json(pausePortfolio(db, req.params.id, config.mode)),
  );
  app.post('/api/portfolios', (req, res) => res.status(201).json(createPortfolio(db, req.body)));
  app.get('/api/cases', (req, res) => {
    const search = clean(req.query.search),
      portfolio = clean(req.query.portfolio),
      status = clean(req.query.status);
    const where = `WHERE (?='' OR c.portfolio_id=?) AND (?='' OR c.status=?) AND (?='' OR c.name LIKE ? OR c.reference LIKE ? OR c.phone LIKE ?)`;
    const params = [
      portfolio,
      portfolio,
      status,
      status,
      search,
      ...Array(3).fill('%' + search + '%'),
    ];
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 100)),
      offset = Math.max(0, Number(req.query.offset) || 0);
    const total = one(db, `SELECT COUNT(*) total FROM cases c ${where}`, ...params).total;
    const rows = all(
      db,
      `SELECT c.*,p.name portfolio_name FROM cases c JOIN portfolios p ON p.id=c.portfolio_id ${where} ORDER BY c.created_at DESC,c.reference LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    ).map(publicCase);
    res.json({ rows, total });
  });
  app.get('/api/cases/export', (_req, res) => {
    const columns = [
      'reference',
      'name',
      'phone',
      'email',
      'amount_minor',
      'currency',
      'status',
      'outcome',
      'willingness',
      'ability',
    ];
    const lines = [
      columns.join(';'),
      ...all(db, 'SELECT * FROM cases').map((c) => columns.map((k) => csvCell(c[k])).join(';')),
    ];
    event(db, null, 'cases_exported', 'CSV exported by the operator');
    res
      .attachment('rescova-cases.csv')
      .type('text/csv')
      .send('\uFEFF' + lines.join('\r\n'));
  });
  app.get('/api/cases/:id', (req, res) => {
    const c = one(
      db,
      'SELECT c.*,p.name portfolio_name,p.creditor FROM cases c JOIN portfolios p ON p.id=c.portfolio_id WHERE c.id=?',
      req.params.id,
    );
    assert(c, 'Case not found.', 404);
    res.json({
      ...publicCase(c),
      ...getCasePaymentData(db, c.id),
      events: all(db, 'SELECT * FROM events WHERE case_id=? ORDER BY created_at DESC', c.id),
      attempts: all(db, 'SELECT * FROM attempts WHERE case_id=? ORDER BY created_at DESC', c.id),
      tasks: all(db, 'SELECT * FROM tasks WHERE case_id=? ORDER BY created_at DESC', c.id),
    });
  });
  app.post('/api/cases/:id/outcome', (req, res) =>
    res.json(transaction(db, () => recordOutcome(db, req.params.id, req.body))),
  );
  app.post('/api/cases/:id/reopen', (req, res) => {
    const c = one(db, 'SELECT * FROM cases WHERE id=?', req.params.id);
    assert(c, 'Case not found.', 404);
    assert(
      !c.suppressed,
      'Contact blocked: renewed authorization must be validated outside the pilot.',
    );
    assert(
      clean(req.body.note, 2000).length >= 15,
      'Explain the review in at least 15 characters.',
    );
    assert(
      !one(db, "SELECT 1 FROM tasks WHERE case_id=? AND status='open'", c.id),
      'Complete the review task first.',
    );
    run(db, "UPDATE cases SET review_required=0,outcome=NULL,status='ready' WHERE id=?", c.id);
    event(db, c.id, 'reopened', clean(req.body.note, 2000));
    res.json({ ok: true });
  });
  app.get('/api/imports', (_req, res) =>
    res.json(
      all(
        db,
        'SELECT id,portfolio_id,filename,status,created_at FROM imports ORDER BY created_at DESC',
      ),
    ),
  );
  app.post('/api/imports', async (req, res) => {
    assert(
      one(db, 'SELECT id FROM portfolios WHERE id=?', req.body.portfolioId),
      'Select a portfolio.',
    );
    const { headers, rows } = await decodeFile(clean(req.body.filename), req.body.content);
    const staged = {
      id: id(),
      portfolio_id: req.body.portfolioId,
      filename: clean(req.body.filename),
      headers: JSON.stringify(headers),
      rows: JSON.stringify(rows),
      created_at: now(),
    };
    run(
      db,
      'INSERT INTO imports (id,portfolio_id,filename,headers,rows,created_at) VALUES (?,?,?,?,?,?)',
      ...Object.values(staged),
    );
    res.status(201).json({
      id: staged.id,
      headers,
      total: rows.length,
      sample: rows.slice(0, 3).map((r) => r.map((v) => clean(v, 150))),
      mapping: suggestMapping(headers),
    });
  });
  app.post('/api/imports/:id/preview', (req, res) => {
    const stage = one(db, 'SELECT * FROM imports WHERE id=?', req.params.id);
    assert(stage && stage.status === 'staged', 'Import unavailable.', 404);
    const report = publicReport(validateRows(db, stage, req.body.mapping));
    run(db, 'UPDATE imports SET mapping=? WHERE id=?', JSON.stringify(req.body.mapping), stage.id);
    res.json({ rows: report });
  });
  app.post('/api/imports/:id/commit', (req, res) => {
    const result = commitImport(db, req.params.id, req.body.mapping, req.body.selectedRows);
    reconcilePortfolios(db, config.mode);
    res.json(result);
  });
  app.get('/api/imports/:id/report', (req, res) => {
    const stage = one(db, 'SELECT * FROM imports WHERE id=?', req.params.id);
    assert(stage, 'Import not found.', 404);
    res.json(
      stage.report
        ? JSON.parse(stage.report)
        : {
            rows: publicReport(
              validateRows(
                db,
                stage,
                stage.mapping
                  ? JSON.parse(stage.mapping)
                  : suggestMapping(JSON.parse(stage.headers)),
              ),
            ),
          },
    );
  });
  app.get('/api/campaigns', (_req, res) => res.json(campaignList(db)));
  app.post('/api/campaigns', (req, res) =>
    res.status(201).json(createCampaign(db, req.body, config.mode)),
  );
  app.post('/api/campaigns/:id/:action', (req, res) => {
    campaignAction(db, req.params.id, req.params.action);
    res.json({ ok: true });
  });
  app.get('/api/campaigns/:id', (req, res) => {
    const c = campaignList(db).find((c) => c.id === req.params.id);
    assert(c, 'Campaign not found.', 404);
    res.json({
      ...c,
      enrollments: all(
        db,
        'SELECT e.*,c.name,c.reference FROM enrollments e JOIN cases c ON c.id=e.case_id WHERE campaign_id=?',
        c.id,
      ),
      attempts: all(
        db,
        'SELECT a.*,c.name,c.reference FROM attempts a JOIN cases c ON c.id=a.case_id WHERE campaign_id=? ORDER BY a.created_at DESC',
        c.id,
      ),
    });
  });
  app.get('/api/payment-followups', (req, res) =>
    res.json(
      all(
        db,
        `SELECT * FROM payment_followup_jobs WHERE (?='' OR case_id=?) ORDER BY created_at DESC`,
        clean(req.query.caseId),
        clean(req.query.caseId),
      ),
    ),
  );
  app.patch('/api/payment-followups/:id', (req, res) =>
    res.json(updatePaymentFollowup(db, config, req.params.id, req.body)),
  );
  app.get('/api/tasks', (_req, res) =>
    res.json(
      all(
        db,
        `SELECT t.*,c.name,c.reference,c.outcome,p.name portfolio_name FROM tasks t JOIN cases c ON c.id=t.case_id JOIN portfolios p ON p.id=c.portfolio_id ORDER BY t.status DESC,CASE t.priority WHEN 'high' THEN 0 ELSE 1 END,t.due_at`,
      ),
    ),
  );
  app.patch('/api/tasks/:id', (req, res) => {
    const t = one(db, 'SELECT * FROM tasks WHERE id=?', req.params.id);
    assert(t, 'Task not found.', 404);
    const status = req.body.status || t.status;
    assert(['open', 'done'].includes(status), 'Invalid status.');
    const note = clean(req.body.note ?? t.note, 2000);
    if (status === 'done') assert(note.length >= 5, 'Describe the resolution.');
    const date = new Date(req.body.due_at || t.due_at);
    assert(!isNaN(date), 'Invalid due date.');
    run(
      db,
      'UPDATE tasks SET status=?,note=?,assignee=?,due_at=? WHERE id=?',
      status,
      note,
      clean(req.body.assignee ?? t.assignee),
      date.toISOString(),
      t.id,
    );
    event(db, t.case_id, 'task_updated', {
      status,
      note,
      assignee: clean(req.body.assignee ?? t.assignee),
    });
    res.json({ ok: true });
  });
  app.post('/api/demo/step', (req, res) => {
    assert(config.mode === 'demo', 'Simulation is unavailable in live mode.', 403);
    assert(!req.body.outcome || OUTCOMES.includes(req.body.outcome), 'Invalid simulation outcome.');
    const portfolioId = clean(req.body.portfolioId);
    if (portfolioId)
      assert(
        one(db, 'SELECT id FROM portfolios WHERE id=?', portfolioId),
        'Portfolio not found.',
        404,
      );
    reconcilePortfolios(db, config.mode);
    if (req.body.advanceTime) advanceWaiting(db, new Date(), true, portfolioId);
    const claimed = claimNext(db, capabilities(config), 'demo', new Date(), true, portfolioId);
    if (!claimed) {
      finishCampaigns(db);
      return res.json({
        processed: 0,
        message: 'No cases in the queue. Activate a portfolio or advance the simulated clock.',
      });
    }
    const { attempt, c } = claimed;
    finishDispatch(db, attempt, {
      status: attempt.channel === 'voice' ? 'completed' : 'delivered',
      message: 'Demo message — not sent.',
    });
    if (req.body.outcome) {
      if (
        attempt.channel === 'voice' &&
        ['paid_reported', 'willing_to_pay', 'unable_to_pay', 'disputed'].includes(req.body.outcome)
      ) {
        run(
          db,
          "UPDATE attempts SET identity_verified=1,identity_method='self_reported_name' WHERE id=?",
          attempt.id,
        );
        run(db, 'UPDATE cases SET identity_verified_at=? WHERE id=?', now(), c.id);
        event(
          db,
          c.id,
          'identity_self_reported',
          'Simulated name confirmation (self-reported).',
          'demo',
          attempt.id,
        );
      }
      recordOutcome(
        db,
        c.id,
        {
          outcome: req.body.outcome,
          note: 'Outcome selected in the simulator. No external communication.',
          callbackAt:
            req.body.outcome === 'callback'
              ? new Date(Date.now() + 86400000).toISOString()
              : undefined,
        },
        'demo',
        attempt.id,
      );
    }
    event(
      db,
      c.id,
      'simulated',
      'Simulated clock and response; these do not represent real contact.',
      'demo',
      attempt.id,
    );
    finishCampaigns(db);
    res.json({ processed: 1, caseId: c.id, name: c.name, channel: attempt.channel });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  if (existsSync(resolve('dist/index.html'))) {
    app.use(express.static(resolve('dist'), { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  } else
    app.get('/', (_req, res) =>
      res
        .type('text')
        .send(
          'Rescova API is running. Run npm run dev for the interface or npm run build for production.',
        ),
    );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error('Request failed:', err.name, err.code || 'internal');
    res.status(status).json({
      error:
        status >= 500
          ? 'Unable to complete the operation. Check the data format and try again.'
          : err.message,
    });
  });
  return app;
}
