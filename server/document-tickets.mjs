import { id, now, one, all, run } from './db.mjs';

const terminal = new Set(['completed', 'simulated_completed', 'cancelled', 'failed']);
const tableExists = (db, name) =>
  !!one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export function ensureDocumentTickets(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_tickets (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES document_requests(id),
    case_id TEXT NOT NULL REFERENCES cases(id), conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
    channel TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES agent_jobs(id),
    document_id TEXT, document_version INTEGER, message_id TEXT, delivery_id TEXT,
    status TEXT NOT NULL, owner TEXT NOT NULL, next_action TEXT NOT NULL, error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    deadline_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS document_tickets_case_status ON document_tickets(case_id,status);
    CREATE INDEX IF NOT EXISTS document_tickets_message ON document_tickets(message_id);`);
}

// Called inside the same transaction that creates the request and its existing executor job.
export function createDocumentTicket(db, { requestId, conversationId }) {
  const prior = one(db, 'SELECT * FROM document_tickets WHERE request_id=?', requestId);
  if (prior) {
    if (prior.conversation_id !== conversationId)
      throw Object.assign(new Error('Document request belongs to another conversation.'), {
        status: 409,
      });
    return prior;
  }
  const request = one(db, 'SELECT * FROM document_requests WHERE id=?', requestId);
  const job = one(
    db,
    'SELECT * FROM agent_jobs WHERE dedupe_key=? AND conversation_id=?',
    `document:${requestId}`,
    conversationId,
  );
  if (!request || !job) throw new Error('Document ticket requires its request and executor job.');
  const ticketId = id(),
    at = now();
  run(
    db,
    `INSERT INTO document_tickets
    (id,request_id,case_id,conversation_id,channel,job_id,status,owner,next_action,deadline_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ticketId,
    requestId,
    request.case_id,
    conversationId,
    job.delivery_channel,
    job.id,
    job.status,
    'Helena',
    job.status === 'waiting_source_end'
      ? 'Wait for the call to end, then retrieve the requested document.'
      : 'Retrieve the requested document.',
    new Date(Date.now() + 7 * 86400000).toISOString(),
    at,
    at,
  );
  return one(db, 'SELECT * FROM document_tickets WHERE id=?', ticketId);
}

export function documentTicketAllowsDelivery(db, messageId) {
  const ticket = one(
    db,
    "SELECT * FROM document_tickets WHERE message_id=? AND channel='email'",
    messageId,
  );
  return (
    !ticket ||
    (!terminal.has(ticket.status) && ticket.status !== 'uncertain' && ticket.deadline_at > now())
  );
}

// A projection of persisted execution evidence. Mutations call this while holding the case lease.
export function reconcileDocumentTickets(db, caseId) {
  if (!tableExists(db, 'document_tickets')) return;
  for (const t of all(db, 'SELECT * FROM document_tickets WHERE case_id=?', caseId)) {
    if (terminal.has(t.status)) continue;
    const job = one(db, 'SELECT * FROM agent_jobs WHERE id=?', t.job_id);
    const request = one(db, 'SELECT * FROM document_requests WHERE id=?', t.request_id);
    const c = one(db, 'SELECT * FROM agent_conversations WHERE id=?', t.conversation_id);
    const doc = request?.document_id
      ? one(
          db,
          'SELECT id,version,source FROM case_documents WHERE id=? AND case_id=?',
          request.document_id,
          t.case_id,
        )
      : null;
    const message = one(
      db,
      "SELECT * FROM agent_messages WHERE conversation_id=? AND request_id=? AND direction='outbound'",
      t.conversation_id,
      `job:${t.job_id}`,
    );
    const delivery =
      message && tableExists(db, 'email_deliveries')
        ? one(db, 'SELECT * FROM email_deliveries WHERE message_id=?', message.id)
        : null;
    const binding = tableExists(db, 'email_bindings')
      ? one(db, 'SELECT status FROM email_bindings WHERE conversation_id=?', t.conversation_id)
      : null;
    const linked =
      message &&
      doc &&
      one(
        db,
        'SELECT 1 FROM agent_message_documents WHERE message_id=? AND document_id=?',
        message.id,
        doc.id,
      );
    let attachmentConfirmed = false;
    try {
      attachmentConfirmed =
        !!doc &&
        !!delivery &&
        JSON.parse(delivery.attachments_json).some((a) => a.documentId === doc.id);
    } catch {
      /* Missing receipt payload is not evidence. */
    }
    const portfolio = one(
      db,
      'SELECT p.status FROM portfolio_operations p JOIN cases c ON c.portfolio_id=p.portfolio_id WHERE c.id=?',
      caseId,
    );
    let status = job?.status === 'completed' ? 'blocked_policy' : job?.status || 'failed',
      owner = 'Helena',
      action = 'Retrieve the requested document.',
      error = job?.error || null;
    if (job?.status === 'completed') {
      owner = 'Rafael';
      action =
        'The executor ended without verified document fulfillment. Resolve the incomplete result.';
    }
    if (doc) {
      owner = 'Marina';
      action = 'Compose the document response using the pinned version.';
    }
    if (job?.status === 'completed' && !linked) {
      owner = 'Rafael';
      action =
        'The executor ended without a response linked to the pinned document. Resolve the incomplete result.';
    }
    if (message && linked) {
      status = 'awaiting_delivery';
      action = 'Submit the prepared document email.';
    }
    if (job?.status === 'waiting_document') {
      status = 'waiting_information';
      action = request?.error || 'Wait for the requested document to become available.';
    }
    if (job?.status === 'waiting_source_end')
      action = 'Wait for the call to end, then retrieve the requested document.';
    if (message && linked && t.channel === 'email' && !delivery) {
      if (doc.source !== 'synthetic_demo') {
        status = 'blocked_policy';
        owner = 'Rafael';
        action =
          'Resolve document release eligibility: external demo email permits seeded fictional documents only.';
      } else if (!binding || binding.status === 'awaiting_configuration') {
        status = 'awaiting_configuration';
        action = 'Wait for the configured Gmail test transport.';
      }
    }
    if (delivery) {
      status = delivery.status === 'sending' ? 'running' : 'awaiting_delivery';
      if (['uncertain', 'failed', 'cancelled'].includes(delivery.status)) {
        status = delivery.status;
        owner = 'Rafael';
        action = delivery.error || 'Resolve the delivery outcome before any further send.';
        error = delivery.error;
      }
    }
    if (
      c?.status === 'paused' ||
      portfolio?.status === 'paused' ||
      (t.channel === 'email' && binding?.status === 'paused')
    ) {
      status = 'paused';
      action = 'Wait for the conversation, portfolio or email delivery to resume.';
    } else if (
      ['opted_out', 'blocked', 'stopped', 'cancelled'].includes(c?.status) ||
      request?.status === 'cancelled' ||
      job?.status === 'cancelled'
    ) {
      status = 'cancelled';
      action = 'No further contact: the request or case is stopped.';
    }
    // Evidence wins over a later stop/deadline; submitted never means delivered or read.
    if (
      linked &&
      t.channel === 'email' &&
      ['submitted', 'delivered'].includes(delivery?.status) &&
      delivery.provider_message_id &&
      attachmentConfirmed
    ) {
      status = 'completed';
      owner = 'Marina';
      action =
        'Gmail accepted the message with the pinned attachment; delivery and reading are unconfirmed.';
      error = null;
    } else if (linked && t.channel === 'virtual_sms' && message.status === 'simulated_delivered') {
      status = 'simulated_completed';
      owner = 'Marina';
      action = 'Document available in the virtual SMS inbox; no external SMS was sent.';
      error = null;
    } else if (!['uncertain', 'cancelled'].includes(status) && t.deadline_at <= now()) {
      status = 'failed';
      owner = 'Rafael';
      action =
        'The seven-day fulfillment deadline expired. Resolve the dependency before creating a new request.';
      error = 'Fulfillment deadline expired.';
    }
    if (status === 'failed') {
      owner = 'Rafael';
      action =
        error ||
        'Execution exhausted its retry budget. Resolve the cause before starting a new request.';
    }
    if (terminal.has(status) && !['completed', 'simulated_completed'].includes(status)) {
      run(
        db,
        "UPDATE agent_jobs SET status='cancelled',error=? WHERE id=? AND status NOT IN ('completed','failed','cancelled')",
        action,
        t.job_id,
      );
      if (delivery?.status === 'queued')
        run(
          db,
          "UPDATE email_deliveries SET status='cancelled',error=?,updated_at=? WHERE id=?",
          action,
          now(),
          delivery.id,
        );
    }
    run(
      db,
      `UPDATE document_tickets SET document_id=?,document_version=?,message_id=?,delivery_id=?,status=?,owner=?,next_action=?,error=?,attempts=?,updated_at=?,completed_at=? WHERE id=?`,
      t.document_id || doc?.id || null,
      t.document_version || doc?.version || null,
      message?.id || t.message_id,
      delivery?.id || t.delivery_id,
      status,
      owner,
      action,
      error,
      job?.attempts || 0,
      now(),
      ['completed', 'simulated_completed'].includes(status) ? now() : null,
      t.id,
    );
  }
}

function present(db, t) {
  const job = one(db, 'SELECT * FROM agent_jobs WHERE id=?', t.job_id);
  const delivery =
    t.delivery_id && tableExists(db, 'email_deliveries')
      ? one(db, 'SELECT status,provider_message_id FROM email_deliveries WHERE id=?', t.delivery_id)
      : null;
  const result = Object.fromEntries(
    Object.entries(t).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
      value,
    ]),
  );
  result.providerMessageId = delivery?.provider_message_id || null;
  result.steps = [
    {
      key: 'retrieval',
      title: 'Retrieve document',
      owner: 'Helena',
      status: t.document_id
        ? 'completed'
        : t.status === 'waiting_information'
          ? 'waiting_information'
          : 'pending',
      evidence: t.document_id
        ? { documentId: t.document_id, version: t.document_version, requestId: t.request_id }
        : { requestId: t.request_id },
    },
    {
      key: 'compose',
      title: 'Prepare response',
      owner: 'Marina',
      status: t.message_id ? 'completed' : job?.status || 'pending',
      evidence: { jobId: t.job_id, messageId: t.message_id },
    },
    {
      key: 'delivery',
      title: t.channel === 'email' ? 'Submit email' : 'Publish virtual SMS',
      owner: 'Marina',
      status:
        delivery?.status ||
        (t.status === 'simulated_completed' ? 'simulated_completed' : 'pending'),
      evidence: {
        deliveryId: t.delivery_id,
        messageId: t.message_id,
        providerMessageId: result.providerMessageId,
        channel: t.channel,
      },
    },
  ];
  return result;
}
export function getDocumentTicket(db, ticketId) {
  if (!tableExists(db, 'document_tickets')) return null;
  const row = one(db, 'SELECT * FROM document_tickets WHERE id=?', ticketId);
  return row ? present(db, row) : null;
}
export function listDocumentTickets(db, { caseId, limit = 100, offset = 0 } = {}) {
  if (!tableExists(db, 'document_tickets')) return [];
  const args = caseId ? [caseId] : [];
  return all(
    db,
    `SELECT * FROM document_tickets ${caseId ? 'WHERE case_id=?' : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...args,
    Math.min(200, Math.max(1, limit)),
    Math.max(0, offset),
  ).map((t) => present(db, t));
}
