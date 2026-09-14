import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS portfolios (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, creditor TEXT NOT NULL, timezone TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS portfolio_operations (
      portfolio_id TEXT PRIMARY KEY REFERENCES portfolios(id), status TEXT NOT NULL, channels TEXT NOT NULL,
      mode TEXT NOT NULL, activated_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL REFERENCES portfolios(id), reference TEXT NOT NULL,
      name TEXT, phone TEXT, email TEXT, amount_minor INTEGER, currency TEXT NOT NULL DEFAULT 'BRL',
      due_date TEXT, timezone TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'pt-BR',
      verification_hash TEXT, status TEXT NOT NULL DEFAULT 'ready', outcome TEXT,
      willingness TEXT NOT NULL DEFAULT 'unknown', ability TEXT NOT NULL DEFAULT 'unknown',
      identity_verified_at TEXT, suppressed INTEGER NOT NULL DEFAULT 0,
      review_required INTEGER NOT NULL DEFAULT 0, source_import TEXT, created_at TEXT NOT NULL,
      UNIQUE(portfolio_id,reference));
    CREATE INDEX IF NOT EXISTS cases_phone ON cases(phone);
    CREATE INDEX IF NOT EXISTS cases_email ON cases(email);
    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL REFERENCES portfolios(id), filename TEXT NOT NULL,
      headers TEXT NOT NULL, rows TEXT NOT NULL, mapping TEXT, report TEXT,
      status TEXT NOT NULL DEFAULT 'staged', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL REFERENCES portfolios(id), name TEXT NOT NULL,
      channels TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', mode TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      case_id TEXT NOT NULL REFERENCES cases(id), step INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'queued', due_at TEXT NOT NULL, reason TEXT,
      UNIQUE(campaign_id,case_id));
    CREATE INDEX IF NOT EXISTS queue_due ON enrollments(state,due_at);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, campaign_id TEXT REFERENCES campaigns(id), enrollment_id TEXT REFERENCES enrollments(id),
      case_id TEXT NOT NULL REFERENCES cases(id), step INTEGER, channel TEXT NOT NULL, destination TEXT,
      mode TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, provider_sid TEXT UNIQUE,
      identity_verified INTEGER NOT NULL DEFAULT 0, verification_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message TEXT, error TEXT,
      UNIQUE(enrollment_id,step));
    CREATE INDEX IF NOT EXISTS attempts_case ON attempts(case_id,created_at);
    CREATE INDEX IF NOT EXISTS attempts_destination ON attempts(destination,created_at);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, case_id TEXT REFERENCES cases(id), attempt_id TEXT REFERENCES attempts(id),
      kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), reason TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS open_task_per_case ON tasks(case_id) WHERE status='open';
    CREATE TABLE IF NOT EXISTS suppressions (
      address TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('policy','{"startHour":9,"endHour":18,"gapHours":24,"maxAttempts":3,"excludedDates":[]}');
    PRAGMA user_version=2;`);
  if (
    !db
      .prepare('PRAGMA table_info(attempts)')
      .all()
      .some((c) => c.name === 'identity_method')
  )
    db.exec('ALTER TABLE attempts ADD COLUMN identity_method TEXT');
  return db;
}
export const all = (db, sql, ...args) => db.prepare(sql).all(...args);
export const one = (db, sql, ...args) => db.prepare(sql).get(...args);
export const run = (db, sql, ...args) => db.prepare(sql).run(...args);
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function event(db, caseId, kind, detail, actor = 'operator', attemptId = null) {
  run(
    db,
    'INSERT INTO events VALUES (?,?,?,?,?,?,?)',
    id(),
    caseId,
    attemptId,
    kind,
    actor,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
    now(),
  );
}
export function task(db, caseId, reason, due = now(), priority = 'normal') {
  run(
    db,
    `INSERT INTO tasks (id,case_id,reason,priority,due_at,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(case_id) WHERE status='open' DO UPDATE SET reason=excluded.reason, due_at=excluded.due_at,
    priority=CASE WHEN tasks.priority='high' THEN 'high' ELSE excluded.priority END`,
    id(),
    caseId,
    reason,
    priority,
    due,
    now(),
  );
}
