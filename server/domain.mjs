import { createHash, timingSafeEqual } from 'node:crypto';

export const CHANNELS = ['sms', 'voice', 'email', 'whatsapp'];
export const OUTCOMES = [
  'not_reached',
  'invalid_contact',
  'callback',
  'paid_reported',
  'willing_to_pay',
  'unable_to_pay',
  'disputed',
  'human_review',
  'opt_out',
];
export const OUTCOME_LABELS = {
  not_reached: 'Not reached',
  invalid_contact: 'Invalid contact',
  callback: 'Callback requested',
  paid_reported: 'Payment reported',
  willing_to_pay: 'Willing to pay',
  unable_to_pay: 'Unable to pay',
  disputed: 'Debt disputed',
  human_review: 'Human review',
  opt_out: 'Do not contact',
};
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const assert = (condition, message, status = 400) => {
  if (!condition) throw new AppError(message, status);
};
export const clean = (v, limit = 200) =>
  String(v ?? '')
    .trim()
    .slice(0, limit);
export const fold = (v) =>
  clean(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
export function timezone(value) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
}
export function phoneBR(value) {
  const raw = clean(value);
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && !digits.startsWith('55')) return null;
  if (digits.startsWith('0055')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  if (!/^55[1-9]\d(?:[2-5]\d{7}|9\d{8})$/.test(digits)) return null;
  const ddd = digits.slice(2, 4);
  if (
    !new Set(
      '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(
        ' ',
      ),
    ).has(ddd)
  )
    return null;
  return '+' + digits;
}
export function email(value) {
  const s = clean(value, 254).toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? s : null;
}
export function amount(value) {
  if (value === '' || value == null) return null;
  if (typeof value === 'number')
    return Number.isFinite(value) &&
      value >= 0 &&
      Number.isSafeInteger(Math.round(value * 100)) &&
      Math.abs(value * 100 - Math.round(value * 100)) < 0.0001
      ? Math.round(value * 100)
      : NaN;
  let s = String(value).replace(/R\$|\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replaceAll('.', '').replace(',', '.');
  else if (/^\d+(,\d{1,2})$/.test(s)) s = s.replace(',', '.');
  else if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  const n = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(n) ? n : NaN;
}
export function dateOnly(value) {
  if (!value) return null;
  let s = clean(value);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) s = s.split('/').reverse().join('-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}
export const hashVerification = (reference, value) =>
  createHash('sha256')
    .update(`${reference}:${fold(value)}`)
    .digest('hex');
export function matchesVerification(reference, value, hash) {
  if (!hash || typeof value !== 'string') return false;
  return timingSafeEqual(Buffer.from(hashVerification(reference, value)), Buffer.from(hash));
}
export function contactWindow(date, tz, policy) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    })
      .formatToParts(date)
      .map((v) => [v.type, v.value]),
  );
  return (
    !['Sat', 'Sun'].includes(p.weekday) &&
    Number(p.hour) >= policy.startHour &&
    Number(p.hour) < policy.endHour &&
    !policy.excludedDates.includes(`${p.year}-${p.month}-${p.day}`)
  );
}
export function nextWindow(date, tz, policy) {
  const d = new Date(date);
  for (let i = 0; i < 24 * 370; i++) {
    if (contactWindow(d, tz, policy)) return d.toISOString();
    d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
  }
  throw new AppError('No contact window available in the calendar.');
}
export function isOptOut(text) {
  const s = fold(text).replace(/[.!?]/g, '').trim();
  return (
    /^(stop|parar|pare|sair|cancelar|unsubscribe|remover)$/.test(s) ||
    /nao (me )?(contat|lig|envi)|pare de|nao quero (mais |receber)|remova (meu|o meu)/.test(s)
  );
}
export function validateOutcome(input) {
  assert(OUTCOMES.includes(input.outcome), 'Invalid outcome.');
  const callbackAt = input.callbackAt ? new Date(input.callbackAt) : null;
  if (callbackAt) assert(!isNaN(callbackAt), 'Invalid callback date.');
  if (input.outcome === 'callback')
    assert(
      callbackAt && !isNaN(callbackAt) && callbackAt > new Date(),
      'Enter a future date and time for the callback.',
    );
  const willingness = input.willingness || 'unknown',
    ability = input.ability || 'unknown';
  assert(
    ['unknown', 'yes', 'no'].includes(willingness) && ['unknown', 'yes', 'no'].includes(ability),
    'Invalid willingness or ability value.',
  );
  return {
    outcome: input.outcome,
    note: clean(input.note, 2000),
    callbackAt: callbackAt?.toISOString() || null,
    willingness,
    ability,
  };
}
export const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[\t\r\n]|^\s*[=+@\-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
