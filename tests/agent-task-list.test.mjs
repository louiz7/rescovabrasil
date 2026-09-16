import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb as openDatabase, run, now } from '../server/db.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { createEmailWorkflows } from '../server/email-workflows.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { PostgresDatabase } from '../server/postgres.mjs';
import { agentTaskList } from '../server/agent-task-list.mjs';

function openDb() {
  if (!process.env.TEST_DATABASE_URL) return openDatabase();
  const admin = new PostgresDatabase(process.env.TEST_DATABASE_URL);
  const schema = 'test_task_list_' + process.pid + '_' + Math.random().toString(36).slice(2);
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

test('agent task projection preserves real owners, blocked work and provider submission semantics', async () => {
  const db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true };
  const workflow = createAgentWorkflows(db, config);
  const email = createEmailWorkflows(db, config, workflow);
  try {
    const source = { provider: 'openai', sessionId: 'task-projection' };
    const saved = ensureDemoVoiceCase(db, config, source);
    const result = workflow.documentRequested({
      ...source,
      caseId: saved.caseId,
      kind: 'loan_agreement',
      requestId: 'task-projection',
    });
    const conversationId = result.conversationId;
    assert.ok(conversationId);
    assert.equal(agentTaskList(db, { owner: 'Helena' }).total, 1);
    assert.equal(agentTaskList(db, { owner: 'Marina' }).total, 0);
    assert.equal(agentTaskList(db, { owner: 'Rafael' }).rows.length, 0);
    let tasks = agentTaskList(db);
    assert.equal(tasks.rows[0].owner, 'Helena');
    assert.equal(tasks.rows[0].source, 'document_ticket');
    assert.equal(tasks.rows.length, 1, 'The linked worker job is hidden behind its parent ticket');
    assert.equal(tasks.rows[0].status, 'waiting_source_end');
    assert.match(tasks.rows[0].next_action, /call to end/);
    run(
      db,
      'INSERT INTO agent_resolutions (conversation_id,status,reason,next_action,context_json,updated_at) VALUES (?,?,?,?,?,?)',
      conversationId,
      'blocked_policy',
      'Unauthorized terms',
      'Find an authorized offer',
      '{}',
      now(),
    );
    run(
      db,
      'INSERT INTO agent_messages (id,conversation_id,direction,body,status,request_id,created_at) VALUES (?,?,?,?,?,?,?)',
      'task-msg',
      conversationId,
      'outbound',
      'Demo message',
      'sent',
      'task-msg',
      now(),
    );
    run(
      db,
      'INSERT INTO email_deliveries (id,conversation_id,message_id,subject,body,attachments_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      'task-email',
      conversationId,
      'task-msg',
      'Agreement',
      'Demo message',
      '[]',
      'submitted',
      now(),
      now(),
    );
    tasks = agentTaskList(db, { state: 'all', limit: 1 });
    assert.equal(tasks.total, 3);
    assert.equal(tasks.rows.length, 1);
    assert.equal(tasks.counts.open, 2);
    assert.equal(tasks.counts.completed, 1);
    const resolution = agentTaskList(db).rows.find((r) => r.source === 'resolution');
    assert.equal(resolution.owner, 'Rafael');
    assert.equal(resolution.next_action, 'Find an authorized offer');
    const delivery = agentTaskList(db, { state: 'completed' }).rows[0];
    assert.equal(delivery.owner, 'Delivery worker');
    assert.match(delivery.next_action, /no delivery confirmation/);
    run(db, "UPDATE email_deliveries SET status='uncertain' WHERE id='task-email'");
    assert.match(
      agentTaskList(db).rows.find((r) => r.source === 'email_delivery').next_action,
      /automatic resend is held/,
    );
  } finally {
    await email.closeAll();
    await workflow.closeAll();
    await workflow.library.closeIngestion();
    db.close();
  }
});

test('empty task projection supports databases without optional workflow tables', () => {
  const db = openDb();
  try {
    assert.deepEqual(agentTaskList(db).rows, []);
  } finally {
    db.close();
  }
});

test('future installments are scheduled in the case timezone and waiting dependencies take precedence', async () => {
  const db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true };
  const workflow = createAgentWorkflows(db, config);
  try {
    const { registerPaymentAgreement } = await import('../server/payments.mjs');
    const { caseId } = ensureDemoVoiceCase(db, config, {
      provider: 'openai',
      sessionId: 'scheduled-test',
    });
    registerPaymentAgreement(db, caseId, {
      id: 'scheduled-agreement',
      demo: true,
      currency: 'BRL',
      totalMinor: 20000,
      timezone: 'America/Sao_Paulo',
      installments: [
        { amountMinor: 10000, dueDate: '2030-01-10' },
        { amountMinor: 10000, dueDate: '2030-02-10' },
      ],
    });
    let result = agentTaskList(db, {
      owner: 'Marina',
      state: 'scheduled',
      at: '2030-01-10T01:00:00Z',
      limit: 1,
    });
    assert.equal(result.total, 2);
    assert.equal(result.rows[0].due_at, '2030-01-10');
    assert.equal(result.counts.ready, 1); // Instruction task, not a future reminder.
    result = agentTaskList(db, { owner: 'Marina', state: 'scheduled', at: '2030-01-10T04:00:00Z' });
    assert.equal(result.total, 1);
    assert.equal(result.counts.ready, 2);
    run(db, "UPDATE payment_tasks SET status='waiting_policy' WHERE due_at='2030-02-10'");
    result = agentTaskList(db, { owner: 'Marina', state: 'waiting', at: '2030-01-10T04:00:00Z' });
    assert.equal(result.total, 1);
    assert.equal(result.counts.scheduled, 0);
    assert.equal(result.counts.open, 3);
    assert.equal(
      agentTaskList(db, { owner: 'Rafael', state: 'waiting', at: '2030-01-10T04:00:00Z' }).total,
      0,
    );
  } finally {
    await workflow.closeAll();
    await workflow.library.closeIngestion();
    db.close();
  }
});
