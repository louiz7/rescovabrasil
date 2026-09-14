import express from 'express';
import { id, now, one, all, run, transaction, event, task } from './db.mjs';
import { assert } from './domain.mjs';
import { recordOutcome } from './service.mjs';

const demoReview = 'Review demo payment agreement and prepare payment follow-up';
const stoppedOutcomes = new Set([
  'opt_out',
  'invalid_contact',
  'disputed',
  'human_review',
  'paid_reported',
]);
export function createAgentWorkflows(db, config, { runAgent } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_source_ends (
    provider TEXT NOT NULL, session_id TEXT NOT NULL, ended_at TEXT NOT NULL, PRIMARY KEY(provider,session_id));
    CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), agreement_id TEXT NOT NULL,
    provider TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider,session_id));
    CREATE TABLE IF NOT EXISTS agent_jobs (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id), purpose TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id), direction TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(conversation_id,request_id));
    CREATE TABLE IF NOT EXISTS agent_model_runs (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, job_id TEXT NOT NULL, role TEXT NOT NULL,
    status TEXT NOT NULL, model TEXT, provider TEXT, usage_json TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE IF NOT EXISTS agent_workflow_events (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);`);
  // A model invocation has no external side effect; interrupted generation is safe to retry.
  run(db, "UPDATE agent_jobs SET status='queued' WHERE status='running'");
  run(
    db,
    "UPDATE agent_model_runs SET status='interrupted',completed_at=? WHERE status='running'",
    now(),
  );
  let closing = false,
    active = null;
  const abortController = new AbortController();
  const router = express.Router();
  const log = (conversationId, kind, detail = {}) => {
    run(
      db,
      'INSERT INTO agent_workflow_events VALUES (?,?,?,?,?)',
      id(),
      conversationId,
      kind,
      JSON.stringify(detail),
      now(),
    );
  };
  const get = (conversationId) => {
    const c = one(db, 'SELECT * FROM agent_conversations WHERE id=?', conversationId);
    assert(c, 'Conversation not found.', 404);
    return c;
  };
  function enqueue(c, purpose, key, state = 'queued') {
    run(
      db,
      'INSERT OR IGNORE INTO agent_jobs (id,conversation_id,purpose,dedupe_key,status,due_at,created_at) VALUES (?,?,?,?,?,?,?)',
      id(),
      c.id,
      purpose,
      key,
      state,
      now(),
      now(),
    );
  }
  function agreementSaved({ provider, sessionId, caseId, agreementId }) {
    assert(config.mode === 'demo', 'Virtual SMS is available only in demo mode.', 403);
    const previous = one(
      db,
      'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    );
    if (previous) return { conversationId: previous.id };
    const stored = one(
      db,
      'SELECT * FROM demo_voice_results WHERE provider=? AND session_id=? AND case_id=? AND agreement_id=?',
      provider,
      sessionId,
      caseId,
      agreementId,
    );
    assert(
      stored && JSON.parse(stored.agreement_json).demo === true,
      'An accepted demo agreement is required.',
    );
    const c = { id: id() },
      ended = one(
        db,
        'SELECT 1 FROM agent_source_ends WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
    run(
      db,
      'INSERT INTO agent_conversations (id,case_id,agreement_id,provider,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      c.id,
      caseId,
      agreementId,
      provider,
      sessionId,
      'active',
      now(),
      now(),
    );
    enqueue(
      c,
      'agreement_followup',
      `agreement:${provider}:${sessionId}`,
      ended ? 'queued' : 'waiting_source_end',
    );
    log(c.id, 'agreement.accepted', { agreementId });
    log(c.id, ended ? 'handoff.ready' : 'handoff.waiting_for_call_end');
    return { conversationId: c.id };
  }
  function sourceEnded(provider, sessionId) {
    if (closing || config.mode !== 'demo') return;
    transaction(db, () => {
      run(db, 'INSERT OR IGNORE INTO agent_source_ends VALUES (?,?,?)', provider, sessionId, now());
      const c = one(
        db,
        'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
      if (
        c &&
        run(
          db,
          "UPDATE agent_jobs SET status='queued' WHERE conversation_id=? AND status='waiting_source_end'",
          c.id,
        ).changes
      )
        log(c.id, 'handoff.ready');
    });
  }
  function stop(c, status, reason) {
    run(
      db,
      'UPDATE agent_conversations SET status=?,version=version+1,updated_at=? WHERE id=?',
      status,
      now(),
      c.id,
    );
    run(
      db,
      "UPDATE agent_jobs SET status='cancelled',error=? WHERE conversation_id=? AND status IN ('waiting_source_end','queued','running','failed')",
      reason,
      c.id,
    );
    log(c.id, `conversation.${status}`, { reason });
  }
  function cancelFollowups(caseId) {
    run(
      db,
      "UPDATE payment_followup_jobs SET status='cancelled',updated_at=? WHERE (case_id=? OR case_id IN (SELECT id FROM cases WHERE suppressed=1)) AND status IN ('draft','blocked_missing_contact','blocked_missing_payment_details')",
      now(),
      caseId,
    );
  }
  function outcomeChanged({ provider, sessionId, args, outcome } = {}) {
    const value = args?.outcome || outcome;
    const c = one(
      db,
      'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    );
    if (c && stoppedOutcomes.has(value))
      stop(c, value === 'opt_out' ? 'opted_out' : 'human_review', value);
  }
  function loadContext(c) {
    const item = one(db, 'SELECT * FROM cases WHERE id=?', c.case_id);
    const stored = one(
      db,
      'SELECT agreement_json FROM demo_voice_results WHERE case_id=? AND agreement_id=?',
      c.case_id,
      c.agreement_id,
    );
    const followup = one(
      db,
      'SELECT * FROM payment_followup_jobs WHERE case_id=? AND agreement_id=?',
      c.case_id,
      c.agreement_id,
    );
    const reviews = all(
      db,
      "SELECT reason FROM tasks WHERE case_id=? AND status='open'",
      c.case_id,
    );
    const portfolio = item
      ? one(db, 'SELECT * FROM portfolio_operations WHERE portfolio_id=?', item.portfolio_id)
      : null;
    const suppressed = [item?.phone, item?.email]
      .filter(Boolean)
      .some((address) => one(db, 'SELECT 1 FROM suppressions WHERE address=?', address));
    const agreement = stored ? JSON.parse(stored.agreement_json) : null;
    let blocked = null;
    if (!item || !agreement || agreement.demo !== true)
      blocked = 'Accepted demo agreement is missing.';
    else if (c.status !== 'active') blocked = `Conversation is ${c.status}.`;
    else if (portfolio?.status === 'paused') blocked = 'Portfolio is paused.';
    else if (item.suppressed || suppressed || stoppedOutcomes.has(item.outcome))
      blocked = 'Contact stopped or awaiting human review.';
    else if (item.review_required && (reviews.length !== 1 || reviews[0].reason !== demoReview))
      blocked = 'Case requires human review.';
    else if (!followup?.payment_details || followup.status === 'cancelled')
      blocked = 'Payment follow-up is missing or cancelled.';
    return {
      blocked,
      snapshot: JSON.stringify({ item, stored, followup, reviews, portfolio }),
      context: {
        caseId: c.case_id,
        name: item?.name,
        language: item?.language || 'en',
        agreement,
        case: { name: item?.name, reference: item?.reference, language: item?.language },
        payment: { details: followup?.payment_details || '' },
        paymentDetails: followup?.payment_details || '',
        channel: 'sms',
        transport: 'virtual',
        destination: `virtual:${c.case_id}`,
        identityConfirmed: true,
        agreementAccepted: true,
      },
    };
  }
  const present = (c) => ({
    ...c,
    caseName: one(db, 'SELECT name FROM cases WHERE id=?', c.case_id)?.name,
    caseReference: one(db, 'SELECT reference FROM cases WHERE id=?', c.case_id)?.reference,
    caseId: c.case_id,
    agreementId: c.agreement_id,
    channel: 'sms',
    transport: 'virtual',
    destination: `virtual:${c.case_id}`,
    role: 'payment_conversation_agent',
    taskStatus: one(
      db,
      'SELECT status FROM agent_jobs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1',
      c.id,
    )?.status,
  });
  function detail(conversationId) {
    const c = get(conversationId);
    return {
      conversation: present(c),
      messages: all(
        db,
        'SELECT * FROM agent_messages WHERE conversation_id=? ORDER BY rowid',
        c.id,
      ),
      tasks: all(db, 'SELECT * FROM agent_jobs WHERE conversation_id=? ORDER BY rowid', c.id),
      runs: all(
        db,
        'SELECT * FROM agent_model_runs WHERE conversation_id=? ORDER BY rowid',
        c.id,
      ).map((r) => ({ ...r, usage: r.usage_json ? JSON.parse(r.usage_json) : null })),
      events: all(
        db,
        'SELECT * FROM agent_workflow_events WHERE conversation_id=? ORDER BY rowid',
        c.id,
      ).map((e) => ({ ...e, detail: JSON.parse(e.detail) })),
    };
  }
  function paymentBlock(context) {
    const a = context.agreement;
    const money = (n) =>
      new Intl.NumberFormat('en-GB', { style: 'currency', currency: a.currency }).format(n / 100);
    return `DEMO — agreed payment details\n${a.label}\nTotal: ${money(a.totalMinor)}\n${a.installments.map((p, i) => `${i + 1}. ${money(p.amountMinor)} due ${p.dueDate}`).join('\n')}\n${context.paymentDetails}\nSimulated SMS. No payment has been received.`;
  }
  async function processJob(job) {
    const c = get(job.conversation_id),
      loaded = loadContext(c);
    if (loaded.blocked) {
      stop(c, 'blocked', loaded.blocked);
      return;
    }
    const runId = id();
    run(db, "UPDATE agent_jobs SET status='running',attempts=attempts+1 WHERE id=?", job.id);
    run(
      db,
      'INSERT INTO agent_model_runs (id,conversation_id,job_id,role,status,created_at) VALUES (?,?,?,?,?,?)',
      runId,
      c.id,
      job.id,
      'payment_conversation_agent',
      'running',
      now(),
    );
    log(c.id, 'agent.started', { jobId: job.id });
    try {
      assert(typeof runAgent === 'function', 'SMS agent model is not configured.', 503);
      const inboundCutoff = job.purpose === 'reply' ? job.dedupe_key.slice(6) : null;
      let history = all(
        db,
        'SELECT * FROM agent_messages WHERE conversation_id=? ORDER BY rowid',
        c.id,
      );
      if (inboundCutoff) {
        const at = history.findIndex((m) => m.id === inboundCutoff);
        if (at >= 0) history = history.filter((m, i) => m.direction === 'outbound' || i <= at);
      }
      const result = await runAgent({
        context: { ...loaded.context, purpose: job.purpose },
        messages: history.map((m) => ({
          role: m.direction === 'inbound' ? 'user' : 'assistant',
          content: m.body,
        })),
        supervisor: false,
        signal: abortController.signal,
      });
      assert(
        result && ['reply', 'human_review', 'paid_reported', 'opt_out'].includes(result.action),
        'Invalid SMS agent action.',
      );
      assert(
        typeof result.text === 'string' && result.text.trim() && result.text.length <= 4000,
        'Invalid SMS agent message.',
      );
      if (closing) return;
      const allowedLinks = new Set(loaded.context.paymentDetails.match(/https?:\/\/[^\s]+/g) || []);
      assert(
        (result.text.match(/https?:\/\/[^\s]+/g) || []).every((url) =>
          allowedLinks.has(url.replace(/[.,;]$/, '')),
        ),
        'Agent supplied an unauthorized payment URL.',
      );
      const allowedAmounts = new Set([
        loaded.context.agreement.totalMinor,
        ...loaded.context.agreement.installments.map((p) => p.amountMinor),
      ]);
      for (const match of result.text.matchAll(/(?:R\$|BRL)\s*([0-9][0-9.,]*)/gi)) {
        const numeric = match[1].replace(/[.,]$/, '');
        const decimal = /[.,]\d{2}$/.test(numeric);
        const minor = Number(numeric.replace(/[^0-9]/g, '')) * (decimal ? 1 : 100);
        assert(allowedAmounts.has(minor), 'Agent supplied an unauthorized payment amount.');
      }
      const dates = new Set(loaded.context.agreement.installments.map((p) => p.dueDate));
      assert(
        (result.text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).every((date) => dates.has(date)),
        'Agent supplied an unauthorized payment date.',
      );
      transaction(db, () => {
        const fresh = get(c.id),
          checked = loadContext(fresh);
        for (const extra of result.runs || [])
          if (extra.role === 'supervisor')
            run(
              db,
              'INSERT INTO agent_model_runs (id,conversation_id,job_id,role,status,model,provider,usage_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
              id(),
              c.id,
              job.id,
              'supervisor',
              'completed',
              extra.model || null,
              extra.provider || null,
              extra.usage ? JSON.stringify(extra.usage) : null,
              now(),
              now(),
            );
        const primaryRun = result.runs?.find((r) => r.role === 'sms') || result;
        run(
          db,
          'UPDATE agent_model_runs SET status=?,model=?,provider=?,usage_json=?,completed_at=? WHERE id=?',
          'completed',
          primaryRun.model || null,
          primaryRun.provider || null,
          primaryRun.usage ? JSON.stringify(primaryRun.usage) : null,
          now(),
          runId,
        );
        if (
          fresh.version !== c.version ||
          checked.blocked ||
          checked.snapshot !== loaded.snapshot
        ) {
          if (fresh.status === 'active')
            stop(
              fresh,
              'blocked',
              checked.blocked || 'Case changed while generating; review before restarting.',
            );
          run(
            db,
            "UPDATE agent_jobs SET status='cancelled',error='Case changed while generating; no message sent.' WHERE id=? AND status!='paused'",
            job.id,
          );
          log(c.id, 'message.cancelled_stale');
          return;
        }
        if (result.action !== 'reply') {
          const outcome = result.action;
          if (outcome !== 'opt_out')
            run(
              db,
              'INSERT OR IGNORE INTO agent_messages VALUES (?,?,?,?,?,?,?)',
              id(),
              c.id,
              'outbound',
              outcome === 'paid_reported'
                ? 'Thank you for letting us know. Your payment report has been recorded for verification; it is not yet confirmed.'
                : 'I have referred this to a team member for review. The agreed payment terms remain unchanged.',
              'simulated_delivered',
              `job:${job.id}`,
              now(),
            );
          recordOutcome(db, c.case_id, { outcome, note: 'Virtual SMS agent outcome' }, 'agent');
          cancelFollowups(c.case_id);
          task(
            db,
            c.case_id,
            outcome === 'paid_reported'
              ? 'Verify reported payment; payment is not confirmed'
              : result.reason || 'SMS agent requested human review',
            now(),
            'high',
          );
          stop(c, outcome === 'opt_out' ? 'opted_out' : 'human_review', outcome);
          run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
          event(db, c.case_id, 'sms_agent_escalation', { outcome, demo: true }, 'agent');
          return;
        }
        const body =
          job.purpose === 'agreement_followup'
            ? `${result.text.trim()}\n\n${paymentBlock(loaded.context)}`
            : result.text.trim();
        run(
          db,
          'INSERT OR IGNORE INTO agent_messages VALUES (?,?,?,?,?,?,?)',
          id(),
          c.id,
          'outbound',
          body,
          'simulated_delivered',
          `job:${job.id}`,
          now(),
        );
        run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
        log(c.id, 'message.simulated_delivered', { jobId: job.id });
      });
    } catch (error) {
      if (closing) return;
      const current = one(db, 'SELECT * FROM agent_jobs WHERE id=?', job.id);
      run(
        db,
        "UPDATE agent_model_runs SET status='failed',error=?,completed_at=? WHERE id=?",
        'Agent generation failed. Check model configuration or retry.',
        now(),
        runId,
      );
      if (current.status === 'running')
        run(
          db,
          'UPDATE agent_jobs SET status=?,error=?,due_at=? WHERE id=?',
          current.attempts >= 3 ? 'failed' : 'queued',
          'Agent generation failed. Check model configuration or retry.',
          new Date(Date.now() + current.attempts * 2000).toISOString(),
          job.id,
        );
      log(c.id, 'agent.failed', { jobId: job.id });
    }
  }
  async function drain() {
    if (config.mode !== 'demo' || config.agentWorkflowsEnabled === false) return;
    for (let count = 0; count < 10 && !closing; count++) {
      const job = one(
        db,
        `SELECT j.* FROM agent_jobs j JOIN agent_conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND j.due_at<=? AND c.status='active' AND NOT EXISTS (SELECT 1 FROM agent_jobs older WHERE older.conversation_id=j.conversation_id AND older.rowid<j.rowid AND older.status IN ('queued','running','waiting_source_end','failed')) ORDER BY j.rowid LIMIT 1`,
        now(),
      );
      if (!job) break;
      await processJob(job);
    }
  }
  function tick() {
    if (closing) return Promise.resolve();
    if (!active)
      active = drain().finally(() => {
        active = null;
      });
    return active;
  }
  router.use((_req, _res, next) => {
    try {
      assert(config.mode === 'demo', 'Virtual SMS is available only in demo mode.', 403);
      next();
    } catch (e) {
      next(e);
    }
  });
  router.use((req, _res, next) => {
    try {
      if (req.method !== 'GET')
        assert(config.agentWorkflowsEnabled !== false, 'Agent workflows are disabled.', 409);
      next();
    } catch (e) {
      next(e);
    }
  });
  router.get('/', (req, res) =>
    res.json({
      conversations: (req.query.caseId
        ? all(
            db,
            'SELECT * FROM agent_conversations WHERE case_id=? ORDER BY created_at DESC',
            String(req.query.caseId),
          )
        : all(db, 'SELECT * FROM agent_conversations ORDER BY created_at DESC LIMIT 100')
      ).map(present),
    }),
  );
  router.get('/:id', (req, res) => res.json(detail(req.params.id)));
  router.post('/:id/messages', (req, res) => {
    const c = get(req.params.id),
      { text, requestId } = req.body || {};
    assert(
      typeof text === 'string' && text.trim() && text.length <= 2000,
      'Enter a message of up to 2,000 characters.',
    );
    assert(
      typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(requestId),
      'A unique requestId is required.',
    );
    const duplicate = one(
      db,
      'SELECT * FROM agent_messages WHERE conversation_id=? AND request_id=?',
      c.id,
      requestId,
    );
    if (duplicate) {
      assert(duplicate.body === text.trim(), 'requestId already used for another message.', 409);
      return res.json(detail(c.id));
    }
    assert(c.status === 'active', 'This conversation is not accepting agent replies.', 409);
    assert(
      one(
        db,
        "SELECT COUNT(*) n FROM agent_jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_source_end')",
        c.id,
      ).n < 30,
      'Wait for pending replies before adding more messages.',
      429,
    );
    transaction(db, () => {
      const messageId = id();
      run(
        db,
        'INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?)',
        messageId,
        c.id,
        'inbound',
        text.trim(),
        'received',
        requestId,
        now(),
      );
      log(c.id, 'message.received', { messageId });
      if (
        /^(stop|unsubscribe|opt[ -]?out|do not contact me|don.t contact me|pare|cancelar)[.!\s]*$/i.test(
          text.trim(),
        )
      ) {
        recordOutcome(
          db,
          c.case_id,
          { outcome: 'opt_out', note: 'Virtual SMS participant requested stop' },
          'agent',
        );
        cancelFollowups(c.case_id);
        stop(c, 'opted_out', 'Participant requested contact stop.');
      } else enqueue(c, 'reply', `reply:${messageId}`);
    });
    res.status(202).json(detail(c.id));
  });
  router.post('/:id/pause', (req, res) => {
    const c = get(req.params.id);
    assert(c.status === 'active', 'Only an active conversation can pause.', 409);
    transaction(db, () => {
      run(
        db,
        "UPDATE agent_conversations SET status='paused',version=version+1,updated_at=? WHERE id=?",
        now(),
        c.id,
      );
      run(
        db,
        "UPDATE agent_jobs SET status='paused' WHERE conversation_id=? AND status IN ('queued','running','waiting_source_end')",
        c.id,
      );
      log(c.id, 'conversation.paused', { reason: 'Human takeover' });
    });
    res.json(detail(req.params.id));
  });
  router.post('/:id/resume', (req, res) => {
    const c = get(req.params.id);
    assert(c.status === 'paused', 'Only an operator-paused conversation can resume.', 409);
    assert(
      !one(db, "SELECT 1 FROM agent_model_runs WHERE conversation_id=? AND status='running'", c.id),
      'Wait for the interrupted generation to finish before resuming.',
      409,
    );
    const checked = loadContext({ ...c, status: 'active' });
    assert(!checked.blocked, checked.blocked || 'Conversation cannot resume.', 409);
    run(
      db,
      "UPDATE agent_conversations SET status='active',version=version+1,updated_at=? WHERE id=?",
      now(),
      c.id,
    );
    const ended = one(
      db,
      'SELECT 1 FROM agent_source_ends WHERE provider=? AND session_id=?',
      c.provider,
      c.session_id,
    );
    run(
      db,
      "UPDATE agent_jobs SET status=CASE WHEN purpose='agreement_followup' AND ?=0 THEN 'waiting_source_end' ELSE 'queued' END,due_at=? WHERE conversation_id=? AND status='paused'",
      ended ? 1 : 0,
      now(),
      c.id,
    );
    log(c.id, 'conversation.resumed');
    res.json(detail(c.id));
  });
  router.post('/:id/retry', (req, res) => {
    const c = get(req.params.id);
    assert(!loadContext(c).blocked, 'Conversation is not eligible for retry.', 409);
    run(
      db,
      "UPDATE agent_jobs SET status='queued',attempts=0,due_at=? WHERE conversation_id=? AND status='failed'",
      now(),
      c.id,
    );
    res.json(detail(c.id));
  });
  function summary() {
    return {
      queued: one(
        db,
        "SELECT COUNT(*) n FROM agent_jobs WHERE status IN ('queued','waiting_source_end')",
      ).n,
      running: one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='running'").n,
      failed: one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='failed'").n,
      completed: one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='completed'").n,
      lastRuns: all(db, 'SELECT * FROM agent_model_runs ORDER BY rowid DESC LIMIT 20'),
    };
  }
  function agentStats() {
    const primary = summary();
    return {
      payment_conversation_agent: {
        ...primary,
        lastRuns: primary.lastRuns.filter((r) => r.role === 'payment_conversation_agent'),
      },
      supervisor: {
        queued: 0,
        running: 0,
        failed: one(
          db,
          "SELECT COUNT(*) n FROM agent_model_runs WHERE role='supervisor' AND status='failed'",
        ).n,
        completed: one(
          db,
          "SELECT COUNT(*) n FROM agent_model_runs WHERE role='supervisor' AND status='completed'",
        ).n,
        lastRuns: all(
          db,
          "SELECT * FROM agent_model_runs WHERE role='supervisor' ORDER BY rowid DESC LIMIT 20",
        ),
      },
    };
  }
  return {
    agentStats,
    summary,
    router,
    agreementSaved,
    sourceEnded,
    outcomeChanged,
    tick,
    detail,
    async closeAll() {
      closing = true;
      abortController.abort();
      if (active) await active;
    },
  };
}
