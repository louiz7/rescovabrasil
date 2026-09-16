import { registerPaymentAgreement } from './payments.mjs';
import { id, now, one, all, run, transaction, event, task } from './db.mjs';
import { assert, dateOnly, email, validateOutcome } from './domain.mjs';
import { demoPaymentOffers } from './demo-payment.mjs';
import { recordOutcome } from './service.mjs';

import { seedDemoDocuments } from './documents.mjs';

const providers = new Set(['grok', 'openai', 'twilio']);
const phonePattern = /^\+[1-9]\d{7,14}$/;
const taskReason = 'Review demo payment agreement and prepare payment follow-up';
const marker = 'Voice test demos';
export function ensureDemoPlatform(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_voice_cases (provider TEXT NOT NULL, session_id TEXT NOT NULL, case_id TEXT NOT NULL REFERENCES cases(id), PRIMARY KEY(provider,session_id));
  CREATE TABLE IF NOT EXISTS demo_voice_results (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
    case_id TEXT NOT NULL REFERENCES cases(id), agreement_id TEXT NOT NULL,
    agreement_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(provider,session_id)
  ); CREATE TABLE IF NOT EXISTS payment_followup_jobs (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), agreement_id TEXT NOT NULL,
    channel TEXT, destination TEXT,
    status TEXT NOT NULL, message TEXT NOT NULL, payment_details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(case_id,agreement_id)
  );`);
}
function localDate(value) {
  const d = new Date(value);
  assert(!isNaN(d), 'Invalid agreement acceptance date.');
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(d)
      .map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function monthly(date, offset) {
  const [year, month, day] = date.split('-').map(Number),
    d = new Date(Date.UTC(year, month - 1 + offset, 1, 12));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, end));
  return d.toISOString().slice(0, 10);
}
function validatedAgreement(agreement) {
  assert(
    agreement?.demo === true && agreement.acceptance === 'self_reported_explicit_consent',
    'Only an explicitly accepted fictional demo agreement can be saved.',
  );
  assert(
    typeof agreement.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(agreement.id),
    'Invalid agreement identifier.',
  );
  const offer = demoPaymentOffers.find((item) => item.offerId === agreement.offerId);
  assert(
    offer && agreement.currency === offer.currency && agreement.totalMinor === offer.totalMinor,
    'Agreement does not match an authorized demo offer.',
  );
  assert(
    Array.isArray(agreement.installments) &&
      agreement.installments.length === offer.installments.length,
    'Invalid demo payment schedule.',
  );
  const installments = agreement.installments.map((part, index) => {
    assert(
      part &&
        part.amountMinor === offer.installments[index].amountMinor &&
        dateOnly(part.dueDate) === part.dueDate,
      'Agreement installment terms do not match the demo offer.',
    );
    return { amountMinor: part.amountMinor, dueDate: part.dueDate };
  });
  const acceptedDate = localDate(agreement.acceptedAt),
    first = installments[0].dueDate;
  const gap = (new Date(first + 'T12:00:00Z') - new Date(acceptedDate + 'T12:00:00Z')) / 86400000;
  assert(
    offer.offerId === 'upfront_10_percent' ? gap === 0 : gap >= 0 && gap <= 7,
    'Agreement dates fall outside the authorized demo schedule.',
  );
  assert(
    installments.every((part, index) => part.dueDate === monthly(first, index)),
    'Installments must follow the agreed monthly calendar.',
  );
  return {
    id: agreement.id,
    offerId: offer.offerId,
    label: offer.label,
    currency: offer.currency,
    totalMinor: offer.totalMinor,
    installments,
    demo: true,
    acceptance: 'self_reported_explicit_consent',
    acceptedAt: new Date(agreement.acceptedAt).toISOString(),
    timezone: 'America/Sao_Paulo',
  };
}
const money = (value) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'BRL' }).format(value / 100);
function messageFor(agreement, details) {
  const schedule = agreement.installments
    .map((part, index) => `${index + 1}. ${money(part.amountMinor)} due ${part.dueDate}`)
    .join('\n');
  return `DEMO — fictional payment agreement for Ana Silva.\n${agreement.label}\nTotal: ${money(agreement.totalMinor)}.\n${schedule}\n${details ? `Payment instructions: ${details}` : 'Payment details are missing. An operator must supply approved payment instructions before this draft is ready.'}\nThis is a demo follow-up draft. No payment has been processed and no message has been sent.`;
}
const jobStatus = (channel, destination, details) =>
  !channel || !destination
    ? 'blocked_missing_contact'
    : !details
      ? 'blocked_missing_payment_details'
      : 'draft';
function persistedResult(db, result) {
  const c = one(db, 'SELECT reference FROM cases WHERE id=?', result.case_id);
  const review = one(
    db,
    'SELECT id FROM tasks WHERE case_id=? AND reason=? ORDER BY created_at DESC LIMIT 1',
    result.case_id,
    taskReason,
  );
  const job = one(
    db,
    'SELECT id,status FROM payment_followup_jobs WHERE case_id=? AND agreement_id=?',
    result.case_id,
    result.agreement_id,
  );
  return {
    caseId: result.case_id,
    reference: c.reference,
    taskId: review?.id || null,
    jobId: job?.id || null,
    jobStatus: job?.status || null,
  };
}
export function ensureDemoVoiceCase(db, config, { provider, sessionId, destination } = {}) {
  assert(config.mode === 'demo', 'Demo only.', 403);
  assert(
    providers.has(provider) &&
      typeof sessionId === 'string' &&
      /^[A-Za-z0-9_-]{1,100}$/.test(sessionId),
    'Invalid demo source.',
  );
  if (destination)
    assert(
      provider === 'twilio' &&
        phonePattern.test(destination) &&
        config.allowlist?.includes(destination),
      'Unauthorized demo recipient.',
      403,
    );
  ensureDemoPlatform(db);
  const previous =
    one(
      db,
      'SELECT case_id FROM demo_voice_cases WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    ) ||
    one(
      db,
      'SELECT case_id FROM demo_voice_results WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    );
  if (previous) {
    run(
      db,
      'INSERT OR IGNORE INTO demo_voice_cases VALUES (?,?,?)',
      provider,
      sessionId,
      previous.case_id,
    );
    seedDemoDocuments(db, previous.case_id);
    return {
      caseId: previous.case_id,
      reference: one(db, 'SELECT reference FROM cases WHERE id=?', previous.case_id).reference,
    };
  }
  return transaction(db, () => {
    let portfolio = one(
      db,
      "SELECT p.* FROM portfolios p JOIN settings s ON s.key='demo_voice_portfolio' AND s.value=p.id",
    );
    if (!portfolio) {
      portfolio = { id: id() };
      run(
        db,
        'INSERT INTO portfolios VALUES (?,?,?,?,?)',
        portfolio.id,
        marker,
        'Banco Horizonte (fictional)',
        'America/Sao_Paulo',
        now(),
      );
      run(db, "INSERT OR REPLACE INTO settings VALUES ('demo_voice_portfolio',?)", portfolio.id);
    }
    const caseId = id(),
      reference = `DEMO-${sessionId}`,
      timestamp = now();
    run(
      db,
      `INSERT INTO cases (id,portfolio_id,reference,name,phone,email,amount_minor,currency,timezone,language,status,review_required,identity_verified_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      caseId,
      portfolio.id,
      reference,
      'Ana Silva',
      destination || null,
      'ana.silva@example.invalid',
      125000,
      'BRL',
      'America/Sao_Paulo',
      'en',
      'new',
      0,
      timestamp,
      timestamp,
    );
    run(db, 'INSERT INTO demo_voice_cases VALUES (?,?,?)', provider, sessionId, caseId);
    seedDemoDocuments(db, caseId);
    event(db, caseId, 'demo_voice_case_created', { provider, sessionId, demo: true }, 'demo');
    return { caseId, reference };
  });
}

export function persistDemoAgreement(
  db,
  config,
  { sessionId, provider, agreement, destination } = {},
  { onSaved } = {},
) {
  assert(
    config.mode === 'demo',
    'Demo agreement persistence is unavailable in live workspaces.',
    403,
  );
  assert(providers.has(provider), 'Invalid demo voice provider.');
  assert(
    typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(sessionId),
    'Invalid demo voice session identifier.',
  );
  const savedAgreement = validatedAgreement(agreement);
  if (destination)
    assert(
      provider === 'twilio' &&
        phonePattern.test(destination) &&
        config.allowlist?.includes(destination),
      'Only an authorized Twilio test recipient may be attached to a saved demo.',
      403,
    );
  ensureDemoPlatform(db);
  return transaction(db, () => {
    const previous = one(
      db,
      'SELECT * FROM demo_voice_results WHERE provider=? AND session_id=?',
      provider,
      sessionId,
    );
    if (previous) {
      assert(
        previous.agreement_id === savedAgreement.id &&
          previous.agreement_json === JSON.stringify(savedAgreement),
        'This voice session already has a different saved agreement. Review it manually.',
        409,
      );
      const platform = persistedResult(db, previous);
      const workflow = onSaved?.({
        provider,
        sessionId,
        caseId: platform.caseId,
        agreementId: savedAgreement.id,
      });
      return workflow
        ? {
            ...platform,
            agentWorkflow: { ...workflow, transport: 'virtual_sms', startsAfter: 'call_end' },
          }
        : platform;
    }
    const { caseId, reference } = ensureDemoVoiceCase(db, config, {
      provider,
      sessionId,
      destination,
    });
    const timestamp = now();
    if (!config.agentWorkflowsEnabled)
      run(db, "UPDATE cases SET status='review',review_required=1 WHERE id=?", caseId);
    const result = {
      id: id(),
      session_id: sessionId,
      provider,
      case_id: caseId,
      agreement_id: savedAgreement.id,
      agreement_json: JSON.stringify(savedAgreement),
      created_at: timestamp,
    };
    run(db, 'INSERT INTO demo_voice_results VALUES (?,?,?,?,?,?,?)', ...Object.values(result));
    registerPaymentAgreement(db, caseId, savedAgreement);
    if (!config.agentWorkflowsEnabled) task(db, caseId, taskReason, timestamp, 'normal');
    const channel = destination ? 'sms' : 'email',
      followupDestination = destination || 'ana.silva@example.invalid',
      details = `DEMO ONLY — nonpayable payment link: https://payments.example.invalid/demo/${savedAgreement.id}\nDemo Pix: DEMO-PIX-NOT-PAYABLE (not a valid Pix key/code).`,
      status = jobStatus(channel, followupDestination, details);
    run(
      db,
      'INSERT INTO payment_followup_jobs VALUES (?,?,?,?,?,?,?,?,?,?)',
      id(),
      caseId,
      savedAgreement.id,
      channel,
      followupDestination,
      status,
      messageFor(savedAgreement, details),
      details,
      timestamp,
      timestamp,
    );
    event(
      db,
      caseId,
      'demo_voice_saved',
      { provider, sessionId, sourceCase: 'BROWSER-TEST-001', demo: true },
      'demo',
    );
    event(
      db,
      caseId,
      'demo_payment_agreed',
      {
        agreementId: savedAgreement.id,
        offerId: savedAgreement.offerId,
        totalMinor: savedAgreement.totalMinor,
        demo: true,
      },
      'demo',
    );
    const platform = persistedResult(db, result);
    const workflow = onSaved?.({ provider, sessionId, caseId, agreementId: savedAgreement.id });
    return workflow
      ? {
          ...platform,
          agentWorkflow: { ...workflow, transport: 'virtual_sms', startsAfter: 'call_end' },
        }
      : platform;
  });
}
export function getCasePaymentData(db, caseId) {
  ensureDemoPlatform(db);
  return {
    paymentAgreements: all(
      db,
      'SELECT * FROM demo_voice_results WHERE case_id=? ORDER BY created_at',
      caseId,
    ).map((r) => ({
      ...JSON.parse(r.agreement_json),
      provider: r.provider,
      sessionId: r.session_id,
    })),
    paymentFollowups: all(
      db,
      'SELECT * FROM payment_followup_jobs WHERE case_id=? ORDER BY created_at',
      caseId,
    ),
  };
}
export function updatePaymentFollowup(db, config, jobId, input = {}) {
  assert(
    config.mode === 'demo',
    'Demo payment follow-ups cannot be changed in live workspaces.',
    403,
  );
  assert(
    input && typeof input === 'object' && !Array.isArray(input),
    'Invalid payment follow-up update.',
  );
  assert(
    Object.keys(input).every((key) =>
      ['channel', 'destination', 'paymentDetails', 'status'].includes(key),
    ),
    'Unsupported payment follow-up field.',
  );
  assert(
    input.status === undefined || input.status === 'cancelled',
    'Only draft preparation or cancellation is supported; sending is not available.',
  );
  ensureDemoPlatform(db);
  return transaction(db, () => {
    const job = one(db, 'SELECT * FROM payment_followup_jobs WHERE id=?', jobId);
    assert(job, 'Payment follow-up not found.', 404);
    assert(
      job.status !== 'cancelled' || input.status === 'cancelled',
      'Cancelled follow-ups cannot be reopened.',
    );
    const stored = one(
      db,
      'SELECT agreement_json FROM demo_voice_results WHERE case_id=? AND agreement_id=?',
      job.case_id,
      job.agreement_id,
    );
    assert(stored, 'Demo agreement not found.', 404);
    if (input.status === 'cancelled') {
      run(
        db,
        "UPDATE payment_followup_jobs SET status='cancelled',updated_at=? WHERE id=?",
        now(),
        jobId,
      );
      event(db, job.case_id, 'payment_followup_cancelled', { jobId, demo: true });
      return one(db, 'SELECT * FROM payment_followup_jobs WHERE id=?', jobId);
    }
    const channel = input.channel === undefined ? job.channel : input.channel;
    assert(
      channel === null || ['sms', 'email'].includes(channel),
      'Select SMS or email; WhatsApp is unavailable for this follow-up.',
    );
    const raw = input.destination === undefined ? job.destination : input.destination;
    assert(raw === null || typeof raw === 'string', 'Invalid follow-up destination.');
    const destination = raw?.trim() || null;
    if (destination)
      assert(
        channel === 'sms'
          ? phonePattern.test(destination)
          : channel === 'email' && !!email(destination),
        'Enter a valid destination for the selected channel.',
      );
    const paymentDetails =
      input.paymentDetails === undefined ? job.payment_details : input.paymentDetails;
    assert(
      typeof paymentDetails === 'string' &&
        paymentDetails.length <= 2000 &&
        !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(paymentDetails),
      'Payment details must be plain text up to 2,000 characters.',
    );
    const details = paymentDetails.trim(),
      normalized = channel === 'email' && destination ? email(destination) : destination;
    run(
      db,
      'UPDATE payment_followup_jobs SET channel=?,destination=?,payment_details=?,status=?,message=?,updated_at=? WHERE id=?',
      channel,
      normalized,
      details,
      jobStatus(channel, normalized, details),
      messageFor(JSON.parse(stored.agreement_json), details),
      now(),
      jobId,
    );
    event(db, job.case_id, 'payment_followup_updated', {
      jobId,
      channel,
      status: jobStatus(channel, normalized, details),
      demo: true,
    });
    return one(db, 'SELECT * FROM payment_followup_jobs WHERE id=?', jobId);
  });
}

export function syncDemoOutcome(db, config, { sessionId, provider, args } = {}) {
  assert(config.mode === 'demo', 'Demo outcome sync is unavailable in live workspaces.', 403);
  assert(providers.has(provider) && typeof sessionId === 'string', 'Invalid demo voice source.');
  ensureDemoPlatform(db);
  const result = one(
    db,
    'SELECT * FROM demo_voice_cases WHERE provider=? AND session_id=?',
    provider,
    sessionId,
  );
  if (!result) return null;
  return transaction(db, () => {
    if (config.agentWorkflowsEnabled && !['opt_out', 'invalid_contact'].includes(args.outcome)) {
      const value = validateOutcome(args);
      const restricted = ['human_review', 'disputed', 'paid_reported'].includes(value.outcome);
      run(
        db,
        'UPDATE cases SET outcome=?,willingness=?,ability=?,status=?,review_required=? WHERE id=?',
        value.outcome,
        value.willingness,
        value.ability,
        restricted ? 'review' : 'ready',
        restricted ? 1 : 0,
        result.case_id,
      );
      event(
        db,
        result.case_id,
        'agent_resolution_requested',
        { outcome: args.outcome, note: args.note || '', owner: 'supervisor' },
        'demo',
      );
    } else recordOutcome(db, result.case_id, args, 'demo');
    if (
      ['opt_out', 'invalid_contact', 'disputed', 'human_review', 'paid_reported'].includes(
        args.outcome,
      )
    ) {
      run(
        db,
        "UPDATE payment_followup_jobs SET status='cancelled',updated_at=? WHERE (case_id=? OR case_id IN (SELECT id FROM cases WHERE suppressed=1)) AND status IN ('draft','blocked_missing_contact','blocked_missing_payment_details')",
        now(),
        result.case_id,
      );
    }
    event(
      db,
      result.case_id,
      'demo_voice_outcome_synced',
      { provider, sessionId, outcome: args.outcome, demo: true },
      'demo',
    );
    const agreementResult = one(
      db,
      'SELECT * FROM demo_voice_results WHERE case_id=?',
      result.case_id,
    );
    return agreementResult ? persistedResult(db, agreementResult) : { caseId: result.case_id };
  });
}
