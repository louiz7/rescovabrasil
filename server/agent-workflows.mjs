import express from 'express';
import { createHash } from 'node:crypto';
import { datedDemoPaymentOffers } from './demo-payment.mjs';
import { createDocumentLibrary } from './documents.mjs';
import { id, now, one, all, run, transaction, event, task } from './db.mjs';
import { assert } from './domain.mjs';
import { recordOutcome } from './service.mjs';

const resolutionStates = new Set(['awaiting_information', 'awaiting_specialist', 'blocked_policy']);
const demoReview = 'Review demo payment agreement and prepare payment follow-up';
const stoppedOutcomes = new Set([
  'opt_out',
  'invalid_contact',
  'disputed',
  'human_review',
  'paid_reported',
]);
export function createAgentWorkflows(db, config, { runAgent } = {}) {
  const library = createDocumentLibrary(db, config);
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
  db.exec(`CREATE TABLE IF NOT EXISTS agent_resolutions (
    conversation_id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT NOT NULL,
    next_action TEXT NOT NULL, context_json TEXT NOT NULL, fingerprint TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_escalations (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
      trigger TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, next_action TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_message_documents (
    message_id TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(message_id,document_id));`);
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
  function resolution(c) {
    const r = one(db, 'SELECT * FROM agent_resolutions WHERE conversation_id=?', c.id);
    return r
      ? {
          status: r.status,
          reason: r.reason,
          nextAction: r.next_action,
          owner: 'supervisor',
          updatedAt: r.updated_at,
        }
      : null;
  }
  function trackEscalation(c, trigger, reason, key) {
    const escalationId = id();
    run(
      db,
      'INSERT OR IGNORE INTO agent_escalations VALUES (?,?,?,?,?,?,?,?,?)',
      escalationId,
      key,
      c.id,
      trigger,
      reason.slice(0, 1000),
      'queued',
      'Rafael will inspect the case.',
      now(),
      now(),
    );
    return one(db, 'SELECT id FROM agent_escalations WHERE dedupe_key=?', key).id;
  }
  function saveResolution(c, status, reason, nextAction, context = {}, fingerprint = null) {
    run(
      db,
      'INSERT INTO agent_resolutions VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,next_action=excluded.next_action,context_json=excluded.context_json,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at',
      c.id,
      status,
      reason.slice(0, 1000),
      nextAction.slice(0, 1000),
      JSON.stringify(context),
      fingerprint,
      now(),
    );
    const escalationId = context.escalationId;
    if (escalationId)
      run(
        db,
        'UPDATE agent_escalations SET status=?,next_action=?,updated_at=? WHERE id=? AND conversation_id=?',
        status,
        nextAction.slice(0, 1000),
        now(),
        escalationId,
        c.id,
      );
    log(c.id, 'supervisor.' + status, { reason, nextAction, owner: 'supervisor', escalationId });
  }
  function referSupervisor(c, job, reason, extra = {}) {
    const trigger = extra.missingDocument
      ? 'missing_document'
      : extra.paymentReported
        ? 'payment_report'
        : 'marina_uncertainty';
    const context = {
      reason,
      ...extra,
      escalationId: extra.escalationId || trackEscalation(c, trigger, reason, `job:${job.id}`),
    };
    saveResolution(
      c,
      'queued',
      reason,
      'Rafael will inspect the current case and decide the next action.',
      context,
    );
    enqueue(c, 'supervisor_review', `supervisor:${job.id}`);
    run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
  }
  function waitForResolution(c, job, status, reason, text, context = {}) {
    // Waiting work has a durable owner and trigger; no human task is created.
    run(
      db,
      'UPDATE agent_conversations SET status=?,version=version+1,updated_at=? WHERE id=?',
      status,
      now(),
      c.id,
    );
    run(
      db,
      "UPDATE agent_jobs SET status='cancelled',error='Superseded by case resolution' WHERE conversation_id=? AND status IN ('queued','waiting_source_end')",
      c.id,
    );
    run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
    const nextAction =
      status === 'awaiting_information'
        ? 'Await missing case information or documents; recheck when evidence changes or the participant replies.'
        : status === 'awaiting_specialist'
          ? 'Await the required specialist capability or verified external result; recheck when case context changes.'
          : 'Keep the restriction in place until policy or authorized capabilities change; recheck explicitly.';
    saveResolution(
      c,
      status,
      reason,
      nextAction,
      context,
      loadContext({ ...c, status: 'active' }).snapshot,
    );
    if (text)
      run(
        db,
        'INSERT OR IGNORE INTO agent_messages VALUES (?,?,?,?,?,?,?)',
        id(),
        c.id,
        'outbound',
        text,
        'simulated_delivered',
        `job:${job.id}`,
        now(),
      );
    event(
      db,
      c.case_id,
      'agent_resolution_waiting',
      { status, reason, owner: 'supervisor', nextAction },
      'agent',
    );
  }
  function wakeResolution(c, key) {
    const previous = one(db, 'SELECT * FROM agent_resolutions WHERE conversation_id=?', c.id);
    if (
      previous?.fingerprint &&
      previous.fingerprint !== loadContext({ ...c, status: 'active' }).snapshot
    ) {
      const context = JSON.parse(previous.context_json);
      delete context.missingDocument;
      delete context.attemptedDocumentKinds;
      run(
        db,
        'UPDATE agent_resolutions SET context_json=? WHERE conversation_id=?',
        JSON.stringify(context),
        c.id,
      );
    }

    run(
      db,
      "UPDATE agent_conversations SET status='active',version=version+1,updated_at=? WHERE id=?",
      now(),
      c.id,
    );
    run(
      db,
      "UPDATE agent_resolutions SET status='queued',updated_at=? WHERE conversation_id=?",
      now(),
      c.id,
    );
    run(
      db,
      "UPDATE agent_escalations SET status='queued',updated_at=? WHERE conversation_id=? AND status NOT IN ('resolved','cancelled')",
      now(),
      c.id,
    );
    enqueue(c, 'supervisor_review', key);
    log(c.id, 'supervisor.recheck_requested', { trigger: key });
  }
  function agreementSaved({ provider, sessionId, caseId, agreementId }) {
    assert(config.mode === 'demo', 'Virtual SMS is available only in demo mode.', 403);
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
    const previous = one(
      db,
      'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    );
    if (previous) {
      assert(previous.case_id === caseId, 'Source case mismatch.', 409);
      if (previous.agreement_id === agreementId) return { conversationId: previous.id };
      assert(!previous.agreement_id, 'Conversation already has another agreement.', 409);
      run(
        db,
        'UPDATE agent_conversations SET agreement_id=?,version=version+1,updated_at=? WHERE id=?',
        agreementId,
        now(),
        previous.id,
      );
      log(previous.id, 'agreement.accepted', { agreementId });
      const ended = one(
        db,
        'SELECT 1 FROM agent_source_ends WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
      enqueue(
        previous,
        'agreement_followup',
        `agreement:${provider}:${sessionId}`,
        ended ? 'queued' : 'waiting_source_end',
      );
      return { conversationId: previous.id };
    }
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
  function documentRequested({ provider, sessionId, caseId, kind, requestId }) {
    assert(
      config.mode === 'demo' && config.agentWorkflowsEnabled !== false,
      'Demo document workflows are disabled.',
      403,
    );
    return transaction(db, () => {
      let c = one(
        db,
        'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
      if (!c) {
        assert(
          one(
            db,
            'SELECT 1 FROM demo_voice_cases WHERE provider=? AND session_id=? AND case_id=?',
            provider,
            sessionId,
            caseId,
          ),
          'Demo source not found.',
          404,
        );
        run(
          db,
          'INSERT INTO agent_conversations (id,case_id,agreement_id,provider,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          id(),
          caseId,
          '',
          provider,
          sessionId,
          'active',
          now(),
          now(),
        );
        c = one(
          db,
          'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
          provider,
          sessionId,
        );
      }
      assert(
        c.case_id === caseId && c.status === 'active',
        'Conversation cannot accept this document request.',
        409,
      );
      const request = library.request({ caseId, kind, requestId });
      const ended = one(
        db,
        'SELECT 1 FROM agent_source_ends WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
      enqueue(
        c,
        'document_followup',
        `document:${request.id}`,
        ended ? 'queued' : 'waiting_source_end',
      );
      log(c.id, 'document.requested', { requestId: request.id, kind, role: 'document_librarian' });
      return {
        caseId,
        conversationId: c.id,
        documentRequestId: request.id,
        transport: 'virtual_sms',
        startsAfter: 'call_end',
      };
    });
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
      "UPDATE document_requests SET status='cancelled',error=? WHERE case_id=? AND status IN ('pending','ready') AND NOT EXISTS (SELECT 1 FROM agent_message_documents a JOIN agent_messages m ON m.id=a.message_id WHERE a.document_id=document_requests.document_id AND m.conversation_id=?)",
      reason,
      c.case_id,
      c.id,
    );
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
    run(
      db,
      "UPDATE agent_escalations SET status='cancelled',next_action=?,updated_at=? WHERE conversation_id=? AND status NOT IN ('resolved','cancelled')",
      reason,
      now(),
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
  function outcomeChanged({ provider, sessionId, caseId, args, outcome } = {}) {
    const value = args?.outcome || outcome;
    if (!stoppedOutcomes.has(value)) return;
    const sourceKey = `source-resolution:${provider}:${sessionId}:${value}:${createHash('sha256')
      .update(JSON.stringify(args || { outcome: value }))
      .digest('hex')}`;
    if (one(db, 'SELECT 1 FROM agent_jobs WHERE dedupe_key=?', sourceKey)) return;
    let c = one(
      db,
      'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    );
    if (
      !c &&
      caseId &&
      one(
        db,
        'SELECT 1 FROM demo_voice_cases WHERE case_id=? AND provider=? AND session_id=?',
        caseId,
        provider,
        sessionId,
      )
    ) {
      run(
        db,
        'INSERT INTO agent_conversations (id,case_id,agreement_id,provider,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        id(),
        caseId,
        '',
        provider,
        sessionId,
        'active',
        now(),
        now(),
      );
      c = one(
        db,
        'SELECT * FROM agent_conversations WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
    }
    if (!c) return;
    if (value === 'opt_out' || value === 'invalid_contact') {
      stop(c, 'opted_out', value);
      return;
    }
    transaction(db, () => {
      run(
        db,
        "UPDATE agent_jobs SET status='cancelled',error='Superseded by source outcome' WHERE conversation_id=? AND status IN ('queued','waiting_source_end','running')",
        c.id,
      );
      run(
        db,
        "UPDATE agent_conversations SET status='active',version=version+1,updated_at=? WHERE id=?",
        now(),
        c.id,
      );
      saveResolution(c, 'queued', args?.note || value, 'Rafael will inspect the source outcome.', {
        reason: args?.note || value,
        outcome: value,
        escalationId: trackEscalation(c, 'voice_' + value, args?.note || value, sourceKey),
      });
      const ended = one(
        db,
        'SELECT 1 FROM agent_source_ends WHERE provider=? AND session_id=?',
        provider,
        sessionId,
      );
      enqueue(c, 'supervisor_review', sourceKey, ended ? 'queued' : 'waiting_source_end');
    });
  }
  function loadContext(c, supervisor = false) {
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
    const documents = library.list(c.case_id).documents;
    const source = one(
      db,
      'SELECT 1 FROM demo_voice_cases WHERE case_id=? AND provider=? AND session_id=?',
      c.case_id,
      c.provider,
      c.session_id,
    );
    if (!item || (c.agreement_id ? !agreement || agreement.demo !== true : !source))
      blocked = 'Demo case or agreement is missing.';
    else if (c.status !== 'active') blocked = `Conversation is ${c.status}.`;
    else if (portfolio?.status === 'paused') blocked = 'Portfolio is paused.';
    else if (item.suppressed || suppressed || stoppedOutcomes.has(item.outcome))
      blocked = 'Contact stopped or awaiting human review.';
    else if (item.review_required && (reviews.length !== 1 || reviews[0].reason !== demoReview))
      blocked = 'Case requires human review.';
    else if (agreement && (!followup?.payment_details || followup.status === 'cancelled'))
      blocked = 'Payment follow-up is missing or cancelled.';
    const caseRestriction = blocked;
    if (
      supervisor &&
      item &&
      !item.suppressed &&
      !suppressed &&
      c.status === 'active' &&
      portfolio?.status !== 'paused' &&
      ['human_review', 'disputed', 'paid_reported'].includes(item.outcome)
    )
      blocked = null;
    const authorizedOffers =
      !agreement &&
      source &&
      item?.name === 'Ana Silva' &&
      item?.amount_minor === 125000 &&
      item?.currency === 'BRL'
        ? datedDemoPaymentOffers()
        : [];
    return {
      blocked,
      snapshot: JSON.stringify({ item, stored, followup, reviews, portfolio, documents }),
      context: {
        caseId: c.case_id,
        caseRestriction,
        outcome: item?.outcome,
        name: item?.name,
        language: item?.language || 'en',
        agreement,
        authorizedOffers,
        paymentAgreementCanBeSavedInChat: false,
        case: { name: item?.name, reference: item?.reference, language: item?.language },
        payment: { details: followup?.payment_details || '' },
        paymentDetails: followup?.payment_details || '',
        channel: 'sms',
        transport: 'virtual',
        destination: `virtual:${c.case_id}`,
        identityConfirmed: true,
        agreementAccepted: !!agreement,
        documents: documents.map(({ id, title, kind, version, source }) => ({
          id,
          title,
          kind,
          version,
          source,
        })),
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
    resolution: resolution(c),
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
      ).map((m) => ({
        ...m,
        documents: all(
          db,
          'SELECT d.id,d.title,d.kind,d.version FROM agent_message_documents a JOIN case_documents d ON d.id=a.document_id WHERE a.message_id=? AND d.case_id=?',
          m.id,
          c.case_id,
        ).map((d) => ({ ...d, url: `/api/cases/${c.case_id}/documents/${d.id}/content` })),
      })),
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
      loaded = loadContext(c, job.purpose === 'supervisor_review');
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
      job.purpose === 'supervisor_review' ? 'supervisor' : 'payment_conversation_agent',
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
      let documentResult = null;
      if (job.purpose === 'document_followup') {
        const requestId = job.dedupe_key.slice(9);
        assert(
          one(db, 'SELECT 1 FROM document_requests WHERE id=? AND case_id=?', requestId, c.case_id),
          'Document request belongs to another case.',
          403,
        );
        documentResult = library.resolve(requestId);
        run(
          db,
          'INSERT INTO agent_model_runs (id,conversation_id,job_id,role,status,model,provider,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?)',
          id(),
          c.id,
          job.id,
          'document_librarian',
          documentResult.document ? 'completed' : 'failed',
          null,
          'local',
          now(),
          now(),
        );
        log(c.id, 'document.retrieved', {
          requestId,
          documentId: documentResult.document?.id || null,
          status: documentResult.request.status,
          role: 'document_librarian',
        });
      }
      const deliveredDocuments = all(
        db,
        'SELECT DISTINCT d.id,d.title,d.kind,d.version,d.content FROM case_documents d JOIN agent_message_documents a ON a.document_id=d.id JOIN agent_messages m ON m.id=a.message_id WHERE m.conversation_id=? AND d.case_id=?',
        c.id,
        c.case_id,
      ).map((d) => ({
        ...d,
        content: d.content.slice(0, 6000),
        excerptTruncated: d.content.length > 6000,
        totalCharacters: d.content.length,
      }));
      const savedResolution = one(
        db,
        'SELECT context_json FROM agent_resolutions WHERE conversation_id=?',
        c.id,
      );
      const resolutionContext = savedResolution ? JSON.parse(savedResolution.context_json) : {};
      let result =
        documentResult && !documentResult.document
          ? {
              action: 'escalate_supervisor',
              text: 'The requested document needs review.',
              reason: 'Requested document is missing or ambiguous.',
            }
          : await runAgent({
              context: {
                ...loaded.context,
                purpose: job.purpose,
                supervisorResolution: resolutionContext,
                supervisorGuidance:
                  job.purpose === 'marina_guided_reply' ? resolutionContext.guidance : null,
                availableCapabilities: [
                  'read_case_context',
                  'present_authorized_offers',
                  'retrieve_loan_agreement',
                  'retrieve_account_statement',
                  'virtual_sms',
                ],
                unavailableCapabilities: [
                  'verify_real_payment',
                  'save_payment_agreement_in_text',
                  'change_approved_terms',
                  'human_transfer',
                ],
                deliveredDocuments,
                documentResult: documentResult?.document
                  ? {
                      id: documentResult.document.id,
                      title: documentResult.document.title,
                      kind: documentResult.document.kind,
                      version: documentResult.document.version,
                      source: documentResult.document.source,
                      excerptTruncated: documentResult.document.content.length > 6000,
                      totalCharacters: documentResult.document.content.length,
                      content: documentResult.document.content.slice(0, 6000),
                    }
                  : null,
              },
              messages: history.map((m) => ({
                role: m.direction === 'inbound' ? 'user' : 'assistant',
                content: m.body,
              })),
              supervisor: job.purpose === 'supervisor_review',
              deferSupervisor: true,
              signal: abortController.signal,
            });
      assert(
        result &&
          [
            'reply',
            'escalate_supervisor',
            'awaiting_information',
            'awaiting_specialist',
            'blocked_policy',
            'human_review',
            'paid_reported',
            'opt_out',
            'request_loan_agreement',
            'request_account_statement',
          ].includes(result.action),
        'Invalid SMS agent action.',
      );
      assert(
        typeof result.text === 'string' &&
          (result.text.trim() ||
            [
              'escalate_supervisor',
              'human_review',
              'awaiting_information',
              'awaiting_specialist',
              'blocked_policy',
              'request_loan_agreement',
              'request_account_statement',
            ].includes(result.action)) &&
          result.text.length <= 4000,
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
        ...loaded.context.authorizedOffers.flatMap((o) => [
          o.totalMinor,
          ...o.installments.map((p) => p.amountMinor),
        ]),
        ...(loaded.context.agreement
          ? [
              loaded.context.agreement.totalMinor,
              ...loaded.context.agreement.installments.map((p) => p.amountMinor),
            ]
          : []),
      ]);
      const evidence = [
        ...deliveredDocuments,
        ...(documentResult?.document ? [documentResult.document] : []),
      ]
        .map((d) => d.content)
        .join('\n');
      for (const m of evidence.matchAll(/(?:R\$|BRL)\s*([0-9][0-9.,]*)/gi)) {
        const n = m[1].replace(/[.,]$/, '');
        allowedAmounts.add(Number(n.replace(/[^0-9]/g, '')) * (/[.,]\d{2}$/.test(n) ? 1 : 100));
      }
      for (const match of result.text.matchAll(/(?:R\$|BRL)\s*([0-9][0-9.,]*)/gi)) {
        const numeric = match[1].replace(/[.,]$/, '');
        const decimal = /[.,]\d{2}$/.test(numeric);
        const minor = Number(numeric.replace(/[^0-9]/g, '')) * (decimal ? 1 : 100);
        assert(allowedAmounts.has(minor), 'Agent supplied an unauthorized payment amount.');
      }
      const dates = new Set([
        ...(loaded.context.agreement?.installments || []).map((p) => p.dueDate),
        ...loaded.context.authorizedOffers.flatMap((o) => o.installments.map((p) => p.dueDate)),
      ]);
      for (const date of evidence.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []) dates.add(date);
      assert(
        (result.text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).every((date) => dates.has(date)),
        'Agent supplied an unauthorized payment date.',
      );
      transaction(db, () => {
        const fresh = get(c.id),
          checked = loadContext(fresh, job.purpose === 'supervisor_review');
        for (const extra of result.runs || [])
          if (extra.role === 'supervisor' && job.purpose !== 'supervisor_review')
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
        const primaryRun =
          result.runs?.find(
            (r) => r.role === (job.purpose === 'supervisor_review' ? 'supervisor' : 'sms'),
          ) || result;
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
        const supervisorJob = job.purpose === 'supervisor_review';
        if (supervisorJob && loaded.context.caseRestriction) {
          const status =
            loaded.context.outcome === 'paid_reported' ? 'awaiting_specialist' : 'blocked_policy';
          waitForResolution(c, job, status, result.reason || loaded.context.caseRestriction, null, {
            ...resolutionContext,
            restriction: loaded.context.caseRestriction,
          });
          return;
        }
        if (
          ['human_review', 'escalate_supervisor'].includes(result.action) ||
          (!supervisorJob && resolutionStates.has(result.action))
        ) {
          if (supervisorJob || job.purpose === 'marina_guided_reply') {
            waitForResolution(
              c,
              job,
              'awaiting_specialist',
              result.reason || 'The available capabilities cannot resolve this request.',
              'This request is still unresolved. I cannot complete it with the capabilities currently available.',
              resolutionContext,
            );
          } else {
            referSupervisor(
              c,
              job,
              result.reason || 'The conversation needs specialist guidance.',
              documentResult && !documentResult.document
                ? { ...resolutionContext, missingDocument: documentResult.request }
                : {},
            );
          }
          return;
        }
        if (supervisorJob && resolutionStates.has(result.action)) {
          waitForResolution(
            c,
            job,
            result.action,
            result.reason || 'Additional information or authorization is required.',
            result.text,
            resolutionContext,
          );
          return;
        }
        if (supervisorJob && result.action === 'reply') {
          saveResolution(
            c,
            'guidance_ready',
            result.reason || 'Rafael supplied guidance.',
            'Marina will continue the conversation.',
            { ...resolutionContext, guidance: result.text },
          );
          enqueue(c, 'marina_guided_reply', `guided:${job.id}`);
          run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
          return;
        }
        if (result.action.startsWith('request_')) {
          assert(
            ['reply', 'supervisor_review', 'marina_guided_reply'].includes(job.purpose),
            'Document requests require an inbound turn or supervisor task.',
          );
          const kind = result.action.slice(8);
          const attempted = resolutionContext.attemptedDocumentKinds || [];
          if (
            supervisorJob &&
            (attempted.includes(kind) ||
              (resolutionContext.missingDocument?.kind === kind &&
                ['missing', 'ambiguous'].includes(resolutionContext.missingDocument.status)))
          ) {
            waitForResolution(
              c,
              job,
              'awaiting_information',
              'The requested evidence is missing or ambiguous; repeated retrieval cannot resolve it.',
              'The document information needed to resolve this is not available yet.',
              resolutionContext,
            );
            return;
          }
          const request = library.request({
            caseId: c.case_id,
            kind,
            requestId: `message-${job.id}`,
          });
          enqueue(c, 'document_followup', `document:${request.id}`);
          run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
          log(c.id, 'document.requested', { requestId: request.id, kind: result.action.slice(8) });
          if (supervisorJob)
            saveResolution(
              c,
              'awaiting_specialist',
              result.reason || 'Document retrieval requested.',
              'Helena will retrieve the requested document.',
              { ...resolutionContext, attemptedDocumentKinds: [...attempted, kind] },
            );
          return;
        }
        if (result.action !== 'reply') {
          if (result.action === 'opt_out') {
            recordOutcome(
              db,
              c.case_id,
              { outcome: 'opt_out', note: 'Virtual SMS contact stop' },
              'agent',
            );
            cancelFollowups(c.case_id);
            stop(c, 'opted_out', 'Participant requested contact stop.');
            run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
          } else if (result.action === 'paid_reported') {
            // A report is not verification. Hold collection without manufacturing a human task.
            run(
              db,
              "UPDATE cases SET outcome='paid_reported',status='review' WHERE id=?",
              c.case_id,
            );
            cancelFollowups(c.case_id);
            event(
              db,
              c.case_id,
              'payment_reported',
              { verified: false, owner: 'supervisor' },
              'agent',
            );
            run(
              db,
              'INSERT OR IGNORE INTO agent_messages VALUES (?,?,?,?,?,?,?)',
              id(),
              c.id,
              'outbound',
              'Your payment report is recorded, but payment is not yet verified. Further collection is on hold pending verification.',
              'simulated_delivered',
              `job:${job.id}`,
              now(),
            );
            referSupervisor(
              c,
              job,
              'Payment verification requires a verified lender/payment result.',
              { paymentReported: true },
            );
          }
          return;
        }
        const body =
          job.purpose === 'agreement_followup'
            ? `${result.text.trim()}\n\n${paymentBlock(loaded.context)}`
            : result.text.trim();
        const messageId = id();
        run(
          db,
          'INSERT OR IGNORE INTO agent_messages VALUES (?,?,?,?,?,?,?)',
          messageId,
          c.id,
          'outbound',
          body,
          'simulated_delivered',
          `job:${job.id}`,
          now(),
        );
        run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
        if (documentResult?.document) {
          run(
            db,
            'INSERT OR IGNORE INTO agent_message_documents VALUES (?,?)',
            messageId,
            documentResult.document.id,
          );
          event(
            db,
            c.case_id,
            'document.simulated_delivered',
            {
              documentId: documentResult.document.id,
              requestId: documentResult.request.id,
              messageId,
              demo: true,
            },
            'agent',
          );
        }
        if (['marina_guided_reply', 'document_followup'].includes(job.purpose) && savedResolution)
          saveResolution(
            c,
            'resolved',
            'The requested information was supplied.',
            'Continue the conversation normally.',
            { escalationId: resolutionContext.escalationId },
          );
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
      if (job.purpose === 'supervisor_review' && current.attempts >= 3)
        run(
          db,
          "UPDATE agent_escalations SET status='failed',next_action='Supervisor execution failed; check configuration and retry.',updated_at=? WHERE conversation_id=? AND status NOT IN ('resolved','cancelled')",
          now(),
          c.id,
        );
      log(c.id, 'agent.failed', { jobId: job.id });
    }
  }
  async function drain() {
    if (config.mode !== 'demo' || config.agentWorkflowsEnabled === false) return;
    for (const waiting of all(
      db,
      "SELECT c.*,r.fingerprint FROM agent_conversations c JOIN agent_resolutions r ON r.conversation_id=c.id WHERE c.status IN ('awaiting_information','awaiting_specialist')",
    )) {
      const checked = loadContext({ ...waiting, status: 'active' });
      if (!checked.blocked && checked.snapshot !== waiting.fingerprint)
        wakeResolution(waiting, `context:${waiting.id}:${id()}`);
    }
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
  router.get('/escalations', (req, res) => {
    const rows = all(
      db,
      `SELECT e.*,c.case_id,k.name AS case_name,k.reference AS case_reference
      FROM agent_escalations e JOIN agent_conversations c ON c.id=e.conversation_id JOIN cases k ON k.id=c.case_id
      ORDER BY e.created_at DESC,e.rowid DESC LIMIT 200 OFFSET ?`,
      Math.max(0, Math.min(Number(req.query.offset) || 0, 100000)),
    );
    const counts = one(
      db,
      "SELECT COUNT(*) total,SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved,SUM(CASE WHEN status NOT IN ('resolved','cancelled') THEN 1 ELSE 0 END) open FROM agent_escalations",
    );
    res.json({
      escalations: rows.map((e) => ({
        id: e.id,
        conversationId: e.conversation_id,
        caseId: e.case_id,
        caseName: e.case_name,
        caseReference: e.case_reference,
        trigger: e.trigger,
        reason: e.reason,
        status: e.status,
        nextAction: e.next_action,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
      summary: { total: counts.total, open: counts.open || 0, resolved: counts.resolved || 0 },
    });
  });
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
    assert(
      c.status === 'active' || resolutionStates.has(c.status),
      'This conversation is not accepting agent replies.',
      409,
    );
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
      } else if (resolutionStates.has(c.status)) wakeResolution(c, `clarification:${messageId}`);
      else enqueue(c, 'reply', `reply:${messageId}`);
    });
    res.status(202).json(detail(c.id));
  });
  router.post('/:id/recheck', (req, res) => {
    const c = get(req.params.id);
    assert(resolutionStates.has(c.status), 'Only waiting resolutions can be rechecked.', 409);
    const checked = loadContext({ ...c, status: 'active' }, true);
    assert(!checked.blocked, checked.blocked || 'Case remains restricted.', 409);
    transaction(db, () => wakeResolution(c, `recheck:${c.id}:${id()}`));
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
      "UPDATE agent_jobs SET status=CASE WHEN purpose IN ('agreement_followup','document_followup','supervisor_review') AND ?=0 THEN 'waiting_source_end' ELSE 'queued' END,due_at=? WHERE conversation_id=? AND status='paused'",
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
    function roleStats(role, supervisor) {
      const purpose = supervisor ? "purpose='supervisor_review'" : "purpose!='supervisor_review'";
      const count = (statuses) =>
        one(db, `SELECT COUNT(*) n FROM agent_jobs WHERE ${purpose} AND status IN (${statuses})`).n;
      return {
        queued: count("'queued','waiting_source_end'"),
        running: count("'running'"),
        failed: count("'failed'"),
        completed: count("'completed'"),
        lastRuns: all(
          db,
          'SELECT * FROM agent_model_runs WHERE role=? ORDER BY rowid DESC LIMIT 20',
          role,
        ),
      };
    }
    return {
      document_librarian: library.stats(),
      payment_conversation_agent: roleStats('payment_conversation_agent', false),
      supervisor: {
        ...roleStats('supervisor', true),
        failed: one(
          db,
          "SELECT COUNT(*) n FROM agent_model_runs WHERE role='supervisor' AND status='failed'",
        ).n,
        completed: one(
          db,
          "SELECT COUNT(*) n FROM agent_model_runs WHERE role='supervisor' AND status='completed'",
        ).n,
      },
    };
  }

  return {
    agentStats,
    documentRequested,
    library,
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
