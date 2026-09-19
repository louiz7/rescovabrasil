import { all, one } from './db.mjs';

// Read projection of existing executors. This does not invent assignments or enqueue work.
export function agentTaskList(
  db,
  { state = 'open', offset = 0, limit = 50, owner = null, at = new Date() } = {},
) {
  state = ['open', 'ready', 'scheduled', 'waiting', 'completed', 'all'].includes(state)
    ? state
    : 'open';
  offset = Math.max(0, Math.floor(Number.isFinite(Number(offset)) ? Number(offset) : 0));
  limit = Math.min(
    100,
    Math.max(1, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 50)),
  );
  const exists = (table) =>
    one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
  const selects = [];
  const hasTickets = !!exists('document_tickets');
  if (hasTickets)
    selects.push(`SELECT 'ticket:' || t.id id,'document_ticket' source,'Document fulfillment' title,t.case_id,t.conversation_id,
      t.owner,t.status,t.channel,t.error,t.deadline_at due_at,t.created_at,t.next_action FROM document_tickets t`);
  if (exists('payment_tasks'))
    selects.push(`SELECT 'payment:' || t.id id,'payment_task' source,
      CASE t.kind WHEN 'reminder' THEN 'Installment reminder' WHEN 'instructions' THEN 'Payment instructions' WHEN 'payment_update' THEN 'Payment update' WHEN 'reconciliation' THEN 'Payment reconciliation' WHEN 'payment_report' THEN 'Payment report' WHEN 'request_failure' THEN 'Payment request recovery' WHEN 'payment_confirmation' THEN 'Payment confirmation'
        WHEN 'payment_instructions' THEN 'Payment instructions'
        WHEN 'installment_reminder' THEN 'Installment reminder'
        WHEN 'payment_reconciliation' THEN 'Payment reconciliation'
        ELSE t.kind END title,t.case_id,NULL conversation_id,
      t.owner,t.status,t.channel,NULL error,t.due_at,t.created_at,t.next_action FROM payment_tasks t`);
  if (exists('agent_jobs'))
    selects.push(`SELECT 'job:' || j.id id,'agent_job' source,j.purpose title,c.case_id,c.id conversation_id,
    CASE WHEN j.purpose='supervisor_review' THEN 'Rafael' ELSE 'Marina' END owner,j.status,j.delivery_channel channel,j.error,
    j.due_at,j.created_at,NULL next_action FROM agent_jobs j JOIN agent_conversations c ON c.id=j.conversation_id
    ${hasTickets ? 'WHERE NOT EXISTS (SELECT 1 FROM document_tickets t WHERE t.job_id=j.id)' : ''}`);
  if (exists('agent_resolutions'))
    selects.push(`SELECT 'resolution:' || r.conversation_id id,'resolution' source,r.reason title,c.case_id,c.id conversation_id,
    'Rafael' owner,r.status,NULL channel,NULL error,NULL due_at,r.updated_at created_at,r.next_action
    FROM agent_resolutions r JOIN agent_conversations c ON c.id=r.conversation_id
    WHERE r.status IN ('awaiting_information','awaiting_specialist','blocked_policy')`);
  if (exists('document_ingestions'))
    selects.push(`SELECT 'ingestion:' || d.id id,'document_ingestion' source,d.title,d.case_id,NULL conversation_id,
    'Helena' owner,d.status,NULL channel,d.error,NULL due_at,d.created_at,NULL next_action FROM document_ingestions d`);
  if (exists('email_deliveries'))
    selects.push(`SELECT 'email:' || d.id id,'email_delivery' source,d.subject title,c.case_id,c.id conversation_id,
    'Delivery worker' owner,d.status,'email' channel,d.error,NULL due_at,d.created_at,NULL next_action
    FROM email_deliveries d JOIN agent_conversations c ON c.id=d.conversation_id
    ${hasTickets ? 'WHERE NOT EXISTS (SELECT 1 FROM document_tickets t WHERE t.delivery_id=d.id OR t.message_id=d.message_id)' : ''}`);
  if (exists('autonomy_tasks'))
    selects.push(`SELECT 'autonomy:' || t.id id,'autonomy_task' source,
      CASE t.kind WHEN 'call' THEN 'AI phone outreach' WHEN 'send_sms' THEN 'SMS outreach'
        WHEN 'send_email' THEN 'Email outreach' WHEN 'continue_conversation' THEN 'Continue conversation'
        WHEN 'fulfill_document' THEN 'Document fulfillment' WHEN 'reason_case' THEN 'Case reasoning'
        WHEN 'wait_payment_verification' THEN 'Payment verification' WHEN 'await_information' THEN 'Missing information'
        ELSE t.kind END title,t.case_id,NULL conversation_id,t.owner,t.status,t.channel,NULL error,
      t.due_at,t.created_at,t.reason next_action FROM autonomy_tasks t`);
  if (!selects.length)
    return {
      rows: [],
      total: 0,
      counts: { open: 0, ready: 0, scheduled: 0, waiting: 0, completed: 0, all: 0 },
      offset,
      limit,
    };
  const ownerFilter = ['Helena', 'Marina', 'Rafael', 'Clara', 'Lucas', 'Tiago'].includes(owner)
    ? ` WHERE t.owner='${owner}'`
    : '';
  // Date-only schedules follow the case timezone; deadlines are not execution dates.
  const time = new Date(at);
  const zones = all(db, 'SELECT DISTINCT timezone FROM cases').map((r) => r.timezone);
  const day = (zone) => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(time);
    } catch {
      return time.toISOString().slice(0, 10);
    }
  };
  const zoneArgs = zones.flatMap((zone) => [zone, day(zone)]);
  const localDateSql = zones.length
    ? `CASE c.timezone ${zones.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ? END`
    : '?';
  const baseArgs = [...zoneArgs, day('UTC'), time.toISOString()];
  const base = `SELECT t.*,CASE
    WHEN t.status IN ('completed','simulated_completed','ready','sent','submitted','cancelled','expired') THEN 'completed'
    WHEN t.status IN ('running','processing','sending') THEN 'ready'
    WHEN t.status IN ('failed','uncertain','paused','blocked_policy','needs_ocr') OR t.status LIKE 'waiting%' OR t.status LIKE 'awaiting%' THEN 'waiting'
    WHEN t.status='scheduled' THEN 'scheduled'
    WHEN t.source IN ('payment_task','agent_job','autonomy_task') AND t.due_at IS NOT NULL AND
      (CASE WHEN length(t.due_at)=10 THEN t.due_at>${localDateSql} ELSE t.due_at>? END) THEN 'scheduled'
    ELSE 'ready' END bucket
    FROM (${selects.join(' UNION ALL ')}) t JOIN cases c ON c.id=t.case_id${ownerFilter}`;
  const counts = { open: 0, ready: 0, scheduled: 0, waiting: 0, completed: 0, all: 0 };
  for (const row of all(
    db,
    `SELECT bucket,COUNT(*) n FROM (${base}) t GROUP BY bucket`,
    ...baseArgs,
  )) {
    counts[row.bucket] = Number(row.n);
    counts.all += Number(row.n);
  }
  counts.open = counts.ready + counts.scheduled + counts.waiting;
  const where =
    state === 'all' ? '' : state === 'open' ? "WHERE t.bucket!='completed'" : 'WHERE t.bucket=?';
  const args = ['all', 'open'].includes(state) ? [] : [state];
  const rows = all(
    db,
    `SELECT t.*,c.name,c.reference,p.name portfolio_name FROM (${base}) t
    JOIN cases c ON c.id=t.case_id JOIN portfolios p ON p.id=c.portfolio_id ${where}
    ORDER BY CASE t.bucket WHEN 'ready' THEN 0 WHEN 'waiting' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END, CASE WHEN t.bucket='scheduled' THEN t.due_at ELSE NULL END ASC,t.created_at DESC,t.id
    LIMIT ? OFFSET ?`,
    ...baseArgs,
    ...args,
    limit,
    offset,
  ).map((row) => ({ ...row, next_action: row.next_action || nextAction(row) }));
  return { rows, total: counts[state], counts, offset, limit };
}
function nextAction(t) {
  if (t.source === 'autonomy_task') return t.next_action || 'Execute the planned case action.';
  if (t.source === 'payment_task') {
    if (t.status === 'simulated_completed')
      return 'Completed in simulation; no real payment or delivery implied.';
    if (t.status === 'waiting_information')
      return 'Reconcile the payment using authoritative evidence; do not infer receipt.';
    if (t.status === 'waiting_channel') return 'Waiting for an eligible communication channel.';
    if (t.status === 'waiting_policy') return 'Contact is held until the case policy permits it.';
    if (t.status === 'queued')
      return 'Wait until the scheduled payment action is due, then recheck current payment and contact state.';
  }
  if (t.status === 'cancelled') return 'Cancelled; no action scheduled.';
  if (['completed', 'ready', 'sent', 'submitted'].includes(t.status))
    return ['sent', 'submitted'].includes(t.status)
      ? 'Gmail accepted the message; no delivery confirmation implied.'
      : 'Work completed.';
  if (t.status === 'uncertain')
    return 'Reconcile provider receipt before any resend; automatic resend is held.';
  if (t.status === 'failed')
    return 'Execution failed. Inspect the recorded error; retry through the existing workflow controls.';
  if (t.status === 'paused') return 'Waiting for conversation resume.';
  if (t.status === 'waiting_source_end')
    return 'Wait for the call to end, then process the queued follow-up.';
  if (t.status === 'needs_ocr') return 'Document extraction needs OCR support before retry.';
  if (t.source === 'document_ingestion')
    return 'Extract text, run OCR where needed, and index document evidence.';
  if (t.source === 'email_delivery')
    return 'Deliver the prepared email using the configured Gmail transport.';
  return (
    {
      supervisor_review: 'Review case evidence and delegate the next action.',
      marina_guided_reply: 'Continue the conversation using Rafael’s guidance.',
      agreement_followup: 'Prepare the accepted agreement and payment instructions.',
      document_followup: 'Retrieve the requested document and prepare a response.',
      reply: 'Read the message, retrieve relevant case facts, and respond.',
    }[t.title] || 'Process the persisted agent job.'
  );
}
