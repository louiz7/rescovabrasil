import { one, run, all, now, event, task, transaction } from './db.mjs';
import { assert, clean, isOptOut, email, phoneBR } from './domain.mjs';
import { recordOutcome } from './service.mjs';

export function receiveOnce(db, key, fn) {
  return transaction(db, () => {
    if (one(db, 'SELECT 1 FROM receipts WHERE key=?', key)) return { duplicate: true };
    const result = fn();
    run(db, 'INSERT INTO receipts VALUES (?,?)', key, now());
    return result;
  });
}
const ranks = {
  dispatching: 0,
  accepted: 1,
  queued: 1,
  initiated: 2,
  sending: 2,
  sent: 3,
  ringing: 3,
  answered: 4,
  delivered: 4,
  read: 5,
  completed: 5,
  failed: 5,
  undelivered: 5,
  'no-answer': 5,
  busy: 5,
  canceled: 5,
  unknown: 0,
};
export function providerStatus(db, attemptId, sid, status, error = null) {
  const a = one(db, 'SELECT * FROM attempts WHERE id=?', attemptId);
  assert(a && a.mode === 'live', 'Contact attempt not found.', 404);
  assert(!a.provider_sid || a.provider_sid === sid, 'Provider identifier mismatch.', 403);
  assert(sid && ranks[status] !== undefined, 'Invalid status event.');
  return receiveOnce(db, `${sid}:${status}`, () => {
    const terminal = [
      'completed',
      'read',
      'failed',
      'undelivered',
      'no-answer',
      'busy',
      'canceled',
    ];
    if (
      ranks[status] < ranks[a.status] ||
      terminal.includes(a.status) ||
      (a.status === 'delivered' && status !== 'read')
    )
      return { ignored: true };
    run(
      db,
      'UPDATE attempts SET provider_sid=COALESCE(provider_sid,?),status=?,error=?,updated_at=? WHERE id=?',
      sid,
      status,
      error ? clean(error, 200) : null,
      now(),
      a.id,
    );
    event(db, a.case_id, 'provider_status', { channel: a.channel, status }, 'provider', a.id);
    if (['failed', 'undelivered'].includes(status)) {
      run(db, 'UPDATE cases SET review_required=1,status=? WHERE id=?', 'review', a.case_id);
      task(db, a.case_id, 'Delivery failed: check contact details and provider');
      run(
        db,
        "UPDATE enrollments SET state='stopped',reason='Delivery failed' WHERE case_id=? AND state IN ('queued','waiting')",
        a.case_id,
      );
    }
    return { ok: true };
  });
}
export function inboundMessage(db, { key, from, text, channel }) {
  assert(key && clean(text, 4000), 'Invalid message.');
  const address = channel === 'email' ? email(from) : phoneBR(from);
  assert(address, 'Invalid sender.');
  return receiveOnce(db, `inbound:${key}`, () => {
    const cases = all(
      db,
      `SELECT DISTINCT c.* FROM cases c JOIN attempts a ON a.case_id=c.id WHERE a.mode='live' AND a.channel=? AND a.destination=?`,
      channel,
      address,
    );
    if (!cases.length) {
      event(
        db,
        null,
        'unmatched_inbound',
        { channel, note: 'Reply without a matching attempt; check the provider inbox.' },
        'provider',
      );
      return { matched: 0 };
    }
    const optOut = isOptOut(text);
    for (const c of cases) {
      const a = one(
        db,
        'SELECT * FROM attempts WHERE case_id=? AND channel=? ORDER BY created_at DESC LIMIT 1',
        c.id,
        channel,
      );
      event(db, c.id, 'inbound_message', clean(text, 4000), 'borrower', a.id);
      recordOutcome(
        db,
        c.id,
        {
          outcome: optOut ? 'opt_out' : 'human_review',
          note:
            cases.length > 1
              ? 'Contact matches multiple cases; reconcile the reply before proceeding.'
              : 'Reply received; human review required.',
        },
        'provider',
        a.id,
      );
    }
    return { matched: cases.length };
  });
}
