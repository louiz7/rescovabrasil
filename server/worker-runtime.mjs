import { randomUUID } from 'node:crypto';
import { run, now } from './db.mjs';

// Scheduling is separate from HTTP and agent policy. Durable case leases live in the workflows.
export function startWorkerRuntime(
  db,
  config,
  { agents, email, planner = null, kind = 'all', workerId = randomUUID() },
) {
  const roles = {
    agent: kind === 'all' || kind === 'agent',
    email: kind === 'all' || kind === 'email',
    ingestion: kind === 'all' || kind === 'ingestion',
  };
  if (!Object.values(roles).some(Boolean))
    throw new Error('WORKER_KIND must be all, agent, email or ingestion.');
  db.exec(`CREATE TABLE IF NOT EXISTS worker_runtime_health (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL);`);
  run(
    db,
    "INSERT INTO worker_runtime_health VALUES (?,?,?,?,'running')",
    workerId,
    kind,
    now(),
    now(),
  );
  let stopping = false;
  const jobs = new Set(),
    timers = [];
  function schedule(label, fn, interval) {
    let pending = false;
    const invoke = () => {
      if (pending || stopping) return;
      pending = true;
      const task = Promise.resolve()
        .then(fn)
        .catch(() => console.error(`${label} worker tick failed.`))
        .finally(() => {
          pending = false;
          jobs.delete(task);
        });
      jobs.add(task);
    };
    timers.push(setInterval(invoke, interval));
    invoke();
  }
  if (roles.agent) schedule('Agent', () => agents.tick(), 1000);
  if (roles.agent && planner) schedule('Portfolio planner', () => planner.tick(), 60000);
  if (roles.email) schedule('Email', () => email.tick(), 15000);
  if (roles.ingestion && agents.library.drainIngestion)
    schedule('Document ingestion', () => agents.library.drainIngestion(), 2000);
  timers.push(
    setInterval(() => {
      try {
        run(db, 'UPDATE worker_runtime_health SET heartbeat_at=? WHERE id=?', now(), workerId);
      } catch {
        console.error('Worker heartbeat failed.');
      }
    }, 10000),
  );
  return {
    workerId,
    roles,
    async close() {
      stopping = true;
      timers.forEach(clearInterval);
      await email.closeAll();
      await agents.closeAll();
      await agents.library.closeIngestion?.();
      await Promise.allSettled([...jobs]);
      run(
        db,
        "UPDATE worker_runtime_health SET status='stopped',heartbeat_at=? WHERE id=?",
        now(),
        workerId,
      );
    },
  };
}
