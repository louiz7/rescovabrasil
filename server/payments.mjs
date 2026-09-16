import { id, now, one, all, run, transaction, event } from './db.mjs';
import { assert, dateOnly } from './domain.mjs';
import { createWorkerLeases } from './worker-leases.mjs';
import { createSimulatorPaymentProvider, validatePaymentProvider } from './payment-provider.mjs';

const exists = (db, name) =>
  !!one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
const money = (n, currency = 'BRL') => `${currency} ${(n / 100).toFixed(2)}`;
const integer = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000000000;
export function ensurePayments(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS collection_agreements (
    id TEXT PRIMARY KEY,case_id TEXT NOT NULL UNIQUE REFERENCES cases(id),currency TEXT NOT NULL,total_minor BIGINT NOT NULL,
    status TEXT NOT NULL,mode TEXT NOT NULL,timezone TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_installments (
    id TEXT PRIMARY KEY,agreement_id TEXT NOT NULL REFERENCES collection_agreements(id),sequence INTEGER NOT NULL,
    amount_minor BIGINT NOT NULL,due_date TEXT NOT NULL,UNIQUE(agreement_id,sequence));
    CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,case_id TEXT NOT NULL,agreement_id TEXT NOT NULL,installment_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,mode TEXT NOT NULL,currency TEXT NOT NULL,amount_minor BIGINT NOT NULL,status TEXT NOT NULL,
    provider_request_id TEXT,url TEXT,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_events (
    id TEXT PRIMARY KEY,provider TEXT NOT NULL,mode TEXT NOT NULL,event_id TEXT NOT NULL,case_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(provider,mode,event_id));
    CREATE TABLE IF NOT EXISTS collected_payments (
    id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES payment_requests(id),case_id TEXT NOT NULL,agreement_id TEXT NOT NULL,
    provider TEXT NOT NULL,mode TEXT NOT NULL,currency TEXT NOT NULL,amount_minor BIGINT NOT NULL,refunded_minor BIGINT NOT NULL,
    status TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_allocations (
    payment_id TEXT NOT NULL REFERENCES collected_payments(id),installment_id TEXT NOT NULL REFERENCES payment_installments(id),
    amount_minor BIGINT NOT NULL,PRIMARY KEY(payment_id,installment_id));
    CREATE TABLE IF NOT EXISTS payment_tasks (
    id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,case_id TEXT NOT NULL,agreement_id TEXT NOT NULL,installment_id TEXT,
    kind TEXT NOT NULL,owner TEXT NOT NULL,status TEXT NOT NULL,channel TEXT NOT NULL,due_at TEXT,next_action TEXT NOT NULL,
    message_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS payment_events_case ON payment_events(case_id);
    CREATE INDEX IF NOT EXISTS payment_tasks_due ON payment_tasks(status,due_at);
    CREATE INDEX IF NOT EXISTS payment_requests_case ON payment_requests(case_id);`);
}
export function registerPaymentAgreement(db, caseId, agreement) {
  ensurePayments(db);
  const old = one(db, 'SELECT * FROM collection_agreements WHERE case_id=?', caseId);
  if (old) {
    const parts = all(
      db,
      'SELECT amount_minor,due_date FROM payment_installments WHERE agreement_id=? ORDER BY sequence',
      old.id,
    );
    assert(
      old.id === agreement.id &&
        old.currency === agreement.currency &&
        old.total_minor === agreement.totalMinor &&
        JSON.stringify(parts.map((p) => ({ amountMinor: p.amount_minor, dueDate: p.due_date }))) ===
          JSON.stringify(agreement.installments),
      'A different collection agreement already exists; amendments require explicit authority.',
      409,
    );
    return;
  }
  assert(agreement.demo === true, 'Only simulation agreements are enabled.', 403);
  assert(
    Array.isArray(agreement.installments) &&
      agreement.installments.length > 0 &&
      agreement.installments.length <= 120 &&
      /^[A-Z]{3}$/.test(agreement.currency),
    'Invalid payment schedule or currency.',
  );
  assert(
    integer(agreement.totalMinor) &&
      agreement.totalMinor > 0 &&
      agreement.installments.reduce((n, p) => n + p.amountMinor, 0) === agreement.totalMinor,
    'Invalid agreement total.',
  );
  transaction(db, () => {
    run(
      db,
      'INSERT INTO collection_agreements VALUES (?,?,?,?,?,?,?,?)',
      agreement.id,
      caseId,
      agreement.currency,
      agreement.totalMinor,
      'active',
      'simulation',
      agreement.timezone || 'America/Sao_Paulo',
      now(),
    );
    agreement.installments.forEach((part, index) => {
      assert(
        integer(part.amountMinor) &&
          part.amountMinor > 0 &&
          dateOnly(part.dueDate) === part.dueDate,
        'Invalid installment.',
      );
      const installmentId = id(),
        requestId = id();
      run(
        db,
        'INSERT INTO payment_installments VALUES (?,?,?,?,?)',
        installmentId,
        agreement.id,
        index + 1,
        part.amountMinor,
        part.dueDate,
      );
      run(
        db,
        'INSERT INTO payment_requests (id,case_id,agreement_id,installment_id,provider,mode,currency,amount_minor,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        requestId,
        caseId,
        agreement.id,
        installmentId,
        'simulator',
        'simulation',
        agreement.currency,
        part.amountMinor,
        'queued',
        now(),
        now(),
      );
      addTask(db, {
        caseId,
        agreementId: agreement.id,
        installmentId,
        kind: 'reminder',
        key: `reminder:${installmentId}`,
        due: part.dueDate,
        next: 'Wait for the installment due date and recheck payment evidence before contacting.',
      });
    });
    addTask(db, {
      caseId,
      agreementId: agreement.id,
      kind: 'instructions',
      key: `instructions:${agreement.id}`,
      next: 'Marina will share the nonpayable installment payment links after source-call completion.',
    });
    event(
      db,
      caseId,
      'payment.agreement_registered',
      { agreementId: agreement.id, mode: 'simulation' },
      'payment',
    );
  });
}
function addTask(
  db,
  {
    caseId,
    agreementId,
    installmentId = null,
    kind,
    key,
    due = null,
    next,
    owner = 'Marina',
    status = 'queued',
  },
) {
  run(
    db,
    'INSERT OR IGNORE INTO payment_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id(),
    key,
    caseId,
    agreementId,
    installmentId,
    kind,
    owner,
    status,
    'virtual_sms',
    due,
    next,
    null,
    now(),
    now(),
  );
}
export function getPaymentState(db, caseId) {
  if (!exists(db, 'collection_agreements'))
    return {
      agreements: [],
      payments: [],
      tasks: [],
      summary: {
        mode: 'simulation',
        currency: 'BRL',
        receivedMinor: 0,
        remainingMinor: 0,
        unallocatedMinor: 0,
      },
    };
  const payments = all(
    db,
    'SELECT * FROM collected_payments WHERE case_id=? ORDER BY id',
    caseId,
  ).map((p) => ({
    ...p,
    netMinor: ['succeeded', 'refunded'].includes(p.status) ? p.amount_minor - p.refunded_minor : 0,
  }));
  const agreements = all(db, 'SELECT * FROM collection_agreements WHERE case_id=?', caseId).map(
    (a) => ({
      ...a,
      installments: all(
        db,
        'SELECT * FROM payment_installments WHERE agreement_id=? ORDER BY sequence',
        a.id,
      ).map((p) => {
        const paidMinor = Number(
          one(
            db,
            'SELECT COALESCE(SUM(amount_minor),0) n FROM payment_allocations WHERE installment_id=?',
            p.id,
          ).n,
        );
        return {
          ...p,
          paidMinor,
          remainingMinor: p.amount_minor - paidMinor,
          status: paidMinor === p.amount_minor ? 'paid' : paidMinor ? 'partial' : 'pending',
          request: one(db, 'SELECT * FROM payment_requests WHERE installment_id=?', p.id),
        };
      }),
    }),
  );
  const receivedMinor = payments.reduce((n, p) => n + p.netMinor, 0),
    allocated = agreements.flatMap((a) => a.installments).reduce((n, p) => n + p.paidMinor, 0);
  return {
    agreements,
    payments,
    tasks: all(db, 'SELECT * FROM payment_tasks WHERE case_id=? ORDER BY created_at,id', caseId),
    summary: {
      mode: agreements[0]?.mode || 'simulation',
      currency: agreements[0]?.currency || 'BRL',
      receivedMinor,
      remainingMinor: agreements.reduce((n, a) => n + a.total_minor, 0) - allocated,
      unallocatedMinor: receivedMinor - allocated,
    },
  };
}
function allocate(db, caseId) {
  const state = getPaymentState(db, caseId);
  run(
    db,
    'DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM collected_payments WHERE case_id=?)',
    caseId,
  );
  for (const agreement of state.agreements) {
    const parts = agreement.installments.map((p) => ({ ...p, available: p.amount_minor }));
    for (const payment of state.payments.filter((p) => p.agreement_id === agreement.id)) {
      let left = payment.netMinor;
      // Each request targets an installment. Excess is retained as unallocated credit,
      // never silently applied to another installment without an authorized allocation rule.
      const request = one(
        db,
        'SELECT installment_id FROM payment_requests WHERE id=?',
        payment.request_id,
      );
      const part = parts.find((p) => p.id === request.installment_id);
      const amount = Math.min(left, part.available);
      if (amount > 0)
        run(db, 'INSERT INTO payment_allocations VALUES (?,?,?)', payment.id, part.id, amount);
      part.available -= amount;
    }
    const outstanding = parts.reduce((n, p) => n + p.available, 0);
    run(
      db,
      'UPDATE collection_agreements SET status=? WHERE id=?',
      outstanding ? 'active' : 'paid',
      agreement.id,
    );
    for (const part of parts) {
      if (!part.available)
        run(
          db,
          "UPDATE payment_tasks SET status='cancelled',next_action='Installment is paid; no reminder is needed.',updated_at=? WHERE installment_id=? AND kind='reminder' AND status NOT IN ('simulated_completed','cancelled')",
          now(),
          part.id,
        );
      else
        run(
          db,
          "UPDATE payment_tasks SET status='queued',next_action='Payment was adjusted; recheck at due date.',updated_at=? WHERE installment_id=? AND kind='reminder' AND status='cancelled'",
          now(),
          part.id,
        );
    }
  }
}
function localDay(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function createPaymentService(
  db,
  config = {},
  { adapter = createSimulatorPaymentProvider() } = {},
) {
  ensurePayments(db);
  validatePaymentProvider(adapter);
  assert(
    adapter.mode === 'simulation',
    'Live and sandbox payment adapters require explicit activation; only simulation is enabled.',
    403,
  );
  const leases = createWorkerLeases(db, config);
  let scanAfter = '';
  // Existing accepted demos gain financial records without rewriting their source agreement.
  if (config.mode === 'demo' && exists(db, 'demo_voice_results')) {
    for (const row of all(
      db,
      'SELECT r.* FROM demo_voice_results r WHERE NOT EXISTS (SELECT 1 FROM collection_agreements a WHERE a.case_id=r.case_id)',
    )) {
      const lease = leases.acquire(`case:${row.case_id}`);
      if (!lease) continue;
      try {
        transaction(db, () => {
          lease.assertCurrent();
          registerPaymentAgreement(db, row.case_id, JSON.parse(row.agreement_json));
          run(
            db,
            "UPDATE payment_tasks SET status='cancelled',next_action='Historical agreement imported; prior communication history retained without inventing delivery evidence.',updated_at=? WHERE agreement_id=? AND kind='instructions' AND message_id IS NULL",
            now(),
            row.agreement_id,
          );
        });
      } finally {
        lease.release();
      }
    }
  }
  function withCase(caseId, work) {
    const lease = leases.acquire(`case:${caseId}`);
    assert(lease, 'Case is being processed; retry shortly.', 409);
    try {
      return transaction(db, () => {
        lease.assertCurrent();
        return work();
      });
    } finally {
      lease.release();
    }
  }
  // Trusted adapter output only, not a public webhook handler. Production adapters must
  // authenticate raw bytes and return authoritative versioned cumulative snapshots.
  function applyEvent(caseId, input) {
    return withCase(caseId, () => {
      assert(config.mode === 'demo', 'Payment simulation is disabled.', 403);
      const request = one(
        db,
        'SELECT * FROM payment_requests WHERE id=? AND case_id=?',
        input.requestId,
        caseId,
      );
      assert(
        request && request.provider === adapter.name && request.mode === adapter.mode,
        'Unknown payment request.',
        404,
      );
      assert(
        typeof input.eventId === 'string' &&
          /^[A-Za-z0-9_-]{1,120}$/.test(input.eventId) &&
          typeof input.paymentId === 'string' &&
          /^[A-Za-z0-9_-]{1,120}$/.test(input.paymentId),
        'Invalid event or payment identity.',
      );
      assert(
        Number.isSafeInteger(input.version) && input.version > 0,
        'A positive provider version is required.',
      );
      assert(
        input.currency === request.currency && integer(input.amountMinor) && input.amountMinor > 0,
        'Invalid payment amount or currency.',
      );
      assert(
        ['processing', 'succeeded', 'failed', 'refunded', 'reversed'].includes(input.status),
        'Unsupported payment status.',
      );
      const previous = one(db, 'SELECT * FROM collected_payments WHERE id=?', input.paymentId);
      assert(
        !previous ||
          (previous.request_id === request.id &&
            previous.mode === adapter.mode &&
            previous.provider === adapter.name),
        'Payment belongs to a different request.',
        409,
      );
      const payload = JSON.stringify({
        requestId: input.requestId,
        paymentId: input.paymentId,
        version: input.version,
        status: input.status,
        currency: input.currency,
        amountMinor: input.amountMinor,
        refundedMinor: input.refundedMinor || 0,
      });
      const duplicate = one(
        db,
        'SELECT * FROM payment_events WHERE provider=? AND mode=? AND event_id=?',
        adapter.name,
        adapter.mode,
        input.eventId,
      );
      if (duplicate) {
        assert(
          duplicate.payload === payload && duplicate.case_id === caseId,
          'Conflicting duplicate payment event.',
          409,
        );
        return getPaymentState(db, caseId);
      }
      const refund = input.status === 'reversed' ? input.amountMinor : input.refundedMinor || 0;
      assert(
        integer(refund) &&
          refund <= input.amountMinor &&
          (input.status === 'refunded' || input.status === 'reversed' || refund === 0),
        'Invalid cumulative refund.',
      );
      if (previous && input.version === previous.version)
        assert(
          previous.status === input.status &&
            previous.amount_minor === input.amountMinor &&
            previous.refunded_minor === refund,
          'Conflicting payment snapshot version.',
          409,
        );
      const stale = previous && input.version <= previous.version;
      run(
        db,
        'INSERT INTO payment_events VALUES (?,?,?,?,?,?,?,?,?,?)',
        id(),
        adapter.name,
        adapter.mode,
        input.eventId,
        caseId,
        input.paymentId,
        input.version,
        payload,
        stale ? 'ignored_stale' : 'applied',
        now(),
      );
      if (stale) return getPaymentState(db, caseId);
      // Gross amount is immutable for a provider payment; refunds are cumulative snapshots.
      assert(
        !previous || previous.amount_minor === input.amountMinor,
        'Payment gross amount cannot change.',
        409,
      );
      assert(
        !previous ||
          !['succeeded', 'refunded', 'reversed'].includes(previous.status) ||
          ['succeeded', 'refunded', 'reversed'].includes(input.status),
        'Settled payments require an explicit refund or reversal.',
        409,
      );
      run(
        db,
        `INSERT INTO collected_payments VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET refunded_minor=excluded.refunded_minor,status=excluded.status,version=excluded.version,updated_at=excluded.updated_at`,
        input.paymentId,
        request.id,
        caseId,
        request.agreement_id,
        adapter.name,
        adapter.mode,
        input.currency,
        input.amountMinor,
        refund,
        input.status,
        input.version,
        now(),
      );
      allocate(db, caseId);
      // Collapse undelivered receipt updates so no stale success is sent after a reversal.
      run(
        db,
        "UPDATE payment_tasks SET status='cancelled',next_action='Superseded by newer payment evidence.',updated_at=? WHERE case_id=? AND kind='payment_update' AND status NOT IN ('simulated_completed','cancelled')",
        now(),
        caseId,
      );
      addTask(db, {
        caseId,
        agreementId: request.agreement_id,
        installmentId: request.installment_id,
        kind: 'payment_update',
        key: `payment:${input.paymentId}:${input.version}`,
        next: 'Marina will acknowledge the current simulated payment state.',
      });
      const state = getPaymentState(db, caseId);
      if (state.summary.unallocatedMinor > 0)
        addTask(db, {
          caseId,
          agreementId: request.agreement_id,
          kind: 'reconciliation',
          key: `credit:${request.agreement_id}`,
          owner: 'Rafael',
          status: 'waiting_information',
          next: 'Unallocated credit exists; await an authorized credit allocation or refund capability. Do not collect this amount again.',
        });
      if (state.summary.unallocatedMinor > 0)
        run(
          db,
          "UPDATE payment_tasks SET status='waiting_information',next_action='Unallocated credit exists; await authorized allocation or refund capability.',updated_at=? WHERE case_id=? AND kind='reconciliation'",
          now(),
          caseId,
        );
      else
        run(
          db,
          "UPDATE payment_tasks SET status='simulated_completed',next_action='Credit discrepancy cleared by provider evidence.',updated_at=? WHERE case_id=? AND kind='reconciliation'",
          now(),
          caseId,
        );
      event(
        db,
        caseId,
        'payment.event_applied',
        {
          eventId: input.eventId,
          paymentId: input.paymentId,
          status: input.status,
          version: input.version,
          mode: adapter.mode,
        },
        'payment',
      );
      return getPaymentState(db, caseId);
    });
  }
  function simulate(caseId, input) {
    const prior = one(
      db,
      'SELECT * FROM collected_payments WHERE id=? AND case_id=?',
      input.paymentId || '',
      caseId,
    );
    if (input.status === 'refunded' || input.status === 'reversed') {
      assert(
        prior && ['succeeded', 'refunded', 'reversed'].includes(prior.status),
        'Simulate a successful payment before refunding or reversing it.',
      );
      input = {
        ...input,
        amountMinor: prior.amount_minor,
        refundedMinor: input.status === 'reversed' ? prior.amount_minor : input.amountMinor,
      };
    }
    return applyEvent(caseId, input);
  }
  function deliverTasks(caseId, date) {
    const state = getPaymentState(db, caseId),
      item = one(db, 'SELECT * FROM cases WHERE id=?', caseId);
    const conversation = exists(db, 'agent_conversations')
      ? one(
          db,
          'SELECT * FROM agent_conversations WHERE case_id=? ORDER BY rowid DESC LIMIT 1',
          caseId,
        )
      : null;
    const paused =
      exists(db, 'portfolio_operations') &&
      one(
        db,
        "SELECT 1 FROM portfolio_operations WHERE portfolio_id=? AND status='paused'",
        item.portfolio_id,
      );
    const suppressed =
      item.suppressed ||
      [item.phone, item.email]
        .filter(Boolean)
        .some((address) => one(db, 'SELECT 1 FROM suppressions WHERE address=?', address));
    const restricted =
      suppressed ||
      paused ||
      ['opt_out', 'disputed', 'invalid_contact', 'human_review', 'paid_reported'].includes(
        item.outcome,
      ) ||
      item.review_required;
    for (const task of state.tasks.filter(
      (t) =>
        t.owner === 'Marina' &&
        !['completed', 'simulated_completed', 'cancelled'].includes(t.status),
    )) {
      const agreement = state.agreements.find((a) => a.id === task.agreement_id);
      const day = date || localDay(agreement.timezone);
      if (task.due_at && task.due_at > day) continue;
      const part = agreement.installments.find((p) => p.id === task.installment_id);
      const hold =
        restricted ||
        (task.kind === 'reminder' && state.summary.unallocatedMinor > 0) ||
        !conversation ||
        conversation.status !== 'active' ||
        !one(
          db,
          'SELECT 1 FROM agent_source_ends WHERE provider=? AND session_id=?',
          conversation.provider,
          conversation.session_id,
        );
      if (hold) {
        run(
          db,
          'UPDATE payment_tasks SET status=?,next_action=?,updated_at=? WHERE id=?',
          restricted ? 'waiting_policy' : 'waiting_channel',
          'Waiting for eligible conversation, source-call completion and reconciled case evidence.',
          now(),
          task.id,
        );
        continue;
      }
      if (
        task.kind === 'instructions' &&
        agreement.installments.some((p) => p.request?.status !== 'ready')
      ) {
        run(
          db,
          "UPDATE payment_tasks SET status='waiting_information',next_action='Await provider payment request creation.',updated_at=? WHERE id=?",
          now(),
          task.id,
        );
        continue;
      }
      if (task.kind === 'reminder' && part.request?.status !== 'ready') continue;
      if (
        task.kind === 'reminder' &&
        (!part.remainingMinor ||
          state.payments.some((p) => p.status === 'processing' && p.request_id === part.request.id))
      )
        continue;
      if (task.kind === 'instructions') {
        // Reuse the existing agreement-delivery owner and immutable message. Never send
        // duplicate instructions independently of an in-flight conversation job.
        const message = task.message_id
          ? one(
              db,
              "SELECT * FROM agent_messages WHERE id=? AND conversation_id=? AND direction='outbound'",
              task.message_id,
              conversation.id,
            )
          : null;
        if (!message) continue;
        const submitted =
          message.channel !== 'email' ||
          (exists(db, 'email_deliveries') &&
            one(
              db,
              "SELECT 1 FROM email_deliveries WHERE message_id=? AND status IN ('submitted','delivered')",
              message.id,
            ));
        if (!submitted) continue;
        run(
          db,
          "UPDATE payment_tasks SET status=?,channel=?,message_id=?,next_action='Existing agreement message supplied the demo payment instructions.',updated_at=? WHERE id=?",
          message.channel === 'email' ? 'completed' : 'simulated_completed',
          message.channel,
          message.id,
          now(),
          task.id,
        );
        continue;
      }
      const text =
        task.kind === 'reminder'
          ? `DEMO — installment ${part.sequence}: ${money(part.remainingMinor, agreement.currency)} remains due on ${part.due_date}. Nonpayable test link: ${part.request?.url || 'not ready yet'}. No real payment is requested.`
          : `DEMO payment update: ${money(state.summary.receivedMinor, agreement.currency)} net simulated receipts recorded; ${money(state.summary.remainingMinor, agreement.currency)} remains on the agreement. ${part ? `Installment ${part.sequence}: ${money(part.remainingMinor, agreement.currency)} remaining.` : ''} ${state.summary.unallocatedMinor ? `Unallocated credit: ${money(state.summary.unallocatedMinor, agreement.currency)}; allocation is pending.` : ''} This is simulator evidence, not a real payment receipt.`;
      const messageId = id();
      run(
        db,
        'INSERT INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at,channel) VALUES (?,?,?,?,?,?,?,?)',
        messageId,
        conversation.id,
        'outbound',
        text,
        'simulated_delivered',
        `payment-task:${task.id}`,
        now(),
        'virtual_sms',
      );
      run(
        db,
        "UPDATE payment_tasks SET status='simulated_completed',message_id=?,next_action='Delivered in the virtual SMS conversation.',updated_at=? WHERE id=?",
        messageId,
        now(),
        task.id,
      );
      event(
        db,
        caseId,
        'payment.notification_simulated',
        { taskId: task.id, messageId, kind: task.kind },
        'Marina',
      );
    }
  }
  async function tick({ caseId, date } = {}) {
    if (config.mode !== 'demo' || config.agentWorkflowsEnabled === false) return;
    if (date) assert(dateOnly(date) === date, 'Invalid simulation date.');
    let cases = caseId
      ? [{ case_id: caseId }]
      : all(
          db,
          'SELECT case_id FROM collection_agreements WHERE case_id>? ORDER BY case_id LIMIT 200',
          scanAfter,
        );
    if (!caseId && !cases.length) {
      scanAfter = '';
      cases = all(db, 'SELECT case_id FROM collection_agreements ORDER BY case_id LIMIT 200');
    }
    if (!caseId && cases.length) scanAfter = cases.at(-1).case_id;
    for (const row of cases) {
      const lease = leases.acquire(`case:${row.case_id}`);
      if (!lease) continue;
      try {
        for (const request of all(
          db,
          "SELECT * FROM payment_requests WHERE case_id=? AND status IN ('queued','retry') AND attempts<3",
          row.case_id,
        )) {
          transaction(db, () => {
            lease.assertCurrent();
            run(
              db,
              "UPDATE payment_requests SET attempts=attempts+1,status='retry',updated_at=? WHERE id=?",
              now(),
              request.id,
            );
          });
          try {
            const result = await adapter.createRequest({ ...request, idempotencyKey: request.id });
            assert(
              typeof result.providerRequestId === 'string' && /^https:\/\//.test(result.url),
              'Invalid provider request result.',
            );
            transaction(db, () => {
              lease.assertCurrent();
              run(
                db,
                "UPDATE payment_requests SET provider_request_id=?,url=?,status='ready',error=NULL,updated_at=? WHERE id=?",
                result.providerRequestId,
                result.url,
                now(),
                request.id,
              );
            });
          } catch (error) {
            if (!lease.valid()) throw error;
            transaction(db, () => {
              lease.assertCurrent();
              run(
                db,
                'UPDATE payment_requests SET status=?,error=?,updated_at=? WHERE id=?',
                request.attempts + 1 >= 3 ? 'failed' : 'retry',
                'Payment request creation failed; retry with the same idempotency key.',
                now(),
                request.id,
              );
            });
          }
        }
        transaction(db, () => {
          lease.assertCurrent();
          for (const failed of all(
            db,
            "SELECT * FROM payment_requests WHERE case_id=? AND status='failed'",
            row.case_id,
          ))
            addTask(db, {
              caseId: row.case_id,
              agreementId: failed.agreement_id,
              installmentId: failed.installment_id,
              kind: 'request_failure',
              key: `request-failed:${failed.id}`,
              owner: 'Rafael',
              status: 'waiting_information',
              next: 'Payment request creation exhausted its retry budget; await provider configuration or recovery evidence. Reuse the original request idempotency key.',
            });
          deliverTasks(row.case_id, date);
        });
      } finally {
        lease.release();
      }
    }
  }
  async function reconcile(caseId, paymentId) {
    const stored = one(
      db,
      'SELECT * FROM collected_payments WHERE id=? AND case_id=?',
      paymentId,
      caseId,
    );
    assert(stored, 'Payment not found.', 404);
    const snapshot = await adapter.retrievePayment(stored);
    assert(
      snapshot.paymentId === paymentId && snapshot.requestId === stored.request_id,
      'Provider reconciliation reference mismatch.',
      409,
    );
    return applyEvent(caseId, snapshot);
  }
  async function receiveWebhook(rawBody, headers) {
    const snapshot = await adapter.verifyAndNormalizeWebhook(rawBody, headers);
    const request = one(
      db,
      'SELECT case_id FROM payment_requests WHERE id=? AND provider=? AND mode=?',
      snapshot.requestId,
      adapter.name,
      adapter.mode,
    );
    assert(request, 'Unmatched provider payment request.', 404);
    return applyEvent(request.case_id, snapshot);
  }
  return {
    tick,
    simulate,
    applyEvent,
    reconcile,
    receiveWebhook,
    state: (caseId) => getPaymentState(db, caseId),
  };
}

export function recordPaymentReport(db, caseId) {
  ensurePayments(db);
  const agreement = one(db, 'SELECT id FROM collection_agreements WHERE case_id=?', caseId);
  addTask(db, {
    caseId,
    agreementId: agreement?.id || 'unlinked',
    kind: 'payment_report',
    key: `payment-report:${caseId}`,
    owner: 'Rafael',
    status: 'waiting_information',
    next: 'Compare the debtor report with provider evidence. Simulation cannot verify real money; await a connected provider or additional evidence.',
  });
}
