import { readFileSync } from 'node:fs';
import { id, now, one, all, run, transaction, event } from './db.mjs';
import { assert } from './domain.mjs';
import { recordOutcome } from './service.mjs';

function deepFreeze(value) {
  Object.freeze(value);
  for (const item of Object.values(value)) if (item && typeof item === 'object') deepFreeze(item);
  return value;
}
export const demoPaymentOffers = deepFreeze(
  JSON.parse(
    readFileSync(new URL('../examples/demo-payment-offers.json', import.meta.url), 'utf8'),
  ),
);
export const paymentConversationPolicy = `Payment acceptance in this pilot:
- Briefly summarize the selected authorized offer once: total, discount if any, number of payments, amounts (group equal payments and mention centavo differences), monthly frequency and first/final due dates. Use the exact returned schedule for date exceptions. Reading every month separately is optional, only on request.
- Keep terms already explained in conversation context. One clear acceptance of the selected, explained offer is sufficient: "yes" to the acceptance question, "I accept", "go ahead with that plan", or "yes, as I already confirmed". No special wording, second confirmation or full schedule recital is required. A clear acceptance while interrupting a repeated explanation also counts.
- After that acceptance, call or delegate agree_payment_solution with the selected offerId and accepted:true immediately. Carry the selected offer and the caller's existing acceptance into backend delegation; backend handoff or context lookup does not reset consent. Do not ask again while waiting for the result.
- A question, hypothetical, vague willingness or preference without agreement is not consent. If the offer is unclear or material terms were not explained, clarify only the missing point and ask one concise question. Do not restart the entire plan. Changed material terms require acceptance of the change.
- Once agreed, acknowledge briefly and continue naturally. If context is uncertain, use get_test_context to recover the saved agreement rather than asking for consent again. Repeating acceptance of the same offer must not create another agreement.`;
export const paymentSolutionTool = {
  type: 'function',
  name: 'agree_payment_solution',
  description:
    'Record one clear acceptance of the selected, already explained fictional demo offer. A contextual yes or go ahead is sufficient; no second confirmation or month-by-month recital is required. accepted:true means actual consent, not a question, preference or hypothetical. Repeated calls for the same offer return the existing agreement. No real payment or balance change occurs.',
  parameters: {
    type: 'object',
    properties: {
      offerId: { type: 'string', enum: demoPaymentOffers.map((offer) => offer.offerId) },
      accepted: { type: 'boolean', enum: [true] },
    },
    required: ['offerId', 'accepted'],
    additionalProperties: false,
  },
  strict: true,
};
const zone = 'America/Sao_Paulo';
function localDate(date) {
  assert(!isNaN(new Date(date)), 'Invalid demo session date.');
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(date))
      .map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function plusDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function plusMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function fixture(db, attemptId) {
  // Fixed expected data is not enough by itself: production/file databases and campaign attempts are forbidden.
  assert(
    all(db, 'PRAGMA database_list').every((entry) => entry.file === ''),
    'Payment offers are restricted to an isolated in-memory demo.',
  );
  const a = one(db, 'SELECT * FROM attempts WHERE id=?', attemptId);
  assert(
    a && a.mode === 'demo' && a.channel === 'voice' && !a.campaign_id && !a.enrollment_id,
    'Payment offers are restricted to an isolated demo voice attempt.',
  );
  const c = one(
    db,
    'SELECT c.*,p.creditor FROM cases c JOIN portfolios p ON p.id=c.portfolio_id WHERE c.id=?',
    a.case_id,
  );
  assert(
    c &&
      c.reference === 'BROWSER-TEST-001' &&
      c.name === 'Ana Silva' &&
      c.amount_minor === 125000 &&
      c.currency === 'BRL' &&
      c.timezone === zone &&
      c.creditor === 'Banco Horizonte (fictional)',
    'This case has no authorized demo payment offers.',
  );
  return { a, c };
}
function ensureStorage(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_payment_context (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), anchor_date TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS demo_payment_agreements (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), agreement TEXT NOT NULL
  );`);
}
export function datedDemoPaymentOffers(at = new Date()) {
  const anchorDate = localDate(at);
  return demoPaymentOffers.map((offer) => ({
    ...offer,
    anchorDate,
    timezone: zone,
    expiresOn: plusDays(anchorDate, offer.expiresInDays),
    installments: offer.installments.map((part) => ({
      amountMinor: part.amountMinor,
      dueDate: plusMonths(plusDays(anchorDate, part.dueInDays), part.monthOffset),
    })),
  }));
}

export function paymentDemoContext(db, attemptId) {
  const { a } = fixture(db, attemptId);
  ensureStorage(db);
  run(
    db,
    'INSERT OR IGNORE INTO demo_payment_context VALUES (?,?)',
    attemptId,
    localDate(a.created_at),
  );
  const anchorDate = one(
    db,
    'SELECT anchor_date FROM demo_payment_context WHERE attempt_id=?',
    attemptId,
  ).anchor_date;
  const saved = one(
    db,
    'SELECT agreement FROM demo_payment_agreements WHERE attempt_id=?',
    attemptId,
  );
  return {
    offers: datedDemoPaymentOffers(anchorDate + 'T12:00:00Z'),
    agreement: saved ? JSON.parse(saved.agreement) : null,
  };
}
export function executePaymentSolution(db, attemptId, args) {
  const { a, c } = fixture(db, attemptId);
  assert(
    args &&
      typeof args === 'object' &&
      !Array.isArray(args) &&
      Object.keys(args).every((key) => ['offerId', 'accepted'].includes(key)),
    'Only a fixed offer ID and explicit acceptance are allowed.',
  );
  assert(
    args.accepted === true,
    'Explicit consent to the selected demo offer is required; one clear confirmation is sufficient.',
  );
  assert(
    a.identity_verified === 1 && a.identity_method === 'self_reported_name',
    'Confirm the speaker name before agreeing to demo terms.',
  );
  assert(!c.suppressed, 'Contact is stopped; no demo agreement can be recorded.');
  const context = paymentDemoContext(db, attemptId),
    offer = context.offers.find((item) => item.offerId === args.offerId);
  assert(offer, 'This payment offer is not authorized.');
  return transaction(db, () => {
    const prior = one(
      db,
      'SELECT agreement FROM demo_payment_agreements WHERE attempt_id=?',
      attemptId,
    );
    if (prior) {
      const agreement = JSON.parse(prior.agreement);
      if (agreement.offerId === offer.offerId) return { agreed: true, agreement };
      recordOutcome(
        db,
        c.id,
        {
          outcome: 'human_review',
          note: 'Conflicting demo payment offer requested after acceptance; existing agreement preserved.',
        },
        'demo',
        attemptId,
      );
      return {
        agreed: false,
        conflict: true,
        next: 'human_review',
        agreement,
        reason: 'An existing demo agreement cannot be replaced automatically.',
      };
    }
    const allowedReview = ['willing_to_pay', 'unable_to_pay', 'callback'];
    assert(
      !['disputed', 'human_review', 'paid_reported', 'invalid_contact', 'opt_out'].includes(
        c.outcome,
      ) &&
        (!c.review_required || allowedReview.includes(c.outcome)),
      'This case requires human review before any demo agreement.',
    );
    assert(
      localDate(new Date()) <= offer.expiresOn,
      'This demo offer has expired. Start a new isolated test for fresh dates.',
    );
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
      timezone: zone,
    };
    run(
      db,
      'INSERT INTO demo_payment_agreements VALUES (?,?)',
      attemptId,
      JSON.stringify(agreement),
    );
    event(
      db,
      c.id,
      'demo_payment_agreed',
      {
        offerId: offer.offerId,
        agreementId: agreement.id,
        demo: true,
        acceptance: agreement.acceptance,
      },
      'demo',
      attemptId,
    );
    return { agreed: true, agreement };
  });
}
