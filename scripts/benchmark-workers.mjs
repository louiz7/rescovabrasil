import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDb, one, run, all } from '../server/db.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';

const child = process.argv.includes('--child');
const cases = Number(process.argv.find((x) => x.startsWith('--cases='))?.split('=')[1] || 200);
const workers = Number(process.argv.find((x) => x.startsWith('--workers='))?.split('=')[1] || 4);
if (child) {
  const db = openDb(process.env.BENCHMARK_URL);
  const workflow = createAgentWorkflows(
    db,
    {
      mode: 'demo',
      agentWorkflowsEnabled: true,
      agentWorkerConcurrency: 4,
      workerBatchSize: 40,
      workerLeaseMs: 10000,
    },
    {
      runAgent: async ({ context }) => {
        const key = randomUUID();
        run(
          db,
          'INSERT INTO benchmark_calls VALUES (?,?,?,?,?)',
          key,
          context.caseId,
          Number(process.env.BENCHMARK_WORKER),
          Date.now(),
          null,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        run(db, 'UPDATE benchmark_calls SET finished=? WHERE id=?', Date.now(), key);
        return {
          action: 'reply',
          text: 'Your requested fictional document is attached.',
          provider: 'benchmark',
          model: 'deterministic-100ms',
        };
      },
    },
  );
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await workflow.tick();
    if (!one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status IN ('queued','running')").n) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await workflow.closeAll();
  db.close();
  process.exit(0);
} else {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error(
      'Set TEST_DATABASE_URL to a disposable PostgreSQL database. DATABASE_URL is never used for load tests.',
    );
  if (
    !Number.isInteger(cases) ||
    cases < 1 ||
    cases > 2000 ||
    !Number.isInteger(workers) ||
    workers < 1 ||
    workers > 16
  )
    throw new Error('Use 1..2000 cases and 1..16 workers.');
  const schema = 'bench_' + randomUUID().replaceAll('-', '');
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  await client.query(`CREATE SCHEMA "${schema}"`);
  let db;
  const children = [];
  try {
    db = openDb(url.toString());
    const config = { mode: 'demo', agentWorkflowsEnabled: true };
    const workflow = createAgentWorkflows(db, config, {
      runAgent: async () => {
        throw new Error('Parent must not execute model work.');
      },
    });
    db.exec(
      'CREATE TABLE benchmark_calls (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,worker INTEGER NOT NULL,started BIGINT NOT NULL,finished BIGINT)',
    );
    for (let n = 0; n < cases; n++) {
      const source = { provider: 'openai', sessionId: 'load_' + n };
      const saved = ensureDemoVoiceCase(db, config, source);
      workflow.documentRequested({
        ...source,
        caseId: saved.caseId,
        kind: 'loan_agreement',
        requestId: 'doc_' + n,
      });
      workflow.sourceEnded(source.provider, source.sessionId);
    }
    await workflow.closeAll();
    console.log(
      `Prepared ${cases} isolated cases. Starting ${workers} worker processes, 4 concurrent cases each.`,
    );
    const started = Date.now();
    await Promise.all(
      Array.from(
        { length: workers },
        (_, n) =>
          new Promise((resolve, reject) => {
            const p = fork(new URL(import.meta.url), ['--child'], {
              execArgv: ['--experimental-sqlite'],
              env: {
                PATH: process.env.PATH,
                PGUSER: process.env.PGUSER || process.env.USER,
                BENCHMARK_URL: url.toString(),
                BENCHMARK_WORKER: String(n),
              },
              stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            });
            children.push(p);
            let stderr = '';
            p.stderr.on('data', (d) => {
              stderr += d.toString();
            });
            p.on('error', reject);
            p.on('exit', (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`Worker ${n} failed: ${stderr.slice(-1500)}`)),
            );
          }),
      ),
    );
    const elapsedMs = Date.now() - started;
    const calls = all(db, 'SELECT * FROM benchmark_calls');
    const boundaries = calls
      .flatMap((c) => [
        { at: Number(c.started), delta: 1 },
        { at: Number(c.finished || Date.now()), delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let concurrent = 0,
      peak = 0;
    for (const b of boundaries) {
      concurrent += b.delta;
      peak = Math.max(peak, concurrent);
    }
    const result = {
      cases,
      workerProcesses: workers,
      elapsedMs,
      completedJobs: one(db, "SELECT COUNT(*) n FROM agent_jobs WHERE status='completed'").n,
      outboundMessages: one(db, "SELECT COUNT(*) n FROM agent_messages WHERE direction='outbound'")
        .n,
      modelCalls: calls.length,
      duplicateCaseCalls: one(
        db,
        'SELECT COUNT(*) n FROM (SELECT case_id FROM benchmark_calls GROUP BY case_id HAVING COUNT(*)>1) x',
      ).n,
      peakConcurrentModelCalls: peak,
      casesPerSecond: Number((cases / (elapsedMs / 1000)).toFixed(2)),
      model: 'deterministic 100ms stub; no real API, email or phone calls',
      database: 'PostgreSQL',
    };
    console.log(JSON.stringify(result, null, 2));
    if (
      result.completedJobs !== cases ||
      result.outboundMessages !== cases ||
      result.modelCalls !== cases ||
      result.duplicateCaseCalls
    )
      throw new Error('Load-test correctness assertions failed.');
  } finally {
    children.forEach((p) => {
      if (p.exitCode == null) p.kill('SIGTERM');
    });
    db?.close();
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
}
