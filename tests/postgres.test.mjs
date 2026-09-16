import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, all, one, run, transaction } from '../server/db.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { migrateSqliteToPostgres } from '../scripts/migrate-postgres.mjs';
const url = process.env.TEST_DATABASE_URL;
function isolated() {
  const admin = new PostgresDatabase(url);
  const schema = 'test_pg_' + process.pid + '_' + Math.random().toString(36).slice(2);
  admin.query('CREATE SCHEMA ' + schema);
  const scoped = new URL(url);
  scoped.searchParams.set('options', '-csearch_path=' + schema);
  return {
    url: scoped.href,
    close() {
      admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      admin.close();
    },
  };
}
test(
  'PostgreSQL native persistence, aliases, ordering, nested transactions and conflict handling',
  { skip: !url },
  () => {
    const scope = isolated();
    let db;
    try {
      db = openDb(scope.url);
      assert.equal(db.dialect, 'postgres');
      run(db, 'INSERT OR IGNORE INTO settings VALUES (?,?)', 'test', "?; O'Brien");
      run(db, 'INSERT OR IGNORE INTO settings VALUES (?,?)', 'test', 'ignored');
      assert.equal(
        one(db, 'SELECT value AS testValue FROM settings WHERE key=?', 'test').testValue,
        "?; O'Brien",
      );
      transaction(db, () => {
        run(db, 'INSERT OR REPLACE INTO settings VALUES (?,?)', 'test', 'updated');
        assert.throws(() =>
          transaction(db, () => {
            run(db, 'INSERT INTO settings VALUES (?,?)', 'rollback', 'x');
            throw new Error('abort');
          }),
        );
      });
      assert.equal(one(db, 'SELECT value FROM settings WHERE key=?', 'test').value, 'updated');
      assert.equal(one(db, 'SELECT * FROM settings WHERE key=?', 'rollback'), undefined);
      assert.throws(() =>
        transaction(db, () => {
          run(db, 'INSERT INTO settings VALUES (?,?)', 'outer', 'x');
          throw new Error('abort');
        }),
      );
      assert.equal(one(db, 'SELECT * FROM settings WHERE key=?', 'outer'), undefined);
      assert.ok(all(db, 'PRAGMA table_info(attempts)').some((c) => c.name === 'identity_method'));
      assert.ok(one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", 'settings'));
      const records = all(db, 'SELECT rowid FROM settings ORDER BY rowid');
      assert.ok(records.every((r) => Number.isInteger(r.rowid)));
      db.close();
      db = openDb(scope.url);
      assert.equal(one(db, 'SELECT value FROM settings WHERE key=?', 'test').value, 'updated');
    } finally {
      db?.close();
      scope.close();
    }
  },
);
test(
  'Offline SQLite migration preserves data and row ordering and rejects nonempty targets',
  { skip: !url },
  () => {
    const scope = isolated(),
      dir = mkdtempSync(join(tmpdir(), 'rescova-migrate-')),
      path = join(dir, 'source.sqlite');
    let source = openDb(path);
    run(source, 'INSERT INTO settings VALUES (?,?)', 'migration', 'verified');
    source.close();
    try {
      const report = migrateSqliteToPostgres(path, scope.url);
      assert.ok(report.totalRows >= 2);
      const db = openDb(scope.url);
      assert.equal(
        one(db, 'SELECT value FROM settings WHERE key=?', 'migration').value,
        'verified',
      );
      run(db, 'INSERT INTO settings VALUES (?,?)', 'after', 'sequence');
      assert.ok(one(db, 'SELECT rowid FROM settings WHERE key=?', 'after').rowid > 2);
      db.close();
      assert.throws(() => migrateSqliteToPostgres(path, scope.url), /empty PostgreSQL schema/);
      source = openDb(path);
      assert.equal(one(source, 'SELECT COUNT(*) n FROM settings').n, 2);
      source.close();
    } finally {
      scope.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'PostgreSQL runs persisted agreement-to-Marina workflow with no network delivery',
  { skip: !url },
  async () => {
    const { createAgentWorkflows } = await import('../server/agent-workflows.mjs');
    const { persistDemoAgreement } = await import('../server/demo-platform.mjs');
    const { isolatedDatabase, executeTestTool } = await import('../server/browser-voice.mjs');
    const { executePaymentSolution } = await import('../server/demo-payment.mjs');
    const scope = isolated(),
      db = openDb(scope.url),
      voice = isolatedDatabase('pg-workflow');
    let workflow;
    try {
      executeTestTool(voice, 'pg-workflow', 'confirm_identity', {
        confirmed: true,
        name: 'Ana Silva',
      });
      const agreement = executePaymentSolution(voice, 'pg-workflow', {
        offerId: 'three_installments',
        accepted: true,
      }).agreement;
      const config = { mode: 'demo', agentWorkflowsEnabled: true };
      const saved = persistDemoAgreement(db, config, {
        provider: 'openai',
        sessionId: 'pg-workflow',
        agreement,
      });
      workflow = createAgentWorkflows(db, config, {
        runAgent: async () => ({
          action: 'reply',
          text: 'Your demo agreement is available.',
          provider: 'test',
          model: 'fake',
        }),
      });
      const input = {
        provider: 'openai',
        sessionId: 'pg-workflow',
        caseId: saved.caseId,
        agreementId: agreement.id,
      };
      const { conversationId } = transaction(db, () => workflow.agreementSaved(input));
      await workflow.tick();
      assert.equal(workflow.detail(conversationId).messages.length, 0);
      workflow.sourceEnded('openai', 'pg-workflow');
      await workflow.tick();
      const detail = workflow.detail(conversationId);
      assert.equal(detail.messages.length, 1);
      assert.equal(detail.messages[0].status, 'simulated_delivered');
      assert.equal(detail.tasks[0].status, 'completed');
    } finally {
      await workflow?.closeAll();
      voice.close();
      db.close();
      scope.close();
    }
  },
);
