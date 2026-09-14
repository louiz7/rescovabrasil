import { id, now, one, all, run, transaction, event, task } from './db.mjs';
import {
  assert,
  clean,
  timezone,
  CHANNELS,
  OUTCOME_LABELS,
  validateOutcome,
  nextWindow,
} from './domain.mjs';

export function createPortfolio(db, input) {
  assert(clean(input.name) && clean(input.creditor), 'Enter the portfolio name and creditor.');
  const tz = timezone(input.timezone || 'America/Sao_Paulo');
  assert(tz, 'Invalid time zone.');
  const p = {
    id: id(),
    name: clean(input.name),
    creditor: clean(input.creditor),
    timezone: tz,
    created_at: now(),
  };
  run(db, 'INSERT INTO portfolios VALUES (?,?,?,?,?)', ...Object.values(p));
  return p;
}
export function publicCase(c) {
  if (!c) return null;
  const { verification_hash, ...rest } = c;
  return { ...rest, identity_confirmation: c.identity_verified_at ? 'self_reported_name' : null };
}
export function policy(db) {
  return JSON.parse(one(db, "SELECT value FROM settings WHERE key='policy'").value);
}
export function savePolicy(db, p) {
  assert(
    Number.isInteger(p.startHour) &&
      Number.isInteger(p.endHour) &&
      p.startHour >= 8 &&
      p.endHour <= 20 &&
      p.startHour < p.endHour,
    'Invalid contact window (08:00–20:00).',
  );
  assert(
    Number.isInteger(p.gapHours) && p.gapHours >= 24 && p.gapHours <= 168,
    'Contact gap must be between 24 and 168 hours.',
  );
  assert(
    Number.isInteger(p.maxAttempts) && p.maxAttempts >= 1 && p.maxAttempts <= 3,
    'Attempt limit must be between 1 and 3.',
  );
  assert(
    Array.isArray(p.excludedDates) &&
      p.excludedDates.length <= 366 &&
      p.excludedDates.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)),
    'Invalid excluded dates.',
  );
  run(db, "UPDATE settings SET value=? WHERE key='policy'", JSON.stringify(p));
  event(db, null, 'policy_updated', p);
  return p;
}
export function suppressionReason(db, c) {
  if (c.suppressed) return 'Contact blocked';
  if (c.review_required) return 'Awaiting human review';
  for (const address of [c.phone, c.email].filter(Boolean))
    if (one(db, 'SELECT 1 FROM suppressions WHERE address=?', address)) return 'Address blocked';
  if (c.outcome && c.outcome !== 'not_reached' && c.outcome !== 'invalid_contact')
    return 'Response already recorded';
  return null;
}
export function suppress(db, caseId, reason) {
  const c = one(db, 'SELECT * FROM cases WHERE id=?', caseId);
  const addresses = [c.phone, c.email].filter(Boolean);
  for (const address of addresses)
    run(db, 'INSERT OR IGNORE INTO suppressions VALUES (?,?,?)', address, reason, now());
  const related = all(
    db,
    'SELECT * FROM cases WHERE id=? OR (phone IS NOT NULL AND phone=?) OR (email IS NOT NULL AND email=?)',
    caseId,
    c.phone,
    c.email,
  );
  for (const r of related) {
    run(db, "UPDATE cases SET suppressed=1,status='suppressed' WHERE id=?", r.id);
    run(
      db,
      "UPDATE enrollments SET state='stopped',reason=? WHERE case_id=? AND state IN ('queued','waiting')",
      reason,
      r.id,
    );
    event(db, r.id, 'suppressed', reason);
  }
}
export function recordOutcome(db, caseId, input, actor = 'operator', attemptId = null) {
  const value = validateOutcome(input),
    c = one(db, 'SELECT * FROM cases WHERE id=?', caseId);
  assert(c, 'Case not found.', 404);
  const reviewing = !['not_reached', 'invalid_contact', 'opt_out'].includes(value.outcome);
  run(
    db,
    'UPDATE cases SET outcome=?,willingness=?,ability=?,review_required=?,status=? WHERE id=?',
    value.outcome,
    value.willingness,
    value.ability,
    reviewing ? 1 : 0,
    c.suppressed
      ? 'suppressed'
      : reviewing
        ? 'review'
        : value.outcome === 'not_reached'
          ? 'unreached'
          : 'ready',
    caseId,
  );
  if (attemptId)
    run(
      db,
      'UPDATE attempts SET outcome=?,updated_at=? WHERE id=? AND case_id=?',
      value.outcome,
      now(),
      attemptId,
      caseId,
    );
  if (value.outcome === 'opt_out' || value.outcome === 'invalid_contact')
    suppress(db, caseId, OUTCOME_LABELS[value.outcome]);
  if (reviewing) {
    run(
      db,
      "UPDATE enrollments SET state='stopped',reason=? WHERE case_id=? AND state IN ('queued','waiting')",
      OUTCOME_LABELS[value.outcome],
      caseId,
    );
    task(
      db,
      caseId,
      OUTCOME_LABELS[value.outcome],
      value.callbackAt || now(),
      ['disputed', 'human_review', 'paid_reported'].includes(value.outcome) ? 'high' : 'normal',
    );
  }
  event(
    db,
    caseId,
    'outcome',
    { ...value, label: OUTCOME_LABELS[value.outcome] },
    actor,
    attemptId,
  );
  return publicCase(one(db, 'SELECT * FROM cases WHERE id=?', caseId));
}
export function createCampaign(db, input, mode) {
  assert(clean(input.name), 'Enter the campaign name.');
  assert(
    one(db, 'SELECT id FROM portfolios WHERE id=?', input.portfolioId),
    'Portfolio not found.',
  );
  assert(
    Array.isArray(input.channels) &&
      input.channels.length > 0 &&
      input.channels.length <= 4 &&
      new Set(input.channels).size === input.channels.length &&
      input.channels.every((c) => CHANNELS.includes(c)),
    'Select valid channels in order.',
  );
  assert(
    Array.isArray(input.caseIds) && input.caseIds.length > 0 && input.caseIds.length <= 10000,
    'Select between 1 and 10,000 cases.',
  );
  return transaction(db, () => {
    const cases = [...new Set(input.caseIds)].map((i) =>
      one(db, 'SELECT * FROM cases WHERE id=? AND portfolio_id=?', i, input.portfolioId),
    );
    assert(cases.every(Boolean), 'Some cases are outside the selected portfolio.');
    for (const c of cases)
      assert(
        !one(
          db,
          `SELECT 1 FROM enrollments e JOIN campaigns p ON p.id=e.campaign_id WHERE e.case_id=? AND e.state IN ('queued','waiting','dispatching') AND p.status IN ('draft','running','paused')`,
          c.id,
        ),
        `Case ${c.reference} is already in another campaign.`,
      );
    const campaign = {
      id: id(),
      portfolio_id: input.portfolioId,
      name: clean(input.name),
      channels: JSON.stringify(input.channels),
      status: 'draft',
      mode,
      created_at: now(),
    };
    run(db, 'INSERT INTO campaigns VALUES (?,?,?,?,?,?,?)', ...Object.values(campaign));
    for (const c of cases) {
      const reason = suppressionReason(db, c);
      run(
        db,
        'INSERT INTO enrollments (id,campaign_id,case_id,state,due_at,reason) VALUES (?,?,?,?,?,?)',
        id(),
        campaign.id,
        c.id,
        reason ? 'stopped' : 'queued',
        now(),
        reason,
      );
    }
    event(db, null, 'campaign_created', {
      id: campaign.id,
      name: campaign.name,
      cases: cases.length,
    });
    return campaign;
  });
}
export function campaignAction(db, campaignId, action) {
  const c = one(db, 'SELECT * FROM campaigns WHERE id=?', campaignId);
  assert(c, 'Campaign not found.', 404);
  assert(action === 'pause' || action === 'start', 'Invalid action.');
  if (action === 'pause') assert(c.status === 'running', 'The campaign is not running.');
  else {
    assert(
      !one(
        db,
        "SELECT 1 FROM portfolio_operations WHERE portfolio_id=? AND status='paused'",
        c.portfolio_id,
      ),
      'Activate the portfolio before starting its outreach.',
    );
    assert(
      ['draft', 'paused'].includes(c.status),
      'The campaign cannot be started in its current state.',
    );
  }
  run(
    db,
    'UPDATE campaigns SET status=? WHERE id=?',
    action === 'pause' ? 'paused' : 'running',
    campaignId,
  );
  event(db, null, `campaign_${action}`, { id: campaignId });
}
export function campaignList(db) {
  return all(
    db,
    `SELECT p.*, f.name portfolio_name,
    (SELECT COUNT(*) FROM enrollments WHERE campaign_id=p.id) case_count,
    (SELECT COUNT(*) FROM attempts WHERE campaign_id=p.id) attempt_count,
    (SELECT COUNT(*) FROM enrollments WHERE campaign_id=p.id AND state IN ('queued','waiting','dispatching')) pending_count,
    (SELECT COUNT(*) FROM enrollments WHERE campaign_id=p.id AND state='stopped') stopped_count
    FROM campaigns p JOIN portfolios f ON f.id=p.portfolio_id ORDER BY p.created_at DESC`,
  ).map((c) => ({ ...c, channels: JSON.parse(c.channels) }));
}
export function dashboard(db, mode) {
  const scalar = (sql) => one(db, sql).n;
  return {
    mode,
    cases: scalar('SELECT COUNT(*) n FROM cases'),
    portfolios: scalar('SELECT COUNT(*) n FROM portfolios'),
    attempts: scalar('SELECT COUNT(*) n FROM attempts'),
    rightParty: scalar('SELECT COUNT(DISTINCT case_id) n FROM attempts WHERE identity_verified=1'),
    delivered: scalar(
      "SELECT COUNT(*) n FROM attempts WHERE status IN ('delivered','read','answered','completed')",
    ),
    responses: scalar(
      "SELECT COUNT(*) n FROM cases WHERE outcome IS NOT NULL AND outcome NOT IN ('not_reached','invalid_contact')",
    ),
    openTasks: scalar("SELECT COUNT(*) n FROM tasks WHERE status='open'"),
    running: scalar(
      "SELECT COUNT(*) n FROM portfolios p WHERE EXISTS(SELECT 1 FROM portfolio_operations o WHERE o.portfolio_id=p.id AND o.status='active') OR (NOT EXISTS(SELECT 1 FROM portfolio_operations o WHERE o.portfolio_id=p.id) AND EXISTS(SELECT 1 FROM campaigns c WHERE c.portfolio_id=p.id AND c.status='running'))",
    ),
    balances: one(
      db,
      'SELECT COALESCE(SUM(amount_minor),0) total, SUM(CASE WHEN amount_minor IS NULL THEN 1 ELSE 0 END) unknown FROM cases',
    ),
    outcomes: all(
      db,
      'SELECT outcome,COUNT(*) count FROM cases WHERE outcome IS NOT NULL GROUP BY outcome',
    ),
    channels: all(
      db,
      `SELECT channel,COUNT(*) attempts,SUM(CASE WHEN status IN ('delivered','read','answered','completed') THEN 1 ELSE 0 END) delivered,SUM(identity_verified) verified FROM attempts GROUP BY channel`,
    ),
    daily: all(
      db,
      'SELECT substr(created_at,1,10) day,COUNT(*) count FROM attempts GROUP BY day ORDER BY day DESC LIMIT 14',
    ).reverse(),
    events: all(
      db,
      'SELECT e.*,c.name,c.reference FROM events e LEFT JOIN cases c ON c.id=e.case_id ORDER BY e.created_at DESC LIMIT 8',
    ),
  };
}
export function recoverQueue(db) {
  // The provider may have accepted a request before a crash. Never automatically resend it.
  for (const a of all(db, "SELECT * FROM attempts WHERE status='dispatching'")) {
    run(
      db,
      "UPDATE attempts SET status='unknown',error='Process restarted during sending; check with the provider',updated_at=? WHERE id=?",
      now(),
      a.id,
    );
    run(
      db,
      "UPDATE enrollments SET state='stopped',reason='Sending uncertain: check with the provider' WHERE id=?",
      a.enrollment_id,
    );
    run(db, "UPDATE cases SET review_required=1,status='review' WHERE id=?", a.case_id);
    task(db, a.case_id, 'Sending uncertain after restart', now(), 'high');
  }
}
export function advanceWaiting(db, at = new Date(), simulate = false, portfolioId = '') {
  const gap = policy(db).gapHours * 3600000;
  for (const e of all(
    db,
    "SELECT e.* FROM enrollments e JOIN campaigns p ON p.id=e.campaign_id WHERE e.state='waiting' AND p.status='running' AND (?='' OR p.portfolio_id=?)",
    portfolioId,
    portfolioId,
  )) {
    const a = one(
      db,
      'SELECT * FROM attempts WHERE enrollment_id=? ORDER BY step DESC LIMIT 1',
      e.id,
    );
    if (!a || (!simulate && at.getTime() - new Date(a.created_at).getTime() < gap)) continue;
    if (['answered', 'completed'].includes(a.status) && !a.outcome) {
      recordOutcome(
        db,
        e.case_id,
        { outcome: 'human_review', note: 'Call ended without a structured outcome' },
        'system',
        a.id,
      );
      continue;
    }
    if (a.outcome && !['not_reached'].includes(a.outcome)) {
      run(db, "UPDATE enrollments SET state='stopped' WHERE id=?", e.id);
      continue;
    }
    if (['dispatching', 'unknown'].includes(a.status)) continue;
    if (!a.outcome) {
      run(
        db,
        "UPDATE attempts SET outcome='not_reached',updated_at=? WHERE id=?",
        at.toISOString(),
        a.id,
      );
      event(
        db,
        e.case_id,
        'no_response',
        'No response within the configured interval',
        'system',
        a.id,
      );
    }
    run(
      db,
      "UPDATE enrollments SET state='queued',step=step+1,due_at=? WHERE id=?",
      at.toISOString(),
      e.id,
    );
  }
}
export function claimNext(
  db,
  capabilities,
  mode,
  at = new Date(),
  simulate = false,
  portfolioId = '',
) {
  return transaction(db, () => {
    const p = policy(db);
    const list = all(
      db,
      `SELECT e.*,c.channels FROM enrollments e JOIN campaigns c ON c.id=e.campaign_id WHERE e.state='queued' AND c.status='running' AND c.mode=? AND (?='' OR c.portfolio_id=?) AND NOT EXISTS(SELECT 1 FROM portfolio_operations o WHERE o.portfolio_id=c.portfolio_id AND o.status='paused') ORDER BY e.due_at LIMIT 1000`,
      mode,
      portfolioId,
      portfolioId,
    );
    for (const e of list) {
      const c = one(db, 'SELECT * FROM cases WHERE id=?', e.case_id),
        blocked = suppressionReason(db, c);
      if (blocked) {
        run(db, "UPDATE enrollments SET state='stopped',reason=? WHERE id=?", blocked, e.id);
        continue;
      }
      if (!simulate && new Date(e.due_at) > at) continue;
      const eligibleAt = simulate ? at.toISOString() : nextWindow(at, c.timezone, p);
      if (eligibleAt > at.toISOString()) {
        run(
          db,
          'UPDATE enrollments SET due_at=?,reason=? WHERE id=?',
          eligibleAt,
          'Outside the local contact window',
          e.id,
        );
        continue;
      }
      const previous = all(
        db,
        `SELECT * FROM attempts WHERE case_id=? OR destination IN (?,?) ORDER BY created_at DESC`,
        c.id,
        c.phone,
        c.email,
      );
      const active = previous.some(
        (a) =>
          ['dispatching', 'unknown'].includes(a.status) ||
          (a.channel === 'voice' &&
            ['queued', 'initiated', 'ringing', 'answered'].includes(a.status)),
      );
      if (active) {
        run(
          db,
          'UPDATE enrollments SET reason=?,due_at=? WHERE id=?',
          'Another contact is in progress or sending is uncertain',
          new Date(at.getTime() + 60000).toISOString(),
          e.id,
        );
        continue;
      }
      if (previous.length >= p.maxAttempts) {
        run(
          db,
          "UPDATE enrollments SET state='completed',reason='Attempt limit reached' WHERE id=?",
          e.id,
        );
        continue;
      }
      if (!simulate && previous.length) {
        const earliest = new Date(
          new Date(previous[0].created_at).getTime() + p.gapHours * 3600000,
        );
        if (earliest > at) {
          run(
            db,
            'UPDATE enrollments SET due_at=?,reason=? WHERE id=?',
            earliest.toISOString(),
            'Contact gap',
            e.id,
          );
          continue;
        }
      }
      const channels = JSON.parse(e.channels);
      let step = e.step,
        channel;
      for (; step < channels.length; step++) {
        const candidate = channels[step],
          destination = candidate === 'email' ? c.email : c.phone;
        if (!destination || !capabilities[candidate]?.available) {
          event(
            db,
            c.id,
            'channel_skipped',
            {
              channel: candidate,
              reason: !destination
                ? 'Missing contact details'
                : capabilities[candidate]?.reason || 'Unavailable',
            },
            'worker',
          );
          continue;
        }
        channel = candidate;
        break;
      }
      if (!channel) {
        run(
          db,
          "UPDATE enrollments SET state='completed',reason='No next channel available' WHERE id=?",
          e.id,
        );
        continue;
      }
      const attempt = {
        id: id(),
        campaign_id: e.campaign_id,
        enrollment_id: e.id,
        case_id: c.id,
        step,
        channel,
        destination: channel === 'email' ? c.email : c.phone,
        mode,
        status: 'dispatching',
        created_at: at.toISOString(),
        updated_at: at.toISOString(),
      };
      run(
        db,
        'INSERT INTO attempts (id,campaign_id,enrollment_id,case_id,step,channel,destination,mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ...Object.values(attempt),
      );
      run(
        db,
        "UPDATE enrollments SET state='dispatching',step=?,reason=NULL WHERE id=?",
        step,
        e.id,
      );
      event(db, c.id, 'attempt_started', { channel, mode }, 'worker', attempt.id);
      return { attempt, c };
    }
    return null;
  });
}
export function finishDispatch(db, attempt, result) {
  const current = one(db, 'SELECT * FROM attempts WHERE id=?', attempt.id);
  // A fast provider callback may precede the HTTP response; do not regress its state.
  run(
    db,
    'UPDATE attempts SET status=?,provider_sid=COALESCE(provider_sid,?),message=?,updated_at=? WHERE id=?',
    current.status === 'dispatching' ? result.status : current.status,
    result.sid || null,
    result.message || null,
    now(),
    attempt.id,
  );
  const c = one(db, 'SELECT * FROM cases WHERE id=?', attempt.case_id);
  run(
    db,
    'UPDATE enrollments SET state=?,reason=? WHERE id=?',
    suppressionReason(db, c) ? 'stopped' : 'waiting',
    suppressionReason(db, c),
    attempt.enrollment_id,
  );
  if (!suppressionReason(db, c)) run(db, "UPDATE cases SET status='contacted' WHERE id=?", c.id);
}
export function failDispatch(db, attempt, error) {
  run(
    db,
    "UPDATE attempts SET status='unknown',error=?,updated_at=? WHERE id=?",
    clean(error.message, 300),
    now(),
    attempt.id,
  );
  run(
    db,
    "UPDATE enrollments SET state='stopped',reason='Sending failed: review required' WHERE id=?",
    attempt.enrollment_id,
  );
  run(db, "UPDATE cases SET review_required=1,status='review' WHERE id=?", attempt.case_id);
  task(db, attempt.case_id, 'Integration failure — check sending with the provider', now(), 'high');
  event(
    db,
    attempt.case_id,
    'provider_error',
    'Sending unconfirmed. It will not be retried automatically.',
    'worker',
    attempt.id,
  );
}
export function finishCampaigns(db) {
  run(
    db,
    `UPDATE campaigns SET status='completed' WHERE status='running' AND NOT EXISTS (SELECT 1 FROM enrollments WHERE campaign_id=campaigns.id AND state IN ('queued','waiting','dispatching'))`,
  );
}
