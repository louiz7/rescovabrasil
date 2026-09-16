import { reconcileDocumentTickets, documentTicketAllowsDelivery } from './document-tickets.mjs';
import { createWorkerLeases, boundedMap } from './worker-leases.mjs';
import { Router } from 'express';
import { id, now, one, all, run, transaction, event } from './db.mjs';
import { assert } from './domain.mjs';
import { createGmailTransport } from './email-transport.mjs';

const mailbox = 'louiz@rescova.de';
export function createEmailWorkflows(
  db,
  config,
  workflow,
  { transport = createGmailTransport(config) } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_bindings (
    conversation_id TEXT PRIMARY KEY REFERENCES agent_conversations(id), status TEXT NOT NULL,
    thread_id TEXT, subject TEXT NOT NULL, start_rowid INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_deliveries (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
    message_id TEXT NOT NULL UNIQUE REFERENCES agent_messages(id), subject TEXT NOT NULL, body TEXT NOT NULL,
    attachments_json TEXT NOT NULL, status TEXT NOT NULL, provider_message_id TEXT, rfc_message_id TEXT,
    thread_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_inbound_receipts (
    provider_message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const leases = createWorkerLeases(db, config);
  let active = null,
    closing = false,
    syncError = null;
  const router = Router();
  const enabled = () =>
    config.mode === 'demo' && config.agentWorkflowsEnabled && config.emailTestEnabled === true;
  function ready() {
    assert(enabled(), 'Enable EMAIL_TEST_ENABLED and agent workflows in demo mode first.', 409);
    assert(transport.status().configured, 'Configure Google Workspace OAuth first.', 409);
  }
  function eligible(conversationId) {
    const c = one(db, 'SELECT * FROM agent_conversations WHERE id=?', conversationId);
    assert(c, 'Conversation not found.', 404);
    const check = workflow.deliveryContext(conversationId);
    assert(!check.blocked, check.blocked || 'Case cannot receive email.', 409);
    assert(
      !one(db, 'SELECT 1 FROM suppressions WHERE address=?', mailbox),
      'Test mailbox is suppressed.',
      409,
    );
    return c;
  }
  function content(message, c) {
    const attachments = all(
      db,
      `SELECT d.* FROM agent_message_documents a
      JOIN case_documents d ON d.id=a.document_id WHERE a.message_id=? AND d.case_id=?`,
      message.id,
      c.case_id,
    ).map((d) => ({
      filename: `${d.kind}-v${d.version}.txt`,
      content: d.content,
      mimeType: 'text/plain',
      documentId: d.id,
    }));
    // External document release is restricted to generated fictional demo artifacts.
    assert(
      attachments.every((a) =>
        one(
          db,
          "SELECT 1 FROM case_documents WHERE id=? AND source='synthetic_demo'",
          a.documentId,
        ),
      ),
      'Only seeded fictional demo documents may be emailed in this test.',
      409,
    );
    return {
      subject: `[Rescova demo ${c.id.slice(0, 8)}] Your payment and document support`,
      text: `DEMO TEST — fictional case; no payment is requested.\n\n${message.body}\n\nReply to this email to continue the demo with Marina.`,
      attachments,
      recipient: mailbox,
    };
  }
  function preview(conversationId) {
    const c = eligible(conversationId);
    const message = one(
      db,
      "SELECT rowid AS sequence,* FROM agent_messages WHERE conversation_id=? AND direction='outbound' ORDER BY rowid DESC LIMIT 1",
      c.id,
    );
    assert(
      message,
      'Finish a demo call and wait for Marina’s first message before starting email.',
      409,
    );
    const result = content(message, c);
    return { ...result, messageId: message.id, sequence: message.sequence };
  }
  function enqueue(message, c) {
    if (!documentTicketAllowsDelivery(db, message.id)) return;
    const payload = content(message, c);
    const binding = one(db, 'SELECT * FROM email_bindings WHERE conversation_id=?', c.id);
    run(
      db,
      `INSERT OR IGNORE INTO email_deliveries
      (id,conversation_id,message_id,subject,body,attachments_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued',?,?)`,
      id(),
      c.id,
      message.id,
      binding.subject,
      payload.text,
      JSON.stringify(payload.attachments),
      now(),
      now(),
    );
  }
  function requestDelivery(conversationId) {
    assert(
      config.mode === 'demo' && config.agentWorkflowsEnabled,
      'Demo agent workflows are disabled.',
      409,
    );
    const c = eligible(conversationId);
    const existing = one(db, 'SELECT * FROM email_bindings WHERE conversation_id=?', c.id);
    const state =
      existing?.status === 'paused'
        ? 'paused'
        : enabled() && transport.status().configured
          ? 'active'
          : 'awaiting_configuration';
    const firstEmail = one(
      db,
      "SELECT MIN(rowid) n FROM agent_messages WHERE conversation_id=? AND direction='outbound' AND channel='email'",
      c.id,
    )?.n;
    const last =
      firstEmail != null
        ? firstEmail - 1
        : one(
            db,
            'SELECT COALESCE(MAX(rowid),0) n FROM agent_messages WHERE conversation_id=?',
            c.id,
          ).n;
    run(
      db,
      `INSERT INTO email_bindings VALUES (?,?,NULL,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET status=excluded.status`,
      c.id,
      state,
      `[Rescova demo ${c.id.slice(0, 8)}] Your payment and document support`,
      last,
      now(),
    );
    event(db, c.case_id, 'email_delivery_requested', {
      conversationId: c.id,
      recipient: mailbox,
      status: state,
      source: 'agent',
    });
    return {
      channel: 'email',
      status: state === 'active' ? 'queued' : state,
      reason:
        state === 'awaiting_configuration'
          ? 'Google Workspace email is not connected or enabled yet; the request is saved and will resume when available.'
          : state === 'paused'
            ? 'Email delivery is paused.'
            : null,
    };
  }
  async function start(conversationId) {
    ready();
    const p = preview(conversationId);
    await transport.verifyMailbox();
    const c = eligible(conversationId);
    transaction(db, () => {
      run(
        db,
        `INSERT INTO email_bindings VALUES (?,'active',NULL,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET status='active'`,
        c.id,
        p.subject,
        p.sequence - 1,
        now(),
      );
      workflow.setDeliveryChannel(c.id, 'email');
      run(db, "UPDATE agent_messages SET channel='email' WHERE id=?", p.messageId);
      enqueue(one(db, 'SELECT * FROM agent_messages WHERE id=?', p.messageId), c);
      event(db, c.case_id, 'email_test_activated', { conversationId: c.id, recipient: mailbox });
    });
    await tick();
    return status();
  }
  function pause(conversationId) {
    assert(
      one(db, 'SELECT 1 FROM email_bindings WHERE conversation_id=?', conversationId),
      'Email test not found.',
      404,
    );
    run(db, "UPDATE email_bindings SET status='paused' WHERE conversation_id=?", conversationId);
    // Keep channel context: resuming must not silently turn real-email work into virtual SMS.
    return status();
  }
  function status() {
    const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].filter(
      (_, i) => ![config.gmailClientId, config.gmailClientSecret, config.gmailRefreshToken][i],
    );
    return {
      configured: transport.status().configured,
      enabled: enabled(),
      sender: mailbox,
      recipient: mailbox,
      missing,
      syncError,
      conversations: all(
        db,
        `SELECT a.id,c.name AS caseName,a.status FROM agent_conversations a JOIN cases c ON c.id=a.case_id ORDER BY a.rowid DESC LIMIT 100`,
      ),
      bindings: all(
        db,
        'SELECT conversation_id AS conversationId,status,thread_id AS threadId FROM email_bindings',
      ),
      deliveries: all(
        db,
        `SELECT id,conversation_id AS conversationId,subject,status,error,created_at AS createdAt FROM email_deliveries ORDER BY rowid DESC LIMIT 100`,
      ),
    };
  }
  const headerAddress = (value) =>
    String(value || '')
      .match(/<([^>]+)>/)?.[1]
      ?.toLowerCase() ||
    String(value || '')
      .trim()
      .toLowerCase();
  function replyText(text) {
    // Quoted old offers and signatures must never count as fresh payment acceptance.
    return String(text || '')
      .split(/\n(?:On .+wrote:|Em .+escreveu:|Am .+schrieb.+:|>+|[- ]*Original Message[- ]*)/i)[0]
      .trim()
      .slice(0, 4000);
  }
  async function readReplies(binding, lease) {
    if (!binding.thread_id) return;
    const messages = await transport.getThread(binding.thread_id);
    lease.assertCurrent();
    const sent = all(
      db,
      'SELECT provider_message_id,rfc_message_id FROM email_deliveries WHERE conversation_id=?',
      binding.conversation_id,
    );
    const outboundIds = new Set(sent.map((s) => s.provider_message_id).filter(Boolean));
    const rfcIds = new Set(sent.map((s) => s.rfc_message_id).filter(Boolean));
    for (const message of messages) {
      if (one(db, 'SELECT 1 FROM email_inbound_receipts WHERE provider_message_id=?', message.id))
        continue;
      const own =
        message.ownDeliveryId || outboundIds.has(message.id) || rfcIds.has(message.messageId);
      const refs = `${message.inReplyTo || ''} ${Array.isArray(message.references) ? message.references.join(' ') : message.references || ''}`;
      const matched = [...rfcIds].some((ref) => refs.includes(ref));
      const text = replyText(message.text);
      if (
        own ||
        message.automatic ||
        headerAddress(message.from) !== mailbox ||
        !matched ||
        !text
      ) {
        run(
          db,
          'INSERT OR IGNORE INTO email_inbound_receipts VALUES (?,?,?,?)',
          message.id,
          binding.conversation_id,
          'ignored',
          now(),
        );
        continue;
      }
      if (text.length > 2000) {
        run(
          db,
          'INSERT OR IGNORE INTO email_inbound_receipts VALUES (?,?,?,?)',
          message.id,
          binding.conversation_id,
          'rejected_too_long',
          now(),
        );
        syncError =
          'A reply exceeded 2,000 characters. Send a shorter reply in the same Gmail thread.';
        continue;
      }
      const current = one(
        db,
        'SELECT status FROM email_bindings WHERE conversation_id=?',
        binding.conversation_id,
      );
      if (current.status !== 'active') return;
      transaction(db, () => {
        lease.assertCurrent();
        workflow.receiveInbound(binding.conversation_id, {
          text,
          requestId: `gmail_${message.id}`,
          channel: 'email',
        });
        run(
          db,
          'INSERT OR IGNORE INTO email_inbound_receipts VALUES (?,?,?,?)',
          message.id,
          binding.conversation_id,
          'received',
          now(),
        );
      });
    }
  }
  async function drain() {
    if (closing || config.mode !== 'demo' || !config.agentWorkflowsEnabled) return;
    for (const c of all(
      db,
      `SELECT a.id FROM agent_conversations a WHERE
      NOT EXISTS (SELECT 1 FROM email_bindings b WHERE b.conversation_id=a.id) AND
      (a.delivery_channel='email' OR EXISTS (SELECT 1 FROM agent_jobs j WHERE j.conversation_id=a.id AND j.delivery_channel='email')
      OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.conversation_id=a.id AND m.channel='email'))`,
    )) {
      try {
        requestDelivery(c.id);
      } catch {
        /* A stopped case must not activate contact. */
      }
    }
    if (!enabled() || !transport.status().configured) return;
    syncError = null;
    run(db, "UPDATE email_bindings SET status='active' WHERE status='awaiting_configuration'");
    try {
      await transport.verifyMailbox();
      await boundedMap(
        all(
          db,
          "SELECT b.*,c.case_id FROM email_bindings b JOIN agent_conversations c ON c.id=b.conversation_id WHERE b.status='active' ORDER BY b.rowid",
        ),
        Number(config.emailWorkerConcurrency) || 2,
        async (binding) => {
          if (closing) return;
          const lease = leases.acquire(`case:${binding.case_id}`);
          if (!lease) return;
          try {
            await readReplies(binding, lease);
          } catch {
            syncError =
              'Could not synchronize a test thread. Check connection and case status, then try again.';
          } finally {
            if (lease.valid())
              transaction(db, () => {
                lease.assertCurrent();
                reconcileDocumentTickets(db, binding.case_id);
              });
            lease.release();
          }
        },
      );
      await workflow.tick();
      await boundedMap(
        all(
          db,
          "SELECT b.*,c.case_id FROM email_bindings b JOIN agent_conversations c ON c.id=b.conversation_id WHERE b.status='active' ORDER BY b.rowid",
        ),
        Number(config.emailWorkerConcurrency) || 2,
        async (binding) => {
          const lease = leases.acquire(`case:${binding.case_id}`);
          if (!lease) return;
          try {
            // A previous send outlived its worker lease: never resend it automatically.
            run(
              db,
              "UPDATE email_deliveries SET status='uncertain',error='Worker lease expired during sending. Check Gmail before taking further action.',updated_at=? WHERE status='sending' AND conversation_id IN (SELECT id FROM agent_conversations WHERE case_id=?)",
              now(),
              binding.case_id,
            );
            reconcileDocumentTickets(db, binding.case_id);
            if (closing) return;
            let c;
            try {
              c = eligible(binding.conversation_id);
            } catch {
              const paused = one(
                db,
                `SELECT 1 FROM agent_conversations a
            JOIN cases c ON c.id=a.case_id LEFT JOIN portfolio_operations p ON p.portfolio_id=c.portfolio_id
            WHERE a.id=? AND (a.status='paused' OR p.status='paused')`,
                binding.conversation_id,
              );
              if (paused) return;
              run(
                db,
                "UPDATE email_deliveries SET status='cancelled',error='Case contact is blocked.',updated_at=? WHERE conversation_id=? AND status='queued'",
                now(),
                binding.conversation_id,
              );
              return;
            }
            for (const message of all(
              db,
              "SELECT * FROM agent_messages WHERE conversation_id=? AND direction='outbound' AND channel='email' AND rowid>? ORDER BY rowid",
              c.id,
              binding.start_rowid,
            )) {
              try {
                enqueue(message, c);
              } catch {
                syncError =
                  'A document is not eligible for external demo release. Check the case document source.';
              }
            }
            // An uncertain/failed send blocks later messages until the operator investigates.
            if (
              one(
                db,
                "SELECT 1 FROM email_deliveries WHERE conversation_id=? AND status IN ('uncertain','failed')",
                c.id,
              )
            )
              return;
            for (const delivery of all(
              db,
              "SELECT * FROM email_deliveries WHERE conversation_id=? AND status='queued' ORDER BY rowid LIMIT 10",
              c.id,
            )) {
              if (
                closing ||
                one(db, 'SELECT status FROM email_bindings WHERE conversation_id=?', c.id)
                  .status !== 'active'
              )
                break;
              try {
                eligible(c.id);
              } catch {
                break;
              }
              if (!documentTicketAllowsDelivery(db, delivery.message_id)) continue;
              const previous = one(
                db,
                "SELECT * FROM email_deliveries WHERE conversation_id=? AND status='submitted' ORDER BY rowid DESC LIMIT 1",
                c.id,
              );
              const claim = run(
                db,
                "UPDATE email_deliveries SET status='sending',updated_at=? WHERE id=? AND status='queued'",
                now(),
                delivery.id,
              );
              if (!claim.changes) continue;
              try {
                const result = await transport.send({
                  id: delivery.id,
                  subject: delivery.subject,
                  text: delivery.body,
                  attachments: JSON.parse(delivery.attachments_json),
                  threadId: previous?.thread_id,
                  beforeSend: () => {
                    lease.assertCurrent();
                    if (!documentTicketAllowsDelivery(db, delivery.message_id))
                      throw Object.assign(
                        new Error('Document ticket no longer permits delivery.'),
                        { localCancel: true },
                      );
                    const bindingActive =
                      one(db, 'SELECT status FROM email_bindings WHERE conversation_id=?', c.id)
                        ?.status === 'active';
                    const currentConversation = one(
                      db,
                      'SELECT status FROM agent_conversations WHERE id=?',
                      c.id,
                    );
                    if (closing || !bindingActive || currentConversation?.status === 'paused') {
                      throw Object.assign(new Error('Email delivery paused.'), { localHold: true });
                    }
                    try {
                      eligible(c.id);
                    } catch {
                      throw Object.assign(new Error('Case blocked before sending.'), {
                        localCancel: true,
                      });
                    }
                  },
                  inReplyTo: previous?.rfc_message_id,
                  references: previous?.rfc_message_id ? [previous.rfc_message_id] : [],
                });
                transaction(db, () => {
                  lease.assertCurrent();
                  run(
                    db,
                    "UPDATE email_deliveries SET status='submitted',provider_message_id=?,rfc_message_id=?,thread_id=?,updated_at=? WHERE id=?",
                    result.providerMessageId,
                    result.messageId,
                    result.threadId,
                    now(),
                    delivery.id,
                  );
                  run(
                    db,
                    'UPDATE email_bindings SET thread_id=? WHERE conversation_id=?',
                    result.threadId,
                    c.id,
                  );
                  reconcileDocumentTickets(db, c.case_id);
                  event(db, c.case_id, 'email_submitted', {
                    deliveryId: delivery.id,
                    messageId: delivery.message_id,
                    recipient: mailbox,
                  });
                });
              } catch (error) {
                if (!lease.valid()) return;
                if (error.localHold || error.localCancel) {
                  run(
                    db,
                    'UPDATE email_deliveries SET status=?,error=?,updated_at=? WHERE id=?',
                    error.localHold ? 'queued' : 'cancelled',
                    error.localHold ? null : 'Case contact is blocked.',
                    now(),
                    delivery.id,
                  );
                  break;
                }
                run(
                  db,
                  'UPDATE email_deliveries SET status=?,error=?,updated_at=? WHERE id=?',
                  error.uncertain ? 'uncertain' : 'failed',
                  error.uncertain
                    ? 'Sending outcome is uncertain. Check Gmail; this message will not be automatically resent.'
                    : 'Gmail rejected this attempt. Check OAuth configuration and mailbox permissions.',
                  now(),
                  delivery.id,
                );
                break;
              }
            }
          } finally {
            if (lease.valid())
              transaction(db, () => {
                lease.assertCurrent();
                reconcileDocumentTickets(db, binding.case_id);
              });
            lease.release();
          }
        },
      );
    } catch {
      syncError =
        'Google Workspace connection failed. Check OAuth configuration and mailbox permissions.';
    }
  }
  function tick() {
    if (!active)
      active = drain().finally(() => {
        active = null;
      });
    return active;
  }
  router.get('/', (_req, res) => res.json(status()));
  router.post('/preview', (req, res) => {
    const p = preview(req.body.conversationId);
    res.json({ ...p, attachments: p.attachments.map(({ filename }) => ({ filename })) });
  });
  router.post('/start', async (req, res, next) => {
    try {
      res.json(await start(req.body.conversationId));
    } catch (e) {
      next(e);
    }
  });
  router.post('/pause', (req, res) => res.json(pause(req.body.conversationId)));
  router.post('/sync', async (_req, res, next) => {
    try {
      ready();
      await tick();
      res.json(status());
    } catch (e) {
      next(e);
    }
  });
  return {
    router,
    requestDelivery,
    tick,
    status,
    preview,
    start,
    pause,
    async closeAll() {
      closing = true;
      if (active) await active;
    },
  };
}
