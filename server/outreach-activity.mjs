import { all } from './db.mjs';

// Reporting projection only: provider submission, delivery and human reach are distinct.
export function outreachActivity(db, at = new Date()) {
  const timezone = 'America/Sao_Paulo';
  const dayFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayOf = (value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? dayFormat.format(date) : null;
  };
  const days = Array.from({ length: 14 }, (_, i) =>
    dayOf(new Date(at.getTime() - (13 - i) * 86400000)),
  );
  const since = new Date(at.getTime() - 15 * 86400000).toISOString();
  const tables = new Set(
    all(db, "SELECT name FROM sqlite_master WHERE type='table'").map((v) => v.name),
  );
  const channels = Object.fromEntries(
    ['call', 'sms', 'email'].map((channel) => [
      channel,
      {
        channel,
        total: 0,
        external: 0,
        simulated: 0,
        submitted: 0,
        delivered: 0,
        completed: 0,
        failed: 0,
        pending: 0,
        queued: 0,
        uncertain: 0,
        replies: 0,
      },
    ]),
  );
  const daily = days.map((day) => ({ day, count: 0, call: 0, sms: 0, email: 0 }));
  const byDay = new Map(daily.map((v) => [v.day, v]));
  function add(channel, createdAt, status, external) {
    const day = byDay.get(dayOf(createdAt));
    if (!day || !channels[channel]) return;
    const item = channels[channel];
    if (['queued', 'draft', 'cancelled', 'canceled'].includes(status)) {
      if (status === 'queued') item.queued++;
      return;
    }
    item.total++;
    item[external ? 'external' : 'simulated']++;
    day.count++;
    day[channel]++;
    if (['failed', 'undelivered', 'busy', 'no-answer', 'canceled', 'cancelled'].includes(status))
      item.failed++;
    else if (['unknown', 'uncertain'].includes(status)) item.uncertain++;
    else if (['delivered', 'read', 'simulated_delivered'].includes(status)) item.delivered++;
    else if (status === 'completed') item.completed++;
    else if (['submitted', 'sent', 'answered', 'in-progress'].includes(status)) item.submitted++;
    else item.pending++;
  }
  const calls = tables.has('twilio_test_calls')
    ? all(
        db,
        'SELECT provider_sid,state,created_at FROM twilio_test_calls WHERE created_at>=?',
        since,
      )
    : [];
  const email = tables.has('email_deliveries')
    ? all(
        db,
        'SELECT message_id,provider_message_id,status,created_at,updated_at FROM email_deliveries WHERE updated_at>=?',
        since,
      )
    : [];
  const providerIds = new Set(
    [...calls.map((v) => v.provider_sid), ...email.map((v) => v.provider_message_id)].filter(
      Boolean,
    ),
  );
  for (const row of all(
    db,
    'SELECT channel,mode,status,provider_sid,created_at FROM attempts WHERE created_at>=?',
    since,
  )) {
    if (row.provider_sid && providerIds.has(row.provider_sid)) continue;
    add(
      ['phone', 'voice', 'call'].includes(row.channel) ? 'call' : row.channel,
      row.created_at,
      row.status,
      row.mode === 'live',
    );
  }
  for (const row of calls) {
    // Twilio's queued state with a SID is provider acceptance, unlike a local unsent draft.
    const state =
      row.provider_sid && row.state === 'queued'
        ? 'submitted'
        : row.provider_sid && ['canceled', 'cancelled'].includes(row.state)
          ? 'failed'
          : row.state;
    add('call', row.created_at, state, true);
  }
  for (const row of email) {
    if (['queued', 'sending', 'submitted', 'failed', 'uncertain'].includes(row.status))
      add('email', row.updated_at, row.status, true);
  }
  if (tables.has('agent_messages')) {
    for (const row of all(
      db,
      'SELECT direction,channel,status,created_at FROM agent_messages WHERE created_at>=?',
      since,
    )) {
      const channel = row.channel === 'email' ? 'email' : 'sms';
      if (!byDay.has(dayOf(row.created_at))) continue;
      if (row.direction === 'inbound') channels[channel].replies++;
      // Email messages are counted only through their actual delivery record, not generated drafts.
      else if (channel === 'sms') add('sms', row.created_at, row.status, false);
    }
  }
  const browserSessions = tables.has('debug_voice_sessions')
    ? all(
        db,
        "SELECT created_at FROM debug_voice_sessions WHERE provider<>'twilio' AND created_at>=?",
        since,
      ).filter((v) => byDay.has(dayOf(v.created_at))).length
    : 0;
  return {
    timezone,
    start: days[0],
    end: days.at(-1),
    total: daily.reduce((n, v) => n + v.count, 0),
    channels: Object.values(channels),
    daily,
    browserSessions,
  };
}
