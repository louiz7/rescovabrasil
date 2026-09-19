import { createPaymentService, getPaymentState, recordPaymentReport } from './payments.mjs';
import {
  ensureDocumentTickets,
  createDocumentTicket,
  reconcileDocumentTickets,
} from './document-tickets.mjs';
import { createWorkerLeases, boundedMap } from './worker-leases.mjs';
import { lookupCaseInformation } from './case-context.mjs';
import express from 'express';
import { createHash } from 'node:crypto';
import { persistDemoAgreement } from './demo-platform.mjs';
import { datedDemoPaymentOffers } from './demo-payment.mjs';
import { createDocumentLibrary } from './documents.mjs';
import { createDecisionRuns } from './decision-runs.mjs';
import { id, now, one, all, run, transaction, event, task } from './db.mjs';
import { assert } from './domain.mjs';
import { recordOutcome } from './service.mjs';
import { mandateAuditFields, operatingMandate } from './operating-mandate.mjs';

const resolutionStates = new Set(['awaiting_information', 'awaiting_specialist', 'blocked_policy']);
const demoReview = 'Review demo payment agreement and prepare payment follow-up';
const stoppedOutcomes = new Set([
  'opt_out',
  'invalid_contact',
  'disputed',
  'human_review',
  'paid_reported',
]);
export function createAgentWorkflows(
  db,
  config,
  { runAgent, decisionEngine, evaluateDecision, evaluateEscalationDecision } = {},
) {
  const library = createDocumentLibrary(db, config);
  const payments = createPaymentService(db, config);
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
  if (
    !all(db, 'PRAGMA table_info(agent_conversations)').some(
      (column) => column.name === 'delivery_channel',
    )
  )
    db.exec(
      "ALTER TABLE agent_conversations ADD COLUMN delivery_channel TEXT NOT NULL DEFAULT 'virtual_sms'",
    );
  for (const [table, column] of [
    ['agent_messages', 'channel'],
    ['agent_jobs', 'delivery_channel'],
  ]) {
    if (!all(db, `PRAGMA table_info(${table})`).some((row) => row.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'virtual_sms'`);
      if (table === 'agent_jobs')
        db.exec(
          "UPDATE agent_jobs SET delivery_channel=COALESCE((SELECT delivery_channel FROM agent_conversations WHERE id=conversation_id),'virtual_sms')",
        );
      if (
        table === 'agent_messages' &&
        one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_deliveries'")
      )
        db.exec(
          "UPDATE agent_messages SET channel='email' WHERE id IN (SELECT message_id FROM email_deliveries) OR substr(request_id,1,6)='gmail_'",
        );
    }
  }
  if (!all(db, 'PRAGMA table_info(agent_jobs)').some((row) => row.name === 'resolved_by'))
    db.exec('ALTER TABLE agent_jobs ADD COLUMN resolved_by TEXT');
  const modelRunColumns = new Set(
    all(db, 'PRAGMA table_info(agent_model_runs)').map((column) => column.name),
  );
  for (const column of [
    'goal_id',
    'organization_mandate_version',
    'portfolio_mandate_version',
    'role_charter_version',
    'policy_version',
  ])
    if (!modelRunColumns.has(column))
      db.exec(`ALTER TABLE agent_model_runs ADD COLUMN ${column} TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_presented_offers (
    conversation_id TEXT NOT NULL, offer_id TEXT NOT NULL, offer_json TEXT NOT NULL,
    message_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(conversation_id,offer_id));`);
  ensureDocumentTickets(db);
  const decisions = createDecisionRuns(db, config, {
    engine: decisionEngine,
    evaluateDecision,
    evaluateEscalationDecision,
  });
  const leases = createWorkerLeases(db, config);
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
      'INSERT OR IGNORE INTO agent_jobs (id,conversation_id,purpose,dedupe_key,status,due_at,created_at,delivery_channel) VALUES (?,?,?,?,?,?,?,?)',
      id(),
      c.id,
      purpose,
      key,
      state,
      now(),
      now(),
      c.delivery_channel || 'virtual_sms',
    );
    if (purpose === 'document_followup')
      createDocumentTicket(db, { requestId: key.slice(9), conversationId: c.id });
  }
  function resolution(c) {
    const r = one(db, 'SELECT * FROM agent_resolutions WHERE conversation_id=?', c.id);
    const context = r ? JSON.parse(r.context_json || '{}') : {};
    return r
      ? {
          status: r.status,
          reason: r.reason,
          nextAction: r.next_action,
          owner: context.owner || 'supervisor',
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
    // A conversation has one current resolution; keep its outstanding escalation records in sync.
    run(
      db,
      "UPDATE agent_escalations SET status=?,next_action=?,updated_at=? WHERE conversation_id=? AND status NOT IN ('resolved','cancelled')",
      status,
      nextAction.slice(0, 1000),
      now(),
      c.id,
    );
    const owner = context.owner || 'supervisor';
    log(c.id, `${owner === 'resolution_router' ? 'decision' : 'supervisor'}.${status}`, {
      reason,
      nextAction,
      owner,
      escalationId,
    });
  }
  function referSupervisor(c, job, reason, extra = {}) {
    // Tool validation can reject a supervisor action too. Never create a new review of itself.
    if (['supervisor_review', 'marina_guided_reply'].includes(job.purpose)) {
      const previous = one(
        db,
        'SELECT context_json FROM agent_resolutions WHERE conversation_id=?',
        c.id,
      );
      waitForResolution(
        c,
        job,
        'awaiting_specialist',
        reason,
        'I cannot complete this request with the currently available information or authorized capabilities.',
        { ...JSON.parse(previous?.context_json || '{}'), ...extra },
      );
      return;
    }
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
    const owner = context.owner || 'supervisor';
    run(
      db,
      "UPDATE agent_jobs SET status='completed',error=NULL,resolved_by=? WHERE id=?",
      owner,
      job.id,
    );
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
        'INSERT OR IGNORE INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
        id(),
        c.id,
        'outbound',
        text,
        'simulated_delivered',
        `job:${job.id}`,
        now(),
        c.delivery_channel || 'virtual_sms',
      );
    event(
      db,
      c.case_id,
      'agent_resolution_waiting',
      { status, reason, owner, nextAction },
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
      if (previous.agreement_id === agreementId)
        return {
          conversationId: previous.id,
          transport: previous.delivery_channel || 'virtual_sms',
          channel: previous.delivery_channel === 'email' ? 'email' : 'sms',
        };
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
      return {
        conversationId: previous.id,
        transport: previous.delivery_channel || 'virtual_sms',
        channel: previous.delivery_channel === 'email' ? 'email' : 'sms',
      };
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
    return { conversationId: c.id, transport: 'virtual_sms', channel: 'sms' };
  }
  function documentRequested({ provider, sessionId, caseId, kind, requestId, deliveryChannel }) {
    if (deliveryChannel === 'sms') deliveryChannel = 'virtual_sms';
    assert(
      config.mode === 'demo' && config.agentWorkflowsEnabled !== false,
      'Demo document workflows are disabled.',
      403,
    );
    assert(
      deliveryChannel == null || ['email', 'virtual_sms'].includes(deliveryChannel),
      'Invalid delivery channel.',
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
      // A retried tool call must not reroute a previously scheduled delivery.
      if (
        deliveryChannel &&
        !one(db, 'SELECT 1 FROM agent_jobs WHERE dedupe_key=?', `document:${request.id}`)
      ) {
        run(
          db,
          'UPDATE agent_conversations SET delivery_channel=?,updated_at=? WHERE id=?',
          deliveryChannel,
          now(),
          c.id,
        );
        c.delivery_channel = deliveryChannel;
      }
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
        ticketId: one(db, 'SELECT id FROM document_tickets WHERE request_id=?', request.id).id,
        transport: one(db, 'SELECT channel FROM document_tickets WHERE request_id=?', request.id)
          .channel,
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
    const portfolioDetails = item
      ? one(db, 'SELECT id,name,creditor,timezone FROM portfolios WHERE id=?', item.portfolio_id)
      : null;
    const suppressed = [item?.phone, item?.email]
      .filter(Boolean)
      .some((address) => one(db, 'SELECT 1 FROM suppressions WHERE address=?', address));
    const agreement = stored ? JSON.parse(stored.agreement_json) : null;
    const paymentState = getPaymentState(db, c.case_id);
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
      snapshot: JSON.stringify({
        item,
        stored,
        followup,
        reviews,
        portfolio,
        portfolioDetails,
        documents,
        paymentSummary: paymentState.summary,
        paymentVersions: paymentState.payments.map((p) => [p.id, p.version]),
      }),
      context: {
        caseId: c.case_id,
        caseRestriction,
        outcome: item?.outcome,
        name: item?.name,
        language: item?.language || 'en',
        agreement,
        authorizedOffers,
        presentedOffers: all(
          db,
          'SELECT offer_json FROM agent_presented_offers WHERE conversation_id=?',
          c.id,
        ).map((row) => JSON.parse(row.offer_json)),
        paymentAgreementCanBeSavedInChat: true,
        case: {
          id: c.case_id,
          name: item?.name,
          reference: item?.reference,
          contact: { phone: item?.phone || null, email: item?.email || null },
          contactSuppressed: Boolean(item?.suppressed || suppressed),
          reviewRequired: Boolean(item?.review_required),
          createdAt: item?.created_at || null,
          language: item?.language,
          creditor: portfolioDetails?.creditor || null,
          amountMinor: item?.amount_minor ?? null,
          currency: item?.currency || null,
          dueDate: item?.due_date || null,
          timezone: item?.timezone || null,
          status: item?.status || null,
          outcome: item?.outcome || null,
          willingness: item?.willingness || 'unknown',
          ability: item?.ability || 'unknown',
          identityConfirmedAt: item?.identity_verified_at || null,
        },
        portfolio: portfolioDetails
          ? { ...portfolioDetails, operationalStatus: portfolio?.status || null }
          : null,
        caseFactsSource:
          'Current case record; creditor from its linked portfolio record. Amount is recorded receivable, not proof of verified payment or current payoff.',
        payment: {
          details: followup?.payment_details || '',
          statusLookup: 'payment_status',
          evidenceMode: paymentState.summary.mode,
        },
        paymentDetails: [
          followup?.payment_details || '',
          ...paymentState.agreements.flatMap((a) =>
            a.installments
              .filter((p) => p.request?.status === 'ready')
              .map((p) => `Installment ${p.sequence} nonpayable request: ${p.request.url}`),
          ),
        ].join('\n'),
        channel: c.delivery_channel === 'email' ? 'email' : 'sms',
        transport: c.delivery_channel === 'email' ? 'gmail_test' : 'virtual',
        destination: c.delivery_channel === 'email' ? 'louiz@rescova.de' : `virtual:${c.case_id}`,
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
    channel: c.delivery_channel === 'email' ? 'email' : 'sms',
    transport: c.delivery_channel === 'email' ? 'gmail_test' : 'virtual',
    destination: c.delivery_channel === 'email' ? 'louiz@rescova.de' : `virtual:${c.case_id}`,
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
        delivery: one(
          db,
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_deliveries'",
        )
          ? one(
              db,
              "SELECT 'email' AS channel,status FROM email_deliveries WHERE message_id=?",
              m.id,
            ) || null
          : null,
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
  function presentedOfferBlock(offer) {
    const money = (minor) => `${offer.currency} ${(minor / 100).toFixed(2)}`;
    const groups = new Map();
    for (const part of offer.installments)
      groups.set(part.amountMinor, (groups.get(part.amountMinor) || 0) + 1);
    const amounts = [...groups]
      .map(([amount, count]) => `${count} × ${money(amount)}`)
      .join(' and ');
    const first = offer.installments[0].dueDate;
    const final = offer.installments.at(-1).dueDate;
    return `${offer.label}\nTotal: ${money(offer.totalMinor)}. ${offer.discountPercent ? `Discount: ${offer.discountPercent}%. ` : ''}${offer.installments.length === 1 ? `One payment of ${money(offer.totalMinor)}, due ${first}.` : `${offer.installments.length} monthly payments: ${amounts}. First due ${first}; final due ${final}.`} Interest: ${offer.interestPercent}%. Offer valid through ${offer.expiresOn}.`;
  }
  function paymentBlock(context) {
    const a = context.agreement;
    const money = (n) =>
      new Intl.NumberFormat('en-GB', { style: 'currency', currency: a.currency }).format(n / 100);
    return `DEMO — agreed payment details\n${a.label}\nTotal: ${money(a.totalMinor)}\n${a.installments.map((p, i) => `${i + 1}. ${money(p.amountMinor)} due ${p.dueDate}`).join('\n')}\n${context.paymentDetails}\nDemo payment instructions are nonpayable. Consult payment_status for current simulated receipts; no real money is processed.`;
  }
  function applyDirectTriage(c, job, triage) {
    if (!triage?.flags) return false;
    const reply = (body) =>
      run(
        db,
        'INSERT OR IGNORE INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
        id(),
        c.id,
        'outbound',
        body,
        'simulated_delivered',
        `job:${job.id}`,
        now(),
        c.delivery_channel || 'virtual_sms',
      );
    if (triage.flags.contact_stop >= 0.8) {
      reply(
        'Your request is recorded. Rescova will not send further collection messages to this contact.',
      );
      recordOutcome(
        db,
        c.case_id,
        { outcome: 'opt_out', note: 'Jev classified an explicit contact-stop request.' },
        'decision_engine',
      );
      cancelFollowups(c.case_id);
      stop(c, 'opted_out', 'Participant requested contact stop.');
      run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
      log(c.id, 'decision.direct_action', { role: 'inbound_triage', action: 'opt_out' });
      return true;
    }
    if (triage.flags.wrong_person >= 0.8) {
      reply('Thank you for telling us. This contact is blocked from further collection messages.');
      recordOutcome(
        db,
        c.case_id,
        { outcome: 'invalid_contact', note: 'Jev classified a wrong-person contact.' },
        'decision_engine',
      );
      cancelFollowups(c.case_id);
      stop(c, 'opted_out', 'Participant reported a wrong-person contact.');
      run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
      log(c.id, 'decision.direct_action', { role: 'inbound_triage', action: 'wrong_person' });
      return true;
    }
    if (triage.flags.payment_reported >= 0.8) {
      recordPaymentReport(db, c.case_id);
      run(db, "UPDATE cases SET outcome='paid_reported',status='review' WHERE id=?", c.case_id);
      cancelFollowups(c.case_id);
      reply(
        'Your payment report is recorded, but payment is not yet verified. Further collection is on hold pending verification.',
      );
      event(
        db,
        c.case_id,
        'payment_reported',
        { verified: false, owner: 'resolution_router' },
        'decision_engine',
      );
      referSupervisor(c, job, 'Payment verification requires verified payment-provider evidence.', {
        paymentReported: true,
      });
      log(c.id, 'decision.direct_action', {
        role: 'inbound_triage',
        action: 'paid_reported',
      });
      return true;
    }
    return false;
  }
  async function processJob(job, lease) {
    lease.assertCurrent();
    let semanticTriage = null;
    if (job.purpose === 'reply' && decisions.activeMode) {
      const gate = decisions.consumeInbound(job.dedupe_key.slice(6));
      if (!gate.ready) {
        run(
          db,
          "UPDATE agent_jobs SET due_at=?,error='Waiting for semantic triage' WHERE id=? AND status='queued'",
          new Date(Date.now() + 500).toISOString(),
          job.id,
        );
        return;
      }
      semanticTriage = gate.hint;
    }
    const ticket = one(db, 'SELECT * FROM document_tickets WHERE job_id=?', job.id);
    if (
      ticket &&
      (ticket.deadline_at <= now() ||
        ['cancelled', 'failed', 'completed', 'simulated_completed'].includes(ticket.status))
    ) {
      run(
        db,
        "UPDATE agent_jobs SET status='cancelled',error='Document ticket is closed or expired.' WHERE id=? AND status!='completed'",
        job.id,
      );
      reconcileDocumentTickets(db, ticket.case_id);
      return;
    }
    if (ticket && job.attempts >= ticket.max_attempts) {
      run(
        db,
        "UPDATE agent_jobs SET status='failed',error='Document composition retry budget exhausted.' WHERE id=?",
        job.id,
      );
      reconcileDocumentTickets(db, ticket.case_id);
      return;
    }
    const c = { ...get(job.conversation_id), delivery_channel: job.delivery_channel },
      loaded = loadContext(c, job.purpose === 'supervisor_review');
    const activeAgent = job.purpose === 'supervisor_review' ? 'Rafael' : 'Marina';
    const mandate = operatingMandate(db, {
      caseId: c.case_id,
      agentId: activeAgent,
      taskGoal:
        job.purpose === 'supervisor_review'
          ? 'Resolve the current case exception within available authority.'
          : 'Advance this debtor conversation toward an authorized resolution.',
    });
    const mandateAudit = mandateAuditFields(mandate);
    if (loaded.blocked) {
      stop(c, 'blocked', loaded.blocked);
      return;
    }
    if (job.purpose === 'reply' && semanticTriage && applyDirectTriage(c, job, semanticTriage))
      return;
    if (job.purpose === 'supervisor_review' && decisions.activeMode) {
      const storedResolution = one(
        db,
        'SELECT reason,context_json FROM agent_resolutions WHERE conversation_id=?',
        c.id,
      );
      const resolutionContext = JSON.parse(storedResolution?.context_json || '{}');
      const route = await decisions.routeEscalation({
        jobId: job.id,
        conversationId: c.id,
        caseId: c.case_id,
        reason: storedResolution?.reason || job.dedupe_key,
        context: { ...loaded.context, ...resolutionContext },
      });
      log(c.id, 'decision.escalation_routed', route);
      if (route.route === 'payment_verification') {
        waitForResolution(
          c,
          job,
          'awaiting_specialist',
          'Payment report awaits verified provider evidence.',
          null,
          { ...resolutionContext, owner: 'resolution_router' },
        );
        return;
      }
      if (route.route === 'document_wait') {
        waitForResolution(
          c,
          job,
          'awaiting_information',
          'Required document evidence is missing or ambiguous.',
          'The document information needed to resolve this is not available yet.',
          { ...resolutionContext, owner: 'resolution_router' },
        );
        return;
      }
      if (route.route === 'missing_information') {
        waitForResolution(
          c,
          job,
          'awaiting_information',
          'Specific case information is required before work can continue.',
          'More information is needed before this request can be completed.',
          { ...resolutionContext, owner: 'resolution_router' },
        );
        return;
      }
      if (route.route === 'policy_block') {
        waitForResolution(
          c,
          job,
          'blocked_policy',
          'The requested action is outside current authority or available capabilities.',
          'This request cannot be completed under the currently authorized options.',
          { ...resolutionContext, owner: 'resolution_router' },
        );
        return;
      }
    }
    const runId = id();
    run(db, "UPDATE agent_jobs SET status='running',attempts=attempts+1 WHERE id=?", job.id);
    run(
      db,
      `INSERT INTO agent_model_runs
       (id,conversation_id,job_id,role,status,goal_id,organization_mandate_version,portfolio_mandate_version,role_charter_version,policy_version,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      runId,
      c.id,
      job.id,
      job.purpose === 'supervisor_review' ? 'supervisor' : 'payment_conversation_agent',
      'running',
      mandateAudit.goalId,
      mandateAudit.organizationMandateVersion,
      mandateAudit.portfolioMandateVersion,
      mandateAudit.roleCharterVersion,
      mandateAudit.policyVersion,
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
      const emailTable = one(
        db,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_deliveries'",
      );
      const communicated = (message) =>
        message.direction === 'inbound' ||
        message.channel !== 'email' ||
        (emailTable &&
          one(
            db,
            "SELECT 1 FROM email_deliveries WHERE message_id=? AND status IN ('submitted','delivered')",
            message.id,
          ));
      history = history.filter(communicated);
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
        if (
          !documentResult.document &&
          one(db, 'SELECT 1 FROM document_tickets WHERE job_id=?', job.id)
        ) {
          transaction(db, () => {
            lease.assertCurrent();
            run(
              db,
              "UPDATE agent_jobs SET status='waiting_document',attempts=attempts-1,error=? WHERE id=?",
              documentResult.request.error || 'Requested document is unavailable.',
              job.id,
            );
            run(
              db,
              "UPDATE agent_model_runs SET status='waiting_information',completed_at=? WHERE id=?",
              now(),
              runId,
            );
            reconcileDocumentTickets(db, c.case_id);
          });
          return;
        }
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
        transaction(db, () => {
          lease.assertCurrent();
          reconcileDocumentTickets(db, c.case_id);
        });
      }
      const deliveredDocuments = all(
        db,
        'SELECT DISTINCT d.id,d.title,d.kind,d.version,d.content FROM case_documents d JOIN agent_message_documents a ON a.document_id=d.id JOIN agent_messages m ON m.id=a.message_id WHERE m.conversation_id=? AND d.case_id=?',
        c.id,
        c.case_id,
      )
        .filter((d) =>
          all(
            db,
            'SELECT m.* FROM agent_messages m JOIN agent_message_documents a ON a.message_id=m.id WHERE m.conversation_id=? AND a.document_id=?',
            c.id,
            d.id,
          ).some(communicated),
        )
        .map((d) => ({
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
      const lookupResults = [];
      const seenLookups = new Set();
      const preloadTopic =
        semanticTriage?.contextConfidence >= 0.75 &&
        [
          'case_details',
          'payment_terms',
          'payment_status',
          'documents',
          'activity',
          'conversation_history',
        ].includes(semanticTriage.contextRoute)
          ? semanticTriage.contextRoute
          : null;
      if (preloadTopic) {
        const query = { topic: preloadTopic, query: null, documentId: null, offset: 0 };
        lookupResults.push({ query, result: lookupCaseInformation(db, c.case_id, query) });
        seenLookups.add(JSON.stringify(query));
        log(c.id, 'decision.context_preloaded', {
          role: 'context_router',
          topic: preloadTopic,
        });
      }
      const runWithLookups = async (input) => {
        for (let round = 0; ; round++) {
          const decision = await runAgent({
            ...input,
            context: { ...input.context, operatingMandate: mandate, lookupResults },
          });
          lease.assertCurrent();
          if (decision.action !== 'lookup_case_information') return decision;
          const query = {
            topic: decision.lookupTopic,
            query: decision.lookupQuery || null,
            documentId: decision.lookupDocumentId || null,
            offset: decision.lookupOffset ?? 0,
          };
          const key = JSON.stringify(query);
          if (round >= 4 || seenLookups.has(key)) {
            return {
              action:
                job.purpose === 'supervisor_review'
                  ? 'awaiting_information'
                  : 'escalate_supervisor',
              text: '',
              reason:
                'Case lookup needs a more specific query; repeated or excessive retrieval was stopped.',
            };
          }
          seenLookups.add(key);
          const fresh = get(c.id);
          if (
            fresh.version !== c.version ||
            loadContext(fresh, job.purpose === 'supervisor_review').blocked
          ) {
            return {
              action: 'reply',
              text: 'The case state changed; this response cannot continue.',
            };
          }
          const evidence = lookupCaseInformation(db, c.case_id, query);
          lookupResults.push({ query, result: evidence });
          const trace = decision.runs?.at(-1) || decision;
          run(
            db,
            'INSERT INTO agent_model_runs (id,conversation_id,job_id,role,status,model,provider,usage_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            id(),
            c.id,
            job.id,
            job.purpose === 'supervisor_review' ? 'supervisor' : 'payment_conversation_agent',
            'completed',
            trace.model || null,
            trace.provider || null,
            trace.usage ? JSON.stringify(trace.usage) : null,
            now(),
            now(),
          );
          log(c.id, 'case.lookup', {
            topic: query.topic,
            documentId: query.documentId,
            offset: query.offset,
          });
        }
      };
      let result =
        documentResult && !documentResult.document
          ? {
              action: 'escalate_supervisor',
              text: 'The requested document needs review.',
              reason: 'Requested document is missing or ambiguous.',
            }
          : await runWithLookups({
              context: {
                ...loaded.context,
                case: {
                  id: c.case_id,
                  name: loaded.context.name,
                  reference: loaded.context.case.reference,
                  language: loaded.context.language,
                },
                portfolio: undefined,
                caseFactsSource: undefined,
                availableLookups: [
                  'case_details',
                  'activity',
                  'followups',
                  'contact_attempts',
                  'documents',
                  'document_content',
                  'delivery',
                  'payment_terms',
                  'payment_status',
                  'conversation_history',
                  'document_search',
                ],
                historyCoverage: {
                  totalMessages: history.length,
                  suppliedMessages: Math.min(history.length, 24),
                  olderMessagesAvailableVia: 'conversation_history',
                },
                purpose: job.purpose,
                semanticTriage,
                supervisorResolution: resolutionContext,
                supervisorGuidance:
                  job.purpose === 'marina_guided_reply' ? resolutionContext.guidance : null,
                availableCapabilities: [
                  'read_case_context',
                  'present_authorized_offers',
                  'save_payment_agreement_in_text',
                  'retrieve_loan_agreement',
                  'retrieve_account_statement',
                  'virtual_sms',
                ],
                unavailableCapabilities: [
                  'verify_real_payment',
                  'change_approved_terms',
                  'human_transfer',
                ],
                deliveredDocuments: deliveredDocuments.map(({ content, ...metadata }) => metadata),
                conversationHistory: history.slice(-24).map((m) => ({
                  id: m.id,
                  direction: m.direction,
                  channel: m.channel,
                })),
                documentResult: documentResult?.document
                  ? {
                      id: documentResult.document.id,
                      title: documentResult.document.title,
                      kind: documentResult.document.kind,
                      version: documentResult.document.version,
                      source: documentResult.document.source,
                      excerptTruncated: documentResult.document.content.length > 6000,
                      totalCharacters: documentResult.document.content.length,
                      contentAvailableVia: 'document_content',
                    }
                  : null,
              },
              messages: history.slice(-24).map((m) => ({
                role: m.direction === 'inbound' ? 'user' : 'assistant',
                content: m.body,
              })),
              supervisor: job.purpose === 'supervisor_review',
              deferSupervisor: true,
              signal: AbortSignal.any([abortController.signal, lease.signal]),
            });
      assert(
        result &&
          [
            'reply',
            'accept_payment_offer',
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
              'accept_payment_offer',
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
      const allowedLinks = new Set([
        ...(loaded.context.paymentDetails.match(/https?:\/\/[^\s]+/g) || []),
        ...getPaymentState(db, c.case_id).agreements.flatMap((a) =>
          a.installments.map((p) => p.request?.url).filter(Boolean),
        ),
      ]);
      assert(
        (result.text.match(/https?:\/\/[^\s]+/g) || []).every((url) =>
          allowedLinks.has(url.replace(/[.,;]$/, '')),
        ),
        'Agent supplied an unauthorized payment URL.',
      );
      const allowedAmounts = new Set([
        ...(Number.isFinite(loaded.context.case.amountMinor)
          ? [loaded.context.case.amountMinor]
          : []),
        ...loaded.context.authorizedOffers.flatMap((o) => [
          o.totalMinor,
          ...o.installments.map((p) => p.amountMinor),
        ]),
        ...Object.values(getPaymentState(db, c.case_id).summary).filter(Number.isSafeInteger),
        ...getPaymentState(db, c.case_id).agreements.flatMap((a) =>
          a.installments.flatMap((p) => [p.paidMinor, p.remainingMinor]),
        ),
        ...(loaded.context.agreement
          ? [
              loaded.context.agreement.totalMinor,
              ...loaded.context.agreement.installments.map((p) => p.amountMinor),
            ]
          : []),
      ]);
      const evidence = [
        { content: JSON.stringify(lookupResults) },
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
        ...(loaded.context.case.dueDate ? [loaded.context.case.dueDate] : []),
        ...(loaded.context.agreement?.installments || []).map((p) => p.dueDate),
        ...loaded.context.authorizedOffers.flatMap((o) => o.installments.map((p) => p.dueDate)),
      ]);
      for (const date of evidence.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []) dates.add(date);
      assert(
        (result.text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).every((date) => dates.has(date)),
        'Agent supplied an unauthorized payment date.',
      );
      transaction(db, () => {
        lease.assertCurrent();
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
        if (ticket && ticket.deadline_at <= now()) {
          reconcileDocumentTickets(db, c.case_id);
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
        if (result.action === 'accept_payment_offer') {
          const latest = history.filter((m) => m.direction === 'inbound').at(-1);
          const quote = result.acceptanceQuote?.trim();
          const stated = latest?.body.trim() || '';
          const presented = one(
            db,
            'SELECT o.*,m.channel AS source_channel FROM agent_presented_offers o JOIN agent_messages m ON m.id=o.message_id WHERE o.conversation_id=? AND o.offer_id=?',
            c.id,
            result.offerId || '',
          );
          const offer = presented ? JSON.parse(presented.offer_json) : null;
          const prior = loaded.context.agreement;
          const newest = one(
            db,
            "SELECT id FROM agent_messages WHERE conversation_id=? AND direction='inbound' ORDER BY rowid DESC LIMIT 1",
            c.id,
          );
          const consent =
            latest?.id === newest?.id &&
            quote &&
            stated.includes(quote) &&
            /\b(yes|accept|agree|go ahead|confirm|sim|aceito|concordo)\b/i.test(stated) &&
            !/[?]/.test(stated) &&
            !/\b(not|don.t|do not|no|never|if|hypothetical|não)\b/i.test(stated);
          const siblings = presented
            ? one(
                db,
                'SELECT COUNT(*) n FROM agent_presented_offers WHERE conversation_id=? AND message_id=?',
                c.id,
                presented.message_id,
              ).n
            : 0;
          const namedOffer =
            result.offerId === 'three_installments'
              ? /\b(three|3)\b/i.test(stated)
              : result.offerId === 'six_installments'
                ? /\b(six|6)\b/i.test(stated)
                : /\b(upfront|discount|today|full)\b/i.test(stated);
          const selectedOfferClear = prior || siblings === 1 || namedOffer;
          const emailOfferSubmitted =
            presented?.source_channel !== 'email' ||
            prior ||
            (presented &&
              one(
                db,
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_deliveries'",
              ) &&
              one(
                db,
                "SELECT 1 FROM email_deliveries WHERE message_id=? AND status IN ('submitted','delivered')",
                presented.message_id,
              ));
          const today = datedDemoPaymentOffers()[0].anchorDate;
          // Missing consent is a participant clarification, not a supervisor exception.
          if (
            (!consent || !selectedOfferClear) &&
            offer &&
            today <= offer.expiresOn &&
            emailOfferSubmitted &&
            (!prior || prior.offerId === result.offerId)
          ) {
            const clarification = !selectedOfferClear
              ? 'Which payment option would you like to accept? Please name the option when confirming.'
              : `Would you like me to record the ${offer.label.toLowerCase()} plan under the terms shown above? Please reply “I accept the ${offer.label.toLowerCase()} plan” if you want to proceed.`;
            run(
              db,
              'INSERT OR IGNORE INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
              id(),
              c.id,
              'outbound',
              clarification,
              'simulated_delivered',
              `job:${job.id}`,
              now(),
              c.delivery_channel || 'virtual_sms',
            );
            run(db, "UPDATE agent_jobs SET status='completed',error=NULL WHERE id=?", job.id);
            if (savedResolution)
              saveResolution(
                c,
                'resolved',
                'Payment confirmation clarification supplied.',
                'Marina awaits the participant’s explicit confirmation.',
                resolutionContext,
              );
            log(c.id, 'payment.confirmation_requested', { jobId: job.id, offerId: result.offerId });
            return;
          }
          if (
            !consent ||
            !selectedOfferClear ||
            !emailOfferSubmitted ||
            (!prior && (!offer || today > offer.expiresOn)) ||
            (prior && prior.offerId !== result.offerId)
          ) {
            referSupervisor(
              c,
              job,
              prior && prior.offerId !== result.offerId
                ? 'Requested offer would replace the existing agreement; authorized amendment capability is required.'
                : 'Payment acceptance needs an unexpired previously explained and sent offer and explicit consent from the latest inbound message.',
            );
            return;
          }
          if (!prior) {
            const agreement = {
              id: id(),
              offerId: offer.offerId,
              label: offer.label,
              currency: offer.currency,
              totalMinor: offer.totalMinor,
              installments: offer.installments,
              demo: true,
              acceptance: 'self_reported_explicit_consent',
              acceptedAt: now(),
              timezone: offer.timezone,
            };
            persistDemoAgreement(db, config, {
              provider: c.provider,
              sessionId: c.session_id,
              agreement,
            });
            run(
              db,
              'UPDATE agent_conversations SET agreement_id=?,updated_at=? WHERE id=?',
              agreement.id,
              now(),
              c.id,
            );
            log(c.id, 'agreement.accepted_in_text', {
              agreementId: agreement.id,
              offerId: offer.offerId,
              inboundMessageId: latest.id,
              acceptanceQuote: quote,
              channel: loaded.context.channel,
            });
          }
          const saved = loadContext({ ...get(c.id), delivery_channel: c.delivery_channel }).context;
          result = {
            ...result,
            action: 'reply',
            paymentInstructionAgreementId: saved.agreement.id,
            text: `Your demo payment agreement is recorded.\n\n${paymentBlock(saved)}`,
            presentedOfferIds: [],
          };
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
          const requestedChannel =
            result.deliveryChannel === 'email'
              ? 'email'
              : result.deliveryChannel === 'sms'
                ? 'virtual_sms'
                : c.delivery_channel;
          enqueue(
            { ...c, delivery_channel: requestedChannel },
            'document_followup',
            `document:${request.id}`,
          );
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
            recordPaymentReport(db, c.case_id);
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
              'INSERT OR IGNORE INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
              id(),
              c.id,
              'outbound',
              'Your payment report is recorded, but payment is not yet verified. Further collection is on hold pending verification.',
              'simulated_delivered',
              `job:${job.id}`,
              now(),
              c.delivery_channel || 'virtual_sms',
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
        const presentedOffers = [...new Set(result.presentedOfferIds || [])].map((offerId) => {
          const offer = loaded.context.authorizedOffers.find((item) => item.offerId === offerId);
          assert(offer, 'Cannot present an unauthorized payment offer.');
          return offer;
        });
        const offerTerms = presentedOffers.length
          ? `\n\n${presentedOffers.map(presentedOfferBlock).join('\n\n')}\nThese are fictional demo offers; no agreement is recorded until you accept.`
          : '';
        const body =
          job.purpose === 'agreement_followup'
            ? `${result.text.trim()}\n\n${paymentBlock(loaded.context)}`
            : `${result.text.trim()}${offerTerms}`;
        const messageId = id();
        run(
          db,
          'INSERT OR IGNORE INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
          messageId,
          c.id,
          'outbound',
          body,
          'simulated_delivered',
          `job:${job.id}`,
          now(),
          c.delivery_channel || 'virtual_sms',
        );
        const instructionsAgreementId =
          result.paymentInstructionAgreementId ||
          (job.purpose === 'agreement_followup' ? c.agreement_id : null);
        if (instructionsAgreementId)
          run(
            db,
            "UPDATE payment_tasks SET message_id=?,channel=?,next_action='Await delivery evidence for the linked agreement instructions.',updated_at=? WHERE case_id=? AND agreement_id=? AND kind='instructions' AND message_id IS NULL",
            messageId,
            c.delivery_channel || 'virtual_sms',
            now(),
            c.case_id,
            instructionsAgreementId,
          );
        for (const offerId of result.presentedOfferIds || []) {
          const offer = loaded.context.authorizedOffers.find((item) => item.offerId === offerId);
          assert(offer, 'Cannot present an unauthorized payment offer.');
          run(
            db,
            'INSERT INTO agent_presented_offers VALUES (?,?,?,?,?) ON CONFLICT(conversation_id,offer_id) DO UPDATE SET offer_json=excluded.offer_json,message_id=excluded.message_id,created_at=excluded.created_at',
            c.id,
            offerId,
            JSON.stringify(offer),
            messageId,
            now(),
          );
        }
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
      if (closing || !lease.valid()) return;
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
    } finally {
      if (lease.valid())
        transaction(db, () => {
          lease.assertCurrent();
          reconcileDocumentTickets(db, c.case_id);
        });
    }
  }
  async function drain() {
    if (config.mode !== 'demo' || config.agentWorkflowsEnabled === false) return;
    await decisions.drain();
    await payments.tick();
    // Reuse the case lease and existing executor; waiting dependencies consume no model tokens.
    for (const pending of all(
      db,
      "SELECT case_id,MIN(updated_at) oldest FROM document_tickets WHERE status NOT IN ('completed','simulated_completed','failed','cancelled') GROUP BY case_id ORDER BY oldest LIMIT 200",
    )) {
      const lease = leases.acquire(`case:${pending.case_id}`);
      if (!lease) continue;
      try {
        transaction(db, () => {
          lease.assertCurrent();
          reconcileDocumentTickets(db, pending.case_id);
          for (const waiting of all(
            db,
            `SELECT j.*,t.request_id FROM agent_jobs j JOIN document_tickets t ON t.job_id=j.id
            JOIN agent_conversations c ON c.id=j.conversation_id WHERE t.case_id=? AND j.status='waiting_document'
            AND c.status='active' AND t.status='waiting_information' AND t.deadline_at>?`,
            pending.case_id,
            now(),
          )) {
            const req = one(db, 'SELECT * FROM document_requests WHERE id=?', waiting.request_id);
            const available = one(
              db,
              'SELECT COUNT(DISTINCT title) count FROM case_documents WHERE case_id=? AND kind=?',
              pending.case_id,
              req.kind,
            );
            if (available.count !== 1) continue;
            const result = library.resolve(waiting.request_id);
            if (result.document)
              run(
                db,
                "UPDATE agent_jobs SET status='queued',error=NULL,due_at=? WHERE id=?",
                now(),
                waiting.id,
              );
          }
          reconcileDocumentTickets(db, pending.case_id);
        });
      } finally {
        lease.release();
      }
    }
    for (const waiting of all(
      db,
      "SELECT c.*,r.fingerprint FROM agent_conversations c JOIN agent_resolutions r ON r.conversation_id=c.id WHERE c.status IN ('awaiting_information','awaiting_specialist')",
    )) {
      const lease = leases.acquire(`case:${waiting.case_id}`);
      if (!lease) continue;
      try {
        const fresh = get(waiting.id);
        if (!['awaiting_information', 'awaiting_specialist'].includes(fresh.status)) continue;
        const checked = loadContext({ ...fresh, status: 'active' });
        if (!checked.blocked && checked.snapshot !== waiting.fingerprint)
          transaction(db, () => {
            lease.assertCurrent();
            wakeResolution(fresh, `context:${fresh.id}:${id()}`);
          });
      } finally {
        lease.release();
      }
    }
    const concurrency = Math.max(1, Math.min(32, Number(config.agentWorkerConcurrency) || 4));
    const budget = Math.max(concurrency, Number(config.workerBatchSize) || 40);
    let completed = 0;
    while (!closing && completed < budget) {
      const candidates = all(
        db,
        `SELECT DISTINCT c.case_id FROM agent_jobs j
        JOIN agent_conversations c ON c.id=j.conversation_id
        WHERE j.status IN ('queued','running') AND j.due_at<=? AND c.status='active'
        AND NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.resource='case:' || c.case_id AND l.expires_at>?)
        AND NOT EXISTS (SELECT 1 FROM agent_jobs older JOIN agent_conversations oc ON oc.id=older.conversation_id
          WHERE oc.case_id=c.case_id AND older.rowid<j.rowid AND older.status IN ('queued','running','waiting_source_end','failed'))
        LIMIT ?`,
        now(),
        Date.now(),
        budget,
      );
      let progressed = 0;
      await boundedMap(candidates, concurrency, async ({ case_id: caseId }) => {
        if (closing || completed >= budget) return;
        const lease = leases.acquire(`case:${caseId}`);
        if (!lease) return;
        try {
          // Only an expired/absent case lease permits recovering interrupted model work.
          run(
            db,
            "UPDATE agent_model_runs SET status='interrupted',completed_at=? WHERE status='running' AND conversation_id IN (SELECT id FROM agent_conversations WHERE case_id=?)",
            now(),
            caseId,
          );
          run(
            db,
            "UPDATE agent_jobs SET status='queued' WHERE status='running' AND conversation_id IN (SELECT id FROM agent_conversations WHERE case_id=?)",
            caseId,
          );
          const job = one(
            db,
            `SELECT j.* FROM agent_jobs j JOIN agent_conversations c ON c.id=j.conversation_id
            WHERE c.case_id=? AND c.status='active' AND j.status='queued' AND j.due_at<=?
            AND NOT EXISTS (SELECT 1 FROM agent_jobs older JOIN agent_conversations oc ON oc.id=older.conversation_id
              WHERE oc.case_id=c.case_id AND older.rowid<j.rowid AND older.status IN ('queued','running','waiting_source_end','failed'))
            ORDER BY j.rowid LIMIT 1`,
            caseId,
            now(),
          );
          if (!job) return;
          progressed++;
          completed++;
          await processJob(job, lease);
        } finally {
          lease.release();
        }
      });
      if (!progressed) break;
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
  router.get('/decisions', (req, res) =>
    res.json({
      mode: decisions.mode,
      enabled: decisions.enabled,
      summary: decisions.stats(),
      decisions: decisions.list(req.query.limit),
    }),
  );
  router.get('/:id', (req, res) => res.json(detail(req.params.id)));
  function receiveInbound(conversationId, { text, requestId, channel = 'virtual_sms' } = {}) {
    assert(['virtual_sms', 'email'].includes(channel), 'Invalid inbound channel.');
    const c = get(conversationId);
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
      assert(
        duplicate.body === text.trim() && duplicate.channel === channel,
        'requestId already used for another message.',
        409,
      );
      return detail(c.id);
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
      run(
        db,
        'UPDATE agent_conversations SET delivery_channel=?,updated_at=? WHERE id=?',
        channel,
        now(),
        c.id,
      );
      c.delivery_channel = channel;
      const messageId = id();
      run(
        db,
        'INSERT INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
        messageId,
        c.id,
        'inbound',
        text.trim(),
        'received',
        requestId,
        now(),
        channel,
      );
      decisions.queueInbound({ messageId, conversationId: c.id, caseId: c.case_id });
      log(c.id, 'message.received', { messageId });
      if (
        /^(stop|unsubscribe|opt[ -]?out|do not contact me|don.t contact me|pare|cancelar)[.!\s]*$/i.test(
          text.trim(),
        )
      ) {
        recordOutcome(
          db,
          c.case_id,
          { outcome: 'opt_out', note: `${channel} participant requested stop` },
          'agent',
        );
        cancelFollowups(c.case_id);
        stop(c, 'opted_out', 'Participant requested contact stop.');
      } else if (resolutionStates.has(c.status)) wakeResolution(c, `clarification:${messageId}`);
      else enqueue(c, 'reply', `reply:${messageId}`);
    });
    return detail(c.id);
  }
  router.post('/:id/messages', (req, res) =>
    res.status(202).json(receiveInbound(req.params.id, req.body)),
  );
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
      "UPDATE agent_jobs SET status='queued',attempts=0,due_at=? WHERE conversation_id=? AND status='failed' AND NOT EXISTS (SELECT 1 FROM document_tickets t WHERE t.job_id=agent_jobs.id)",
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
      const purpose = supervisor
        ? "purpose='supervisor_review' AND COALESCE(resolved_by,'supervisor')='supervisor'"
        : "purpose!='supervisor_review'";
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
      inbound_triage: decisions.statsFor('inbound_triage'),
      context_router: decisions.statsFor('context_router'),
      resolution_router: decisions.statsFor('resolution_router'),
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
    receiveInbound,
    deliveryContext: (conversationId) => {
      const c = get(conversationId);
      return loadContext(resolutionStates.has(c.status) ? { ...c, status: 'active' } : c);
    },
    setDeliveryChannel(conversationId, channel) {
      assert(['email', 'virtual_sms'].includes(channel), 'Invalid delivery channel.');
      get(conversationId);
      run(
        db,
        'UPDATE agent_conversations SET delivery_channel=?,version=version+1,updated_at=? WHERE id=?',
        channel,
        now(),
        conversationId,
      );
      return detail(conversationId);
    },
    agentStats,
    documentRequested,
    library,
    summary,
    router,
    payments,
    decisions,
    agreementSaved,
    sourceEnded,
    outcomeChanged,
    tick,
    workerStats: () => ({
      ...leases.stats(),
      owner: leases.owner,
      queued: one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='queued'").n,
      running: one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='running'").n,
      oldestQueuedAt: one(db, "SELECT MIN(created_at) at FROM agent_jobs WHERE status='queued'").at,
      concurrency: Math.max(1, Math.min(32, Number(config.agentWorkerConcurrency) || 4)),
      decisions: decisions.stats(),
    }),
    detail,
    async closeAll() {
      closing = true;
      abortController.abort();
      if (active) await active;
      await decisions.close();
    },
  };
}
