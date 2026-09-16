import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, run } from '../server/db.mjs';
import { outreachActivity } from '../server/outreach-activity.mjs';
const at = new Date('2026-09-16T15:00:00Z');
test('activity has fourteen calendar days, including honest zero days', () => {
  const db = openDb();
  try {
    const data = outreachActivity(db, at);
    assert.equal(data.daily.length, 14);
    assert.equal(data.total, 0);
    assert.equal(data.start, '2026-09-03');
    assert.equal(data.end, '2026-09-16');
    assert.equal(data.channels.length, 3);
  } finally {
    db.close();
  }
});
test('provider evidence, replies and simulation stay distinct, and mirrored calls are deduplicated', () => {
  const db = openDb();
  try {
    db.exec(`CREATE TABLE twilio_test_calls (provider_sid TEXT,state TEXT,created_at TEXT);
      CREATE TABLE email_deliveries (message_id TEXT,provider_message_id TEXT,status TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE agent_messages (direction TEXT,channel TEXT,status TEXT,created_at TEXT);
      CREATE TABLE debug_voice_sessions (provider TEXT,created_at TEXT);`);
    run(
      db,
      'INSERT INTO portfolios VALUES (?,?,?,?,?)',
      'p',
      'Demo',
      'Bank',
      'America/Sao_Paulo',
      at.toISOString(),
    );
    run(
      db,
      'INSERT INTO cases (id,portfolio_id,reference,timezone,created_at) VALUES (?,?,?,?,?)',
      'c',
      'p',
      'ref',
      'America/Sao_Paulo',
      at.toISOString(),
    );
    run(
      db,
      'INSERT INTO attempts (id,case_id,channel,mode,status,provider_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      'a',
      'c',
      'voice',
      'live',
      'completed',
      'CA1',
      at.toISOString(),
      at.toISOString(),
    );
    run(db, 'INSERT INTO twilio_test_calls VALUES (?,?,?)', 'CA1', 'completed', at.toISOString());
    run(
      db,
      'INSERT INTO email_deliveries VALUES (?,?,?,?,?)',
      'm1',
      'gmail1',
      'submitted',
      at.toISOString(),
      at.toISOString(),
    );
    run(
      db,
      'INSERT INTO agent_messages VALUES (?,?,?,?)',
      'outbound',
      'email',
      'sent',
      at.toISOString(),
    );
    run(
      db,
      'INSERT INTO agent_messages VALUES (?,?,?,?)',
      'outbound',
      'virtual_sms',
      'sent',
      '2026-09-16T01:00:00Z',
    );
    run(
      db,
      'INSERT INTO agent_messages VALUES (?,?,?,?)',
      'inbound',
      'email',
      'received',
      at.toISOString(),
    );
    run(db, 'INSERT INTO debug_voice_sessions VALUES (?,?)', 'twilio', at.toISOString());
    run(db, 'INSERT INTO debug_voice_sessions VALUES (?,?)', 'openai', at.toISOString());
    const data = outreachActivity(db, at);
    assert.equal(data.total, 3);
    const email = data.channels.find((v) => v.channel === 'email');
    assert.equal(email.total, 1);
    assert.equal(email.submitted, 1);
    assert.equal(email.delivered, 0);
    assert.equal(email.replies, 1);
    assert.equal(data.channels.find((v) => v.channel === 'call').completed, 1);
    assert.equal(data.channels.find((v) => v.channel === 'sms').simulated, 1);
    assert.equal(data.daily.find((v) => v.day === '2026-09-15').sms, 1);
    assert.equal(data.browserSessions, 1);
  } finally {
    db.close();
  }
});

test('unsent email is excluded and actual submissions use sending update date', () => {
  const db = openDb();
  try {
    db.exec(
      'CREATE TABLE email_deliveries (message_id TEXT,provider_message_id TEXT,status TEXT,created_at TEXT,updated_at TEXT)',
    );
    for (const [id, status, created, updated] of [
      ['queued', 'queued', at.toISOString(), at.toISOString()],
      ['cancelled', 'cancelled', at.toISOString(), at.toISOString()],
      ['sent', 'submitted', '2026-08-01T12:00:00Z', at.toISOString()],
      ['invalid', 'submitted', 'z-invalid', 'z-invalid'],
    ])
      run(
        db,
        'INSERT INTO email_deliveries VALUES (?,?,?,?,?)',
        id,
        null,
        status,
        created,
        updated,
      );
    const data = outreachActivity(db, at);
    assert.equal(data.total, 1);
    assert.equal(data.channels.find((v) => v.channel === 'email').queued, 1);
    assert.equal(data.daily.at(-1).email, 1);
  } finally {
    db.close();
  }
});

test('simulated SMS delivery is completed delivery evidence, not an in-flight attempt', () => {
  const db = openDb();
  try {
    db.exec(
      'CREATE TABLE agent_messages (direction TEXT,channel TEXT,status TEXT,created_at TEXT)',
    );
    run(
      db,
      'INSERT INTO agent_messages VALUES (?,?,?,?)',
      'outbound',
      'virtual_sms',
      'simulated_delivered',
      at.toISOString(),
    );
    const sms = outreachActivity(db, at).channels.find((row) => row.channel === 'sms');
    assert.equal(sms.total, 1);
    assert.equal(sms.simulated, 1);
    assert.equal(sms.external, 0);
    assert.equal(sms.delivered, 1);
    assert.equal(sms.pending, 0);
  } finally {
    db.close();
  }
});
