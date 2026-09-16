import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb as openDatabase, one, run } from '../server/db.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { createWorkerLeases } from '../server/worker-leases.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { createEmailWorkflows } from '../server/email-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';

function openDb() {
  if (!process.env.TEST_DATABASE_URL) return openDatabase();
  const admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
  const schema = 'test_workers_' + process.pid + '_' + Math.random().toString(36).slice(2);
  admin.query('CREATE SCHEMA ' + schema);
  const scoped = new URL(process.env.TEST_DATABASE_URL);
  scoped.searchParams.set('options', '-csearch_path=' + schema);
  const db = openDatabase(scoped.href),
    close = db.close.bind(db);
  db.close = () => {
    close();
    admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    admin.close();
  };
  return db;
}

const config = {
  mode: 'demo',
  agentWorkflowsEnabled: true,
  agentWorkerConcurrency: 3,
  emailTestEnabled: true,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function seed(db, workflow, sessionId, deliveryChannel) {
  const source = { provider: 'openai', sessionId };
  const saved = ensureDemoVoiceCase(db, config, source);
  const result = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: sessionId,
    deliveryChannel,
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  return { ...saved, ...result };
}
test('atomic leases exclude other workers and expired tokens cannot commit or release a successor', () => {
  const db = openDb();
  const a = createWorkerLeases(db),
    b = createWorkerLeases(db);
  const first = a.acquire('case:one');
  assert.equal(b.acquire('case:one'), null);
  run(db, 'UPDATE worker_leases SET expires_at=0 WHERE resource=?', 'case:one');
  const second = b.acquire('case:one');
  assert.ok(second);
  assert.throws(() => first.assertCurrent(), /expired/);
  first.release();
  second.assertCurrent();
  second.release();
  db.close();
});
test('multiple workflow instances never reset or duplicate a live model job; independent cases run concurrently', async () => {
  const db = openDb(),
    gate = deferred(),
    entered = deferred();
  let calls = 0,
    inFlight = 0,
    peak = 0;
  const runAgent = async () => {
    calls++;
    peak = Math.max(peak, ++inFlight);
    if (calls === 3) entered.resolve();
    await gate.promise;
    inFlight--;
    return { action: 'reply', text: 'Here is your document.' };
  };
  const first = createAgentWorkflows(db, config, { runAgent });
  for (let i = 0; i < 3; i++) seed(db, first, `parallel-${i}`);
  const running = first.tick();
  await entered.promise;
  const second = createAgentWorkflows(db, config, { runAgent });
  await second.tick();
  assert.equal(calls, 3);
  assert.equal(one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='running'").n, 3);
  gate.resolve();
  await running;
  assert.equal(peak, 3);
  assert.equal(one(db, "SELECT COUNT(*) n FROM agent_messages WHERE direction='outbound'").n, 3);
  await first.closeAll();
  await second.closeAll();
  db.close();
});
test('expired model worker output is fenced and its job is safely regenerated once', async () => {
  const db = openDb(),
    gate = deferred(),
    entered = deferred();
  const first = createAgentWorkflows(db, config, {
    runAgent: async () => {
      entered.resolve();
      await gate.promise;
      return { action: 'reply', text: 'Stale answer.' };
    },
  });
  const seeded = seed(db, first, 'expired');
  const running = first.tick();
  await entered.promise;
  run(db, 'UPDATE worker_leases SET expires_at=0');
  const second = createAgentWorkflows(db, config, {
    runAgent: async () => ({ action: 'reply', text: 'Current answer.' }),
  });
  await second.tick();
  gate.resolve();
  await running;
  const messages = first.detail(seeded.conversationId).messages;
  assert.equal(messages.filter((m) => m.direction === 'outbound').length, 1);
  assert.equal(messages.find((m) => m.direction === 'outbound').body, 'Current answer.');
  await first.closeAll();
  await second.closeAll();
  db.close();
});
test('email workers do not reset live sending and an expired ambiguous send is never retried', async () => {
  const db = openDb(),
    entered = deferred(),
    gate = deferred();
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async () => ({ action: 'reply', text: 'Here is your document.' }),
  });
  seed(db, workflow, 'email-lease', 'email');
  await workflow.tick();
  let sends = 0;
  const transport = {
    status: () => ({ configured: true }),
    verifyMailbox: async () => {},
    getThread: async () => [],
    send: async (input) => {
      input.beforeSend();
      sends++;
      entered.resolve();
      await gate.promise;
      return { providerMessageId: 'sent', threadId: 'thread', messageId: '<sent>' };
    },
  };
  const first = createEmailWorkflows(db, config, workflow, { transport });
  const running = first.tick();
  await entered.promise;
  const second = createEmailWorkflows(db, config, workflow, { transport });
  await second.tick();
  assert.equal(one(db, 'SELECT status FROM email_deliveries').status, 'sending');
  assert.equal(sends, 1);
  run(db, 'UPDATE worker_leases SET expires_at=0');
  await second.tick();
  assert.equal(one(db, 'SELECT status FROM email_deliveries').status, 'uncertain');
  gate.resolve();
  await running;
  await second.tick();
  assert.equal(sends, 1);
  assert.equal(one(db, 'SELECT status FROM email_deliveries').status, 'uncertain');
  await first.closeAll();
  await second.closeAll();
  await workflow.closeAll();
  db.close();
});

test('heartbeats retain a long-running lease beyond its initial expiry', async () => {
  const db = openDb(),
    leases = createWorkerLeases(db, { workerLeaseMs: 120 });
  const lease = leases.acquire('case:heartbeat');
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(createWorkerLeases(db).acquire('case:heartbeat'), null);
  lease.assertCurrent();
  lease.release();
  db.close();
});
