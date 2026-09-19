import { createHash } from 'node:crypto';
import {
  createDecisionEngine,
  ESCALATION_ROUTING_VERSION,
  INBOUND_TRIAGE_VERSION,
} from './decision-engine.mjs';
import { all, id, now, one, run } from './db.mjs';

const PURPOSE = 'inbound_message_triage';
const SHADOW_POLICY_VERSION = 'shadow-observe-only-v1';
const ACTIVE_POLICY_VERSION = 'active-advisory-v1';
const safeError = (error) => String(error?.message || 'Decision evaluation failed.').slice(0, 500);

function inputHash(message, evidence) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        messageId: message.id,
        text: message.body,
        channel: message.channel,
        evidence,
        questionSet: INBOUND_TRIAGE_VERSION,
      }),
    )
    .digest('hex');
}

export function createDecisionRuns(
  db,
  config,
  { engine, evaluateDecision, evaluateEscalationDecision } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS decision_runs (
    id TEXT PRIMARY KEY, purpose TEXT NOT NULL, question_set TEXT NOT NULL, policy_version TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT, case_id TEXT NOT NULL REFERENCES cases(id),
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
    message_id TEXT NOT NULL REFERENCES agent_messages(id), input_hash TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, answers_json TEXT,
    proposed_route TEXT, applied_route TEXT, usage_json TEXT, latency_ms INTEGER,
    error TEXT, outcome_label TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
    UNIQUE(message_id,purpose,question_set));
    CREATE INDEX IF NOT EXISTS decision_runs_status ON decision_runs(status,created_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS decision_role_runs (
    id TEXT PRIMARY KEY, purpose TEXT NOT NULL, question_set TEXT NOT NULL, policy_version TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT, case_id TEXT NOT NULL REFERENCES cases(id),
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id), job_id TEXT NOT NULL UNIQUE,
    input_hash TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL,
    answers_json TEXT, proposed_route TEXT, applied_route TEXT, usage_json TEXT,
    latency_ms INTEGER, error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS decision_role_runs_status ON decision_role_runs(status,created_at);`);
  if (!all(db, 'PRAGMA table_info(decision_runs)').some((column) => column.name === 'started_at'))
    db.exec('ALTER TABLE decision_runs ADD COLUMN started_at TEXT');
  if (
    !all(db, 'PRAGMA table_info(decision_runs)').some((column) => column.name === 'policy_version')
  )
    db.exec(
      `ALTER TABLE decision_runs ADD COLUMN policy_version TEXT NOT NULL DEFAULT '${SHADOW_POLICY_VERSION}'`,
    );
  if (
    !all(db, 'PRAGMA table_info(decision_runs)').some((column) => column.name === 'outcome_label')
  )
    db.exec('ALTER TABLE decision_runs ADD COLUMN outcome_label TEXT');
  if (
    !all(db, 'PRAGMA table_info(decision_runs)').some((column) => column.name === 'evidence_json')
  )
    db.exec("ALTER TABLE decision_runs ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}'");

  const mode = config.typeSafeDecisionMode || (config.typeSafeShadowEnabled ? 'shadow' : 'off');
  const enabled = mode !== 'off';
  const activeMode = mode === 'active';
  const policyVersion = activeMode ? ACTIVE_POLICY_VERSION : SHADOW_POLICY_VERSION;
  const decisionEngine =
    engine ||
    (evaluateDecision
      ? {
          provider: config.decisionProvider || 'typesafe',
          available: true,
          evaluateInboundTriage: evaluateDecision,
          evaluateEscalationRouting:
            evaluateEscalationDecision ||
            (async () => {
              throw new Error('Escalation decision evaluator is not configured.');
            }),
        }
      : enabled
        ? createDecisionEngine(config)
        : { provider: config.decisionProvider || 'typesafe', available: false });
  let active = null;
  let closing = false;

  function compactEvidence(row) {
    return {
      message: {
        channel: row.channel === 'virtual_sms' ? 'sms' : row.channel,
        language: row.language || 'pt-BR',
      },
      case: {
        status: row.case_status,
        currency: row.currency,
        hasAcceptedAgreement: Boolean(row.agreement_id),
        presentedOfferCount: Number(row.presented_offer_count || 0),
        suppressed: Boolean(row.suppressed),
      },
      capabilities: [
        'answer_case_question',
        'present_payment_options',
        'accept_presented_offer',
        'retrieve_document',
      ],
    };
  }

  function stateFor(message, evidence) {
    return {
      ...evidence,
      message: { ...evidence.message, text: message.body },
    };
  }

  function source(messageId) {
    return one(
      db,
      `SELECT m.id,m.body,m.channel,c.id conversation_id,c.case_id,c.agreement_id,
        k.language,k.currency,k.status case_status,k.suppressed,
        (SELECT COUNT(*) FROM agent_presented_offers o WHERE o.conversation_id=c.id) presented_offer_count
      FROM agent_messages m JOIN agent_conversations c ON c.id=m.conversation_id
      JOIN cases k ON k.id=c.case_id WHERE m.id=? AND m.direction='inbound'`,
      messageId,
    );
  }

  function queueInbound({ messageId, conversationId, caseId }) {
    if (!enabled) return null;
    const message = source(messageId);
    if (!message) return null;
    const evidence = compactEvidence(message);
    const runId = id();
    run(
      db,
      `INSERT OR IGNORE INTO decision_runs
      (id,purpose,question_set,policy_version,provider,case_id,conversation_id,message_id,input_hash,evidence_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      runId,
      PURPOSE,
      INBOUND_TRIAGE_VERSION,
      policyVersion,
      decisionEngine.provider,
      caseId,
      conversationId,
      messageId,
      inputHash(message, evidence),
      JSON.stringify(evidence),
      decisionEngine.available ? 'queued' : 'unavailable',
      now(),
    );
    if (!decisionEngine.available)
      run(
        db,
        "UPDATE decision_runs SET error='TypeSafe decision provider is not configured.',completed_at=? WHERE id=?",
        now(),
        runId,
      );
    return one(
      db,
      'SELECT * FROM decision_runs WHERE message_id=? AND purpose=? AND question_set=?',
      messageId,
      PURPOSE,
      INBOUND_TRIAGE_VERSION,
    );
  }

  async function process(record) {
    if (
      !run(
        db,
        "UPDATE decision_runs SET status='running',attempts=attempts+1,error=NULL,started_at=? WHERE id=? AND status='queued'",
        now(),
        record.id,
      ).changes
    )
      return;
    try {
      const message = source(record.message_id);
      if (!message) throw new Error('Inbound message source is unavailable.');
      const evidence = JSON.parse(record.evidence_json);
      const state = stateFor(message, evidence);
      if (inputHash(message, evidence) !== record.input_hash)
        throw new Error('Decision input changed after the run was queued.');
      const result = await decisionEngine.evaluateInboundTriage(state);
      run(
        db,
        `UPDATE decision_runs SET status='completed',model=?,answers_json=?,proposed_route=?,
        applied_route=NULL,usage_json=?,latency_ms=?,error=NULL,completed_at=? WHERE id=?`,
        result.model,
        JSON.stringify(result.answers),
        JSON.stringify(result.proposedRoute),
        JSON.stringify(result.usage || null),
        result.latencyMs ?? null,
        now(),
        record.id,
      );
    } catch (error) {
      run(
        db,
        "UPDATE decision_runs SET status='failed',error=?,completed_at=? WHERE id=?",
        safeError(error),
        now(),
        record.id,
      );
    }
  }

  async function drain() {
    if (closing || !enabled) return;
    // Reclaim only expired work. Another worker may still own a fresh request.
    run(
      db,
      "UPDATE decision_runs SET status='queued',started_at=NULL WHERE status='running' AND completed_at IS NULL AND (started_at IS NULL OR started_at<?)",
      new Date(Date.now() - Math.max(60000, (config.typeSafeTimeoutMs || 10000) * 3)).toISOString(),
    );
    const budget = Math.max(1, Math.min(100, Number(config.workerBatchSize) || 40));
    for (const record of all(
      db,
      "SELECT * FROM decision_runs WHERE status='queued' ORDER BY created_at,rowid LIMIT ?",
      budget,
    )) {
      if (closing) break;
      await process(record);
    }
  }

  return {
    mode,
    enabled,
    activeMode,
    queueInbound,
    consumeInbound(messageId) {
      if (!activeMode) return { ready: true, hint: null };
      const record = one(
        db,
        'SELECT * FROM decision_runs WHERE message_id=? AND purpose=? AND question_set=?',
        messageId,
        PURPOSE,
        INBOUND_TRIAGE_VERSION,
      );
      if (!record || ['queued', 'running'].includes(record.status)) return { ready: false };
      if (record.status !== 'completed') {
        const applied = { route: 'marina_fallback', reason: 'decision_unavailable' };
        run(
          db,
          'UPDATE decision_runs SET applied_route=COALESCE(applied_route,?) WHERE id=?',
          JSON.stringify(applied),
          record.id,
        );
        return { ready: true, hint: applied };
      }
      const proposed = JSON.parse(record.proposed_route);
      const answers = JSON.parse(record.answers_json);
      const accepted = proposed.confidence >= (config.typeSafeActiveMinConfidence ?? 0.75);
      const applied = {
        route: accepted ? proposed.route : 'marina_fallback',
        proposedRoute: proposed.route,
        confidence: proposed.confidence,
        threshold: config.typeSafeActiveMinConfidence ?? 0.75,
        contextRoute: proposed.contextRoute,
        contextConfidence: proposed.contextConfidence,
        flags: Object.fromEntries(
          Object.entries(answers)
            .filter(([, answer]) => answer.type === 'noul')
            .map(([key, answer]) => [key, answer.noul]),
        ),
      };
      run(
        db,
        'UPDATE decision_runs SET applied_route=COALESCE(applied_route,?) WHERE id=?',
        JSON.stringify(applied),
        record.id,
      );
      return { ready: true, hint: applied };
    },
    async routeEscalation({ jobId, conversationId, caseId, reason, context = {} }) {
      if (!activeMode) return { route: 'supervisor_reasoning', reason: 'decision_mode_not_active' };
      let record = one(db, 'SELECT * FROM decision_role_runs WHERE job_id=?', jobId);
      if (record?.status === 'completed') return JSON.parse(record.applied_route);
      if (record?.status === 'failed')
        return { route: 'supervisor_reasoning', reason: 'decision_unavailable' };
      const evidence = {
        escalation: { reason: String(reason || '').slice(0, 1000) },
        case: {
          outcome: context.outcome || null,
          hasAgreement: Boolean(context.agreement),
          presentedOfferCount: context.presentedOffers?.length || 0,
          missingDocument: context.missingDocument || null,
          paymentReported: Boolean(context.paymentReported),
          caseRestriction: context.caseRestriction || null,
        },
        capabilities: [
          'payment_verification_wait',
          'document_evidence_wait',
          'missing_information_wait',
          'policy_block',
          'supervisor_reasoning',
        ],
      };
      const hash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
      if (!record) {
        run(
          db,
          `INSERT OR IGNORE INTO decision_role_runs
          (id,purpose,question_set,policy_version,provider,case_id,conversation_id,job_id,input_hash,evidence_json,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          id(),
          'escalation_routing',
          ESCALATION_ROUTING_VERSION,
          ACTIVE_POLICY_VERSION,
          decisionEngine.provider,
          caseId,
          conversationId,
          jobId,
          hash,
          JSON.stringify(evidence),
          decisionEngine.available ? 'queued' : 'failed',
          now(),
        );
        record = one(db, 'SELECT * FROM decision_role_runs WHERE job_id=?', jobId);
      }
      if (!decisionEngine.available || !record)
        return { route: 'supervisor_reasoning', reason: 'decision_unavailable' };
      if (record.input_hash !== hash)
        return { route: 'supervisor_reasoning', reason: 'decision_input_changed' };
      if (
        !run(
          db,
          "UPDATE decision_role_runs SET status='running',started_at=?,error=NULL WHERE id=? AND status='queued'",
          now(),
          record.id,
        ).changes
      )
        return { route: 'supervisor_reasoning', reason: 'decision_in_progress' };
      try {
        const result = await decisionEngine.evaluateEscalationRouting(evidence);
        const accepted =
          result.proposedRoute.confidence >= (config.typeSafeActiveMinConfidence ?? 0.75) &&
          result.proposedRoute.requiresSupervisorProbability < 0.5 &&
          result.proposedRoute.route !== 'supervisor_reasoning';
        const applied = {
          route: accepted ? result.proposedRoute.route : 'supervisor_reasoning',
          proposedRoute: result.proposedRoute.route,
          confidence: result.proposedRoute.confidence,
          requiresSupervisorProbability: result.proposedRoute.requiresSupervisorProbability,
          threshold: config.typeSafeActiveMinConfidence ?? 0.75,
        };
        run(
          db,
          `UPDATE decision_role_runs SET status='completed',model=?,answers_json=?,proposed_route=?,
          applied_route=?,usage_json=?,latency_ms=?,completed_at=? WHERE id=?`,
          result.model,
          JSON.stringify(result.answers),
          JSON.stringify(result.proposedRoute),
          JSON.stringify(applied),
          JSON.stringify(result.usage || null),
          result.latencyMs ?? null,
          now(),
          record.id,
        );
        return applied;
      } catch (error) {
        run(
          db,
          "UPDATE decision_role_runs SET status='failed',error=?,completed_at=? WHERE id=?",
          safeError(error),
          now(),
          record.id,
        );
        return { route: 'supervisor_reasoning', reason: 'decision_unavailable' };
      }
    },
    statsFor(role) {
      const table = role === 'resolution_router' ? 'decision_role_runs' : 'decision_runs';
      const where = role === 'resolution_router' ? "purpose='escalation_routing'" : '1=1';
      return {
        queued: one(db, `SELECT COUNT(*) n FROM ${table} WHERE ${where} AND status='queued'`).n,
        running: one(db, `SELECT COUNT(*) n FROM ${table} WHERE ${where} AND status='running'`).n,
        failed: one(
          db,
          `SELECT COUNT(*) n FROM ${table} WHERE ${where} AND status IN ('failed','unavailable')`,
        ).n,
        completed: one(db, `SELECT COUNT(*) n FROM ${table} WHERE ${where} AND status='completed'`)
          .n,
        lastRuns: all(
          db,
          `SELECT id,conversation_id,status,model,provider,usage_json,created_at,completed_at FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT 20`,
        ),
      };
    },
    drain() {
      if (!active)
        active = drain().finally(() => {
          active = null;
        });
      return active;
    },
    list(limit = 100) {
      return all(
        db,
        `SELECT d.id,d.purpose,d.question_set,d.policy_version,d.provider,d.model,d.case_id,d.conversation_id,
          d.message_id,d.status,d.attempts,d.evidence_json,d.answers_json,d.proposed_route,d.applied_route,
          d.usage_json,d.latency_ms,d.error,d.outcome_label,d.created_at,d.completed_at,k.reference case_reference
        FROM decision_runs d JOIN cases k ON k.id=d.case_id
        ORDER BY d.created_at DESC,d.rowid DESC LIMIT ?`,
        Math.max(1, Math.min(500, Number(limit) || 100)),
      ).map((row) => ({
        id: row.id,
        purpose: row.purpose,
        questionSet: row.question_set,
        policyVersion: row.policy_version,
        provider: row.provider,
        model: row.model,
        caseId: row.case_id,
        caseReference: row.case_reference,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        status: row.status,
        attempts: row.attempts,
        evidence: JSON.parse(row.evidence_json),
        answers: row.answers_json ? JSON.parse(row.answers_json) : null,
        proposedRoute: row.proposed_route ? JSON.parse(row.proposed_route) : null,
        appliedRoute: row.applied_route,
        usage: row.usage_json ? JSON.parse(row.usage_json) : null,
        latencyMs: row.latency_ms,
        error: row.error,
        outcomeLabel: row.outcome_label,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      }));
    },
    stats() {
      return one(
        db,
        `SELECT COUNT(*) total,
          SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
          SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
          SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
          SUM(CASE WHEN status IN ('failed','unavailable') THEN 1 ELSE 0 END) failed
        FROM decision_runs`,
      );
    },
    async close() {
      closing = true;
      if (active) await active;
    },
  };
}
