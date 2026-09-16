import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openDb, one } from '../server/db.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { startWorkerRuntime } from '../server/worker-runtime.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test('worker runtime records health, starts selected roles, and waits for ingestion before marking stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const db = openDb(),
    gate = deferred(),
    entered = deferred();
  let agentTicks = 0,
    emailTicks = 0,
    ingestionClosed = false;
  const agents = {
    tick: async () => {
      agentTicks++;
    },
    closeAll: async () => {},
    library: {
      drainIngestion: async () => {
        entered.resolve();
        await gate.promise;
      },
      closeIngestion: async () => {
        await gate.promise;
        ingestionClosed = true;
      },
    },
  };
  const runtime = startWorkerRuntime(
    db,
    {},
    {
      agents,
      email: {
        tick: async () => {
          emailTicks++;
        },
        closeAll: async () => {},
      },
      kind: 'ingestion',
      workerId: 'test-runtime',
    },
  );
  await entered.promise;
  assert.equal(agentTicks, 0);
  assert.equal(emailTicks, 0);
  const running = one(db, 'SELECT * FROM worker_runtime_health WHERE id=?', 'test-runtime');
  assert.equal(running.status, 'running');
  assert.ok(running.heartbeat_at);
  t.mock.timers.tick(10000);
  assert.notEqual(
    one(db, 'SELECT heartbeat_at FROM worker_runtime_health').heartbeat_at,
    running.heartbeat_at,
  );
  let closed = false;
  const stopping = runtime.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(one(db, 'SELECT status FROM worker_runtime_health').status, 'running');
  gate.resolve();
  await stopping;
  assert.equal(ingestionClosed, true);
  assert.equal(one(db, 'SELECT status FROM worker_runtime_health').status, 'stopped');
  db.close();
});

test(
  'standalone PostgreSQL worker starts and shuts down with durable stopped health and no providers',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 },
  async () => {
    const admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
    const schema = 'test_runtime_' + process.pid + '_' + Math.random().toString(36).slice(2);
    admin.query('CREATE SCHEMA ' + schema);
    const scoped = new URL(process.env.TEST_DATABASE_URL);
    scoped.searchParams.set('options', '-csearch_path=' + schema);
    let child;
    try {
      child = spawn(process.execPath, ['server/worker.mjs'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: scoped.href,
          OUTREACH_MODE: 'demo',
          WORKER_KIND: 'all',
          AGENT_WORKFLOWS_ENABLED: 'false',
          EMAIL_TEST_ENABLED: 'false',
          LIVE_SEND_ENABLED: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', (chunk) => {
        errors += chunk.toString();
      });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      await Promise.race([
        new Promise((resolve) => {
          let output = '';
          child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (output.includes('worker started')) resolve();
          });
        }),
        exited.then((result) => {
          throw new Error('Worker exited before startup: ' + JSON.stringify(result) + ' ' + errors);
        }),
      ]);
      child.kill('SIGTERM');
      const result = await exited;
      assert.equal(result.code, 0, errors);
      const rows = admin.query(
        'SELECT status,kind,heartbeat_at FROM ' + schema + '.worker_runtime_health',
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'stopped');
      assert.equal(rows[0].kind, 'all');
      assert.ok(rows[0].heartbeat_at);
      assert.equal(
        admin.query('SELECT COUNT(*) AS n FROM ' + schema + '.agent_model_runs').rows[0].n,
        0,
      );
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      admin.close();
    }
  },
);
