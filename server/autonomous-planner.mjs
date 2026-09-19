import { createHash } from 'node:crypto';
import { CASE_ACTION_VERSION, createDecisionEngine } from './decision-engine.mjs';
import { all, event, id, now, one, run } from './db.mjs';
import { assert } from './domain.mjs';
import { policy, suppress } from './service.mjs';

const contactActions = new Set(['call', 'send_sms', 'send_email']);
const ownerFor = {
  call: 'Clara',
  send_sms: 'Marina',
  send_email: 'Marina',
  continue_conversation: 'Marina',
  fulfill_document: 'Helena',
  reason_case: 'Rafael',
  wait_payment_verification: 'Tiago',
  await_information: 'Tiago',
};
const channelFor = { call: 'voice', send_sms: 'sms', send_email: 'email' };

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function ensureAutonomyTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_runs (
    id TEXT PRIMARY KEY,portfolio_id TEXT NOT NULL REFERENCES portfolios(id),trigger TEXT NOT NULL,
    status TEXT NOT NULL,scanned INTEGER NOT NULL DEFAULT 0,planned INTEGER NOT NULL DEFAULT 0,
    executed INTEGER NOT NULL DEFAULT 0,waiting INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT,created_at TEXT NOT NULL,completed_at TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_decisions (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES autonomy_runs(id),case_id TEXT NOT NULL REFERENCES cases(id),
    purpose TEXT NOT NULL,question_set TEXT NOT NULL,provider TEXT,model TEXT,status TEXT NOT NULL,
    state_hash TEXT NOT NULL,evidence_json TEXT NOT NULL,answers_json TEXT,proposed_action TEXT,
    applied_action TEXT,usage_json TEXT,latency_ms INTEGER,error TEXT,created_at TEXT NOT NULL,completed_at TEXT);
    CREATE TABLE IF NOT EXISTS autonomy_tasks (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES autonomy_runs(id),portfolio_id TEXT NOT NULL REFERENCES portfolios(id),
    case_id TEXT NOT NULL REFERENCES cases(id),parent_task_id TEXT REFERENCES autonomy_tasks(id),kind TEXT NOT NULL,
    owner TEXT NOT NULL,channel TEXT,status TEXT NOT NULL,goal TEXT NOT NULL,reason TEXT NOT NULL,
    due_at TEXT NOT NULL,state_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,decision_id TEXT,
    attempt_id TEXT,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS autonomy_tasks_due ON autonomy_tasks(status,due_at);
    CREATE TABLE IF NOT EXISTS autonomy_actions (
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES autonomy_tasks(id),kind TEXT NOT NULL,channel TEXT,
    status TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,result_json TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_mock_profiles (
    case_id TEXT PRIMARY KEY REFERENCES cases(id),outcome TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_schedules (
    portfolio_id TEXT PRIMARY KEY REFERENCES portfolios(id),last_planned_at TEXT,next_planned_at TEXT NOT NULL);`);
}

export function ensureAutonomyDemoPortfolio(db) {
  ensureAutonomyTables(db);
  const stored = one(db, "SELECT value FROM settings WHERE key='autonomy_demo_portfolio'");
  if (stored && one(db, 'SELECT id FROM portfolios WHERE id=?', stored.value)) {
    repairMockAttemptOutcomes(db);
    return stored.value;
  }
  const portfolioId = id();
  run(
    db,
    'INSERT INTO portfolios VALUES (?,?,?,?,?)',
    portfolioId,
    'Autonomous collections demo',
    'Rescova-owned demo receivables',
    'America/Sao_Paulo',
    now(),
  );
  const profiles = [
    ['AUTO-001', 'Ana Ribeiro', '+5511999010001', 'ana.ribeiro@example.invalid', 'no_response'],
    ['AUTO-002', 'Bruno Costa', '+5511999010002', 'bruno.costa@example.invalid', 'payment_options'],
    ['AUTO-003', 'Carla Mendes', '+5511999010003', null, 'callback'],
    ['AUTO-004', 'Daniel Souza', null, 'daniel.souza@example.invalid', 'document_request'],
    ['AUTO-005', 'Elisa Rocha', '+5511999010005', 'elisa.rocha@example.invalid', 'dispute'],
    ['AUTO-006', 'Fabio Lima', '+5511999010006', 'fabio.lima@example.invalid', 'wrong_person'],
    ['AUTO-007', 'Gabriela Alves', null, null, 'missing_contact'],
  ];
  for (const [index, [reference, name, phone, email, outcome]] of profiles.entries()) {
    const caseId = id();
    run(
      db,
      `INSERT INTO cases (id,portfolio_id,reference,name,phone,email,amount_minor,currency,due_date,timezone,language,source_import,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      caseId,
      portfolioId,
      reference,
      name,
      phone,
      email,
      75000 + index * 12500,
      'BRL',
      '2026-06-15',
      'America/Sao_Paulo',
      'pt-BR',
      'autonomy_mock',
      now(),
    );
    run(db, 'INSERT INTO autonomy_mock_profiles VALUES (?,?)', caseId, outcome);
    event(db, caseId, 'imported', 'Synthetic autonomous-planner demo case.', 'demo');
  }
  run(db, "INSERT OR REPLACE INTO settings VALUES ('autonomy_demo_portfolio',?)", portfolioId);
  return portfolioId;
}

function repairMockAttemptOutcomes(db) {
  const mappings = {
    payment_options: 'willing_to_pay',
    callback: 'callback',
    document_request: 'document_request',
    dispute: 'disputed',
  };
  for (const [profile, outcome] of Object.entries(mappings))
    run(
      db,
      `UPDATE attempts SET outcome=?,updated_at=? WHERE outcome IS NULL AND
       message='Autonomous demo action — no external communication.' AND
       case_id IN (SELECT case_id FROM autonomy_mock_profiles WHERE outcome=?)`,
      outcome,
      now(),
      profile,
    );
}

function caseSnapshot(db, c, operation) {
  const attempts = all(
    db,
    'SELECT channel,status,outcome,created_at FROM attempts WHERE case_id=? ORDER BY created_at DESC',
    c.id,
  );
  return {
    case: {
      id: c.id,
      status: c.status,
      outcome: c.outcome,
      suppressed: Boolean(c.suppressed),
      reviewRequired: Boolean(c.review_required),
      hasPhone: Boolean(c.phone),
      hasEmail: Boolean(c.email),
      dueDate: c.due_date,
      language: c.language,
      timezone: c.timezone,
    },
    portfolio: { status: operation.status, channels: JSON.parse(operation.channels) },
    attempts,
  };
}

function contactCandidates(snapshot) {
  const c = snapshot.case;
  return snapshot.portfolio.channels.flatMap((channel) => {
    if (channel === 'voice' && c.hasPhone) return ['call'];
    if (channel === 'sms' && c.hasPhone) return ['send_sms'];
    if (channel === 'email' && c.hasEmail) return ['send_email'];
    return [];
  });
}

function candidatePlan(db, c, operation, at, simulate) {
  const snapshot = caseSnapshot(db, c, operation);
  const stateHash = hash(snapshot);
  const latest = one(
    db,
    `SELECT status,state_hash FROM autonomy_tasks WHERE case_id=?
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    c.id,
  );
  if (
    latest?.state_hash === stateHash &&
    ['queued', 'running', 'waiting', 'scheduled', 'completed'].includes(latest.status)
  )
    return { snapshot, stateHash, skip: 'Current case state is already covered by a task.' };
  if (c.suppressed || ['opt_out', 'invalid_contact'].includes(c.outcome))
    return { snapshot, stateHash, skip: 'Contact is suppressed.' };
  if (c.outcome === 'paid_reported')
    return {
      snapshot,
      stateHash,
      actions: ['wait_payment_verification'],
      reason: 'Payment was reported but has no verified provider evidence.',
    };
  if (c.outcome === 'disputed' || c.outcome === 'human_review')
    return {
      snapshot,
      stateHash,
      actions: ['reason_case'],
      reason: 'Case contains an unresolved dispute or exception.',
    };
  if (['willing_to_pay', 'unable_to_pay'].includes(c.outcome))
    return {
      snapshot,
      stateHash,
      actions: ['continue_conversation'],
      reason: 'Participant response requires a contextual written follow-up.',
    };
  if (c.outcome === 'callback')
    return {
      snapshot,
      stateHash,
      actions: c.phone ? ['call'] : ['await_information'],
      reason: 'Participant requested a callback.',
    };
  const contacts = contactCandidates(snapshot);
  if (!contacts.length)
    return {
      snapshot,
      stateHash,
      actions: ['await_information'],
      reason: 'No permitted channel has usable contact details.',
    };
  const p = policy(db);
  if (snapshot.attempts.length >= p.maxAttempts)
    return { snapshot, stateHash, skip: 'Attempt limit reached.' };
  if (!simulate && snapshot.attempts.length) {
    const next = new Date(
      new Date(snapshot.attempts[0].created_at).getTime() + p.gapHours * 3600000,
    );
    if (next > at)
      return {
        snapshot,
        stateHash,
        skip: 'Contact gap is still active.',
        nextDueAt: next.toISOString(),
      };
  }
  return {
    snapshot,
    stateHash,
    actions: [...new Set(contacts)],
    reason:
      c.outcome === 'not_reached'
        ? 'Previous outreach was not reached.'
        : 'Case is ready for first outreach.',
  };
}

function goalFor(action) {
  return {
    call: 'Reach the participant by AI phone call and record a structured outcome.',
    send_sms: 'Start or continue the case conversation by SMS.',
    send_email: 'Start or continue the case conversation by email.',
    continue_conversation: 'Continue the existing conversation using current case context.',
    fulfill_document: 'Retrieve and provide the requested case document.',
    reason_case: 'Resolve the case exception from authoritative evidence.',
    wait_payment_verification: 'Wait for authoritative payment-provider evidence.',
    await_information: 'Wait for the missing information required for further action.',
  }[action];
}

function addTask(db, values) {
  const taskId = id();
  const stamp = now();
  const result = run(
    db,
    `INSERT OR IGNORE INTO autonomy_tasks
    (id,run_id,portfolio_id,case_id,parent_task_id,kind,owner,channel,status,goal,reason,due_at,state_hash,idempotency_key,decision_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    taskId,
    values.runId,
    values.portfolioId,
    values.caseId,
    values.parentTaskId || null,
    values.action,
    ownerFor[values.action],
    channelFor[values.action] || null,
    values.status || 'queued',
    goalFor(values.action),
    values.reason,
    values.dueAt || stamp,
    values.stateHash,
    values.key,
    values.decisionId || null,
    stamp,
    stamp,
  );
  return result.changes ? one(db, 'SELECT * FROM autonomy_tasks WHERE id=?', taskId) : null;
}

function safeError(error) {
  return String(error?.message || error || 'Unknown decision error').slice(0, 500);
}

export function createAutonomousPlanner(db, config, { evaluateDecision } = {}) {
  ensureAutonomyTables(db);
  const decisionEngine = evaluateDecision
    ? { available: true, evaluateCaseAction: evaluateDecision }
    : createDecisionEngine(config);
  const activeDecision = config.typeSafeDecisionMode === 'active' && decisionEngine.available;

  async function choose(runId, c, plan) {
    if (plan.actions.length === 1)
      return { action: plan.actions[0], reason: 'Only one permitted action.', decisionId: null };
    if (!activeDecision)
      return {
        action: plan.actions[0],
        reason: 'Decision provider unavailable; channel order fallback.',
        decisionId: null,
      };
    const decisionId = id();
    run(
      db,
      `INSERT INTO autonomy_decisions
      (id,run_id,case_id,purpose,question_set,status,state_hash,evidence_json,created_at)
      VALUES (?,?,?,?,?,'running',?,?,?)`,
      decisionId,
      runId,
      c.id,
      'case_next_action',
      CASE_ACTION_VERSION,
      plan.stateHash,
      JSON.stringify({ ...plan.snapshot, allowedActions: plan.actions }),
      now(),
    );
    try {
      const result = await decisionEngine.evaluateCaseAction({
        ...plan.snapshot,
        allowedActions: plan.actions,
        instruction: 'Choose only an action listed in allowedActions.',
      });
      const proposed = result.proposedAction;
      const accepted =
        plan.actions.includes(proposed.action) &&
        proposed.confidence >= (config.typeSafeActiveMinConfidence ?? 0.75);
      const applied = accepted ? proposed.action : plan.actions[0];
      run(
        db,
        `UPDATE autonomy_decisions SET provider=?,model=?,status='completed',answers_json=?,proposed_action=?,
        applied_action=?,usage_json=?,latency_ms=?,completed_at=? WHERE id=?`,
        result.provider,
        result.model,
        JSON.stringify(result.answers),
        proposed.action,
        applied,
        JSON.stringify(result.usage || null),
        result.latencyMs ?? null,
        now(),
        decisionId,
      );
      return {
        action: applied,
        decisionId,
        reason: accepted
          ? `Jev selected ${applied} from permitted actions.`
          : 'Low-confidence or invalid choice; channel order fallback.',
      };
    } catch (error) {
      run(
        db,
        "UPDATE autonomy_decisions SET status='failed',error=?,completed_at=? WHERE id=?",
        safeError(error),
        now(),
        decisionId,
      );
      return {
        action: plan.actions[0],
        decisionId,
        reason: 'Decision failed; channel order fallback.',
      };
    }
  }

  async function planPortfolio(
    portfolioId,
    { trigger = 'manual', at = new Date(), simulate = false } = {},
  ) {
    const portfolio = one(db, 'SELECT * FROM portfolios WHERE id=?', portfolioId);
    assert(portfolio, 'Portfolio not found.', 404);
    const operation = one(
      db,
      'SELECT * FROM portfolio_operations WHERE portfolio_id=?',
      portfolioId,
    );
    assert(
      operation?.status === 'active',
      'Activate the portfolio before running its planner.',
      409,
    );
    const runId = id();
    run(
      db,
      "INSERT INTO autonomy_runs (id,portfolio_id,trigger,status,created_at) VALUES (?,?,?,'running',?)",
      runId,
      portfolioId,
      trigger,
      now(),
    );
    let planned = 0,
      skipped = 0;
    const cases = all(
      db,
      'SELECT * FROM cases WHERE portfolio_id=? ORDER BY reference LIMIT 200',
      portfolioId,
    );
    for (const c of cases) {
      const candidate = candidatePlan(db, c, operation, at, simulate);
      if (candidate.skip) {
        skipped++;
        continue;
      }
      const selected = await choose(runId, c, candidate);
      const current = one(db, 'SELECT * FROM cases WHERE id=?', c.id);
      const fresh = candidatePlan(db, current, operation, at, simulate);
      if (fresh.stateHash !== candidate.stateHash) {
        skipped++;
        continue;
      }
      const task = addTask(db, {
        runId,
        portfolioId,
        caseId: c.id,
        action: selected.action,
        reason: `${candidate.reason} ${selected.reason}`,
        stateHash: candidate.stateHash,
        key: `plan:${c.id}:${candidate.stateHash}:${selected.action}`,
        decisionId: selected.decisionId,
        status: ['await_information', 'wait_payment_verification'].includes(selected.action)
          ? 'waiting'
          : 'queued',
      });
      if (task) {
        planned++;
        event(
          db,
          c.id,
          'autonomy_task_created',
          { taskId: task.id, action: task.kind, owner: task.owner, reason: task.reason },
          'Mateo',
        );
      } else skipped++;
    }
    const nextPlannedAt = new Date(at.getTime() + 24 * 3600000).toISOString();
    run(
      db,
      `INSERT INTO autonomy_schedules VALUES (?,?,?) ON CONFLICT(portfolio_id) DO UPDATE SET
      last_planned_at=excluded.last_planned_at,next_planned_at=excluded.next_planned_at`,
      portfolioId,
      at.toISOString(),
      nextPlannedAt,
    );
    run(
      db,
      "UPDATE autonomy_runs SET scanned=?,planned=?,skipped=?,status='planned',completed_at=? WHERE id=?",
      cases.length,
      planned,
      skipped,
      now(),
      runId,
    );
    return one(db, 'SELECT * FROM autonomy_runs WHERE id=?', runId);
  }

  function childTask(parent, action, reason, status = 'queued', dueAt = now()) {
    const c = one(db, 'SELECT * FROM cases WHERE id=?', parent.case_id);
    const operation = one(
      db,
      'SELECT * FROM portfolio_operations WHERE portfolio_id=?',
      parent.portfolio_id,
    );
    const stateHash = hash(caseSnapshot(db, c, operation));
    return addTask(db, {
      runId: parent.run_id,
      portfolioId: parent.portfolio_id,
      caseId: parent.case_id,
      parentTaskId: parent.id,
      action,
      reason,
      stateHash,
      key: `feedback:${parent.id}:${action}`,
      status,
      dueAt,
    });
  }

  function complete(task, result) {
    run(
      db,
      "UPDATE autonomy_tasks SET status='completed',result_json=?,updated_at=? WHERE id=?",
      JSON.stringify(result),
      now(),
      task.id,
    );
    event(db, task.case_id, 'autonomy_task_completed', { taskId: task.id, ...result }, task.owner);
  }

  function executeInternal(task) {
    if (task.kind === 'continue_conversation') {
      complete(task, {
        outcome: 'simulated_reply',
        detail: 'Authorized options explained in virtual conversation.',
      });
      return;
    }
    if (task.kind === 'fulfill_document') {
      complete(task, {
        outcome: 'simulated_document_ready',
        detail: 'Mock statement retrieved and attached.',
      });
      return;
    }
    if (task.kind === 'reason_case') {
      run(
        db,
        "UPDATE autonomy_tasks SET status='waiting',result_json=?,updated_at=? WHERE id=?",
        JSON.stringify({
          outcome: 'awaiting_evidence',
          detail: 'Collection held while dispute evidence is reviewed.',
        }),
        now(),
        task.id,
      );
      event(
        db,
        task.case_id,
        'autonomy_task_waiting',
        { taskId: task.id, reason: 'Dispute evidence required.' },
        'Rafael',
      );
      return;
    }
    run(db, "UPDATE autonomy_tasks SET status='waiting',updated_at=? WHERE id=?", now(), task.id);
  }

  function applyMockOutcome(task, attemptId, outcome, executedAt) {
    const stamp = now();
    if (outcome === 'no_response') {
      run(
        db,
        "UPDATE attempts SET outcome='not_reached',updated_at=? WHERE id=?",
        stamp,
        attemptId,
      );
      run(db, "UPDATE cases SET outcome='not_reached',status='unreached' WHERE id=?", task.case_id);
      complete(task, { outcome, nextAction: 'Retry after contact gap.' });
      const due = new Date(executedAt.getTime() + policy(db).gapHours * 3600000).toISOString();
      childTask(task, task.kind, 'Retry after configured contact gap.', 'scheduled', due);
      return;
    }
    if (outcome === 'wrong_person') {
      run(
        db,
        "UPDATE attempts SET outcome='invalid_contact',updated_at=? WHERE id=?",
        stamp,
        attemptId,
      );
      suppress(db, task.case_id, 'Wrong person reported in autonomous demo.');
      complete(task, { outcome, nextAction: 'Contact suppressed.' });
      return;
    }
    if (outcome === 'payment_options') {
      run(
        db,
        "UPDATE attempts SET outcome='willing_to_pay',updated_at=? WHERE id=?",
        stamp,
        attemptId,
      );
      run(
        db,
        "UPDATE cases SET outcome='willing_to_pay',status='engaged',review_required=0 WHERE id=?",
        task.case_id,
      );
      complete(task, { outcome, nextAction: 'Marina continues with authorized options.' });
      childTask(task, 'continue_conversation', 'Participant asked for payment options.');
      return;
    }
    if (outcome === 'callback') {
      run(db, "UPDATE attempts SET outcome='callback',updated_at=? WHERE id=?", stamp, attemptId);
      run(
        db,
        "UPDATE cases SET outcome='callback',status='engaged',review_required=0 WHERE id=?",
        task.case_id,
      );
      complete(task, { outcome, nextAction: 'Callback scheduled for next day.' });
      childTask(
        task,
        'call',
        'Participant requested a callback.',
        'scheduled',
        new Date(executedAt.getTime() + 24 * 3600000).toISOString(),
      );
      return;
    }
    if (outcome === 'document_request') {
      run(
        db,
        "UPDATE attempts SET outcome='document_request',updated_at=? WHERE id=?",
        stamp,
        attemptId,
      );
      run(db, "UPDATE cases SET status='engaged',review_required=0 WHERE id=?", task.case_id);
      complete(task, { outcome, nextAction: 'Helena retrieves requested evidence.' });
      childTask(task, 'fulfill_document', 'Participant requested a current account statement.');
      return;
    }
    if (outcome === 'dispute') {
      run(db, "UPDATE attempts SET outcome='disputed',updated_at=? WHERE id=?", stamp, attemptId);
      run(
        db,
        "UPDATE cases SET outcome='disputed',status='review',review_required=1 WHERE id=?",
        task.case_id,
      );
      complete(task, { outcome, nextAction: 'Rafael reviews dispute evidence.' });
      childTask(task, 'reason_case', 'Participant disputes the receivable.');
      return;
    }
    complete(task, { outcome: 'delivered', nextAction: 'Await participant response.' });
  }

  function executeContact(task, executedAt) {
    const c = one(db, 'SELECT * FROM cases WHERE id=?', task.case_id);
    const operation = one(
      db,
      'SELECT * FROM portfolio_operations WHERE portfolio_id=?',
      task.portfolio_id,
    );
    assert(operation?.status === 'active', 'Portfolio is no longer active.');
    assert(!c.suppressed, 'Contact is suppressed.');
    assert(!['opt_out', 'invalid_contact'].includes(c.outcome), 'Case outcome blocks contact.');
    const attempts = one(db, 'SELECT COUNT(*) n FROM attempts WHERE case_id=?', task.case_id);
    assert(Number(attempts.n) < policy(db).maxAttempts, 'Attempt limit reached.');
    const concurrent = one(
      db,
      `SELECT a.id FROM autonomy_actions a JOIN autonomy_tasks t ON t.id=a.task_id
       WHERE t.case_id=? AND a.status='running' AND a.task_id<>? LIMIT 1`,
      task.case_id,
      task.id,
    );
    assert(!concurrent, 'Another contact action is already running for this case.');
    const destination = task.channel === 'email' ? c.email : c.phone;
    assert(destination, 'Selected channel has no destination.');
    const actionId = id();
    run(
      db,
      `INSERT OR IGNORE INTO autonomy_actions
      (id,task_id,kind,channel,status,idempotency_key,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      actionId,
      task.id,
      task.kind,
      task.channel,
      'running',
      `action:${task.id}`,
      JSON.stringify({
        caseId: c.id,
        channel: task.channel,
        destinationRef: hash(destination).slice(0, 12),
      }),
      now(),
      now(),
    );
    const attemptId = id();
    run(
      db,
      `INSERT INTO attempts
      (id,case_id,channel,destination,mode,status,created_at,updated_at,message)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      attemptId,
      c.id,
      task.channel,
      destination,
      'demo',
      task.channel === 'voice' ? 'completed' : 'delivered',
      now(),
      now(),
      'Autonomous demo action — no external communication.',
    );
    run(
      db,
      'UPDATE autonomy_tasks SET attempt_id=?,updated_at=? WHERE id=?',
      attemptId,
      now(),
      task.id,
    );
    const profile = one(db, 'SELECT outcome FROM autonomy_mock_profiles WHERE case_id=?', c.id);
    const result = {
      simulated: true,
      providerContact: false,
      outcome: profile?.outcome || 'delivered',
    };
    run(
      db,
      "UPDATE autonomy_actions SET status='simulated_completed',result_json=?,updated_at=? WHERE task_id=?",
      JSON.stringify(result),
      now(),
      task.id,
    );
    event(
      db,
      c.id,
      'autonomy_action_simulated',
      { taskId: task.id, action: task.kind, channel: task.channel },
      task.owner,
      attemptId,
    );
    applyMockOutcome(task, attemptId, result.outcome, executedAt);
  }

  function executeRun(runId, at = new Date()) {
    const record = one(db, 'SELECT * FROM autonomy_runs WHERE id=?', runId);
    assert(record, 'Planner run not found.', 404);
    let cycles = 0;
    while (cycles++ < 100) {
      const task = one(
        db,
        `SELECT * FROM autonomy_tasks WHERE run_id=? AND
         ((status='queued' AND due_at<=?) OR (status='scheduled' AND due_at<=?))
         ORDER BY due_at,created_at,id LIMIT 1`,
        runId,
        now(),
        at.toISOString(),
      );
      if (!task) break;
      try {
        const operation = one(
          db,
          'SELECT status FROM portfolio_operations WHERE portfolio_id=?',
          task.portfolio_id,
        );
        if (operation?.status !== 'active') {
          run(
            db,
            "UPDATE autonomy_tasks SET status='cancelled',result_json=?,updated_at=? WHERE id=?",
            JSON.stringify({ reason: 'Portfolio was paused before execution.' }),
            now(),
            task.id,
          );
          continue;
        }
        run(
          db,
          "UPDATE autonomy_tasks SET status='running',updated_at=? WHERE id=?",
          now(),
          task.id,
        );
        if (contactActions.has(task.kind)) executeContact(task, at);
        else executeInternal(task);
      } catch (error) {
        run(
          db,
          "UPDATE autonomy_tasks SET status='failed',result_json=?,updated_at=? WHERE id=?",
          JSON.stringify({ error: safeError(error) }),
          now(),
          task.id,
        );
      }
    }
    const counts = Object.fromEntries(
      all(
        db,
        'SELECT status,COUNT(*) n FROM autonomy_tasks WHERE run_id=? GROUP BY status',
        runId,
      ).map((row) => [row.status, Number(row.n)]),
    );
    const executed = (counts.completed || 0) + (counts.waiting || 0) + (counts.scheduled || 0);
    run(
      db,
      "UPDATE autonomy_runs SET status='completed',executed=?,waiting=?,summary_json=?,completed_at=? WHERE id=?",
      executed,
      (counts.waiting || 0) + (counts.scheduled || 0),
      JSON.stringify({ taskCounts: counts, providerContacts: 0 }),
      now(),
      runId,
    );
    return details(record.portfolio_id, runId);
  }

  async function runSimulation(portfolioId) {
    assert(config.mode === 'demo', 'Autonomous simulation is available only in demo mode.', 403);
    const planned = await planPortfolio(portfolioId, { trigger: 'manual_demo', simulate: true });
    return executeRun(planned.id);
  }

  function details(portfolioId, runId = null) {
    const lastCheck = runId
      ? one(db, 'SELECT * FROM autonomy_runs WHERE id=? AND portfolio_id=?', runId, portfolioId)
      : one(
          db,
          'SELECT * FROM autonomy_runs WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 1',
          portfolioId,
        );
    const latest =
      (lastCheck?.planned > 0 ? lastCheck : null) ||
      one(
        db,
        'SELECT * FROM autonomy_runs WHERE portfolio_id=? AND planned>0 ORDER BY created_at DESC LIMIT 1',
        portfolioId,
      ) ||
      lastCheck;
    return {
      enabled: Boolean(config.autonomousPlannerEnabled),
      lastCheck: lastCheck
        ? {
            id: lastCheck.id,
            scanned: lastCheck.scanned,
            planned: lastCheck.planned,
            skipped: lastCheck.skipped,
            created_at: lastCheck.created_at,
          }
        : null,
      latestRun: latest
        ? { ...latest, summary: latest.summary_json ? JSON.parse(latest.summary_json) : null }
        : null,
      schedule:
        one(db, 'SELECT * FROM autonomy_schedules WHERE portfolio_id=?', portfolioId) || null,
      tasks: latest
        ? all(
            db,
            `SELECT t.*,c.name,c.reference FROM autonomy_tasks t JOIN cases c ON c.id=t.case_id
             WHERE t.run_id=? ORDER BY t.created_at,t.id`,
            latest.id,
          ).map((task) => ({
            ...task,
            result: task.result_json ? JSON.parse(task.result_json) : null,
          }))
        : [],
      decisions: latest
        ? all(
            db,
            'SELECT id,case_id,status,provider,model,proposed_action,applied_action,usage_json,latency_ms,error,created_at FROM autonomy_decisions WHERE run_id=? ORDER BY created_at',
            latest.id,
          ).map((decision) => ({
            ...decision,
            usage: decision.usage_json ? JSON.parse(decision.usage_json) : null,
          }))
        : [],
    };
  }

  async function tick(at = new Date()) {
    if (!config.autonomousPlannerEnabled) return [];
    const results = [];
    if (config.mode === 'demo') {
      const dueRuns = all(
        db,
        "SELECT DISTINCT run_id FROM autonomy_tasks WHERE status='scheduled' AND due_at<=?",
        at.toISOString(),
      );
      for (const due of dueRuns) results.push(executeRun(due.run_id, at));
    }
    for (const operation of all(
      db,
      `SELECT o.* FROM portfolio_operations o LEFT JOIN autonomy_schedules s ON s.portfolio_id=o.portfolio_id
       WHERE o.status='active' AND (s.next_planned_at IS NULL OR s.next_planned_at<=?)`,
      at.toISOString(),
    ))
      results.push(
        await planPortfolio(operation.portfolio_id, {
          trigger: 'scheduled_heartbeat',
          at,
          simulate: config.mode === 'demo',
        }),
      );
    return results;
  }

  function stats() {
    const count = (status) =>
      one(db, 'SELECT COUNT(*) n FROM autonomy_tasks WHERE status=?', status).n;
    return {
      queued: count('queued'),
      running: count('running'),
      failed: count('failed'),
      completed: count('completed'),
      waiting: count('waiting') + count('scheduled'),
      lastRuns: all(
        db,
        'SELECT id,status,summary_json AS usage_json,created_at,completed_at FROM autonomy_runs ORDER BY created_at DESC LIMIT 20',
      ),
    };
  }

  return { planPortfolio, executeRun, runSimulation, details, tick, stats };
}
