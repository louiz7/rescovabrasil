import { randomUUID } from 'node:crypto';
import { one, run, all } from './db.mjs';

// Each acquisition gets a fresh fencing token, even within the same process.
export function createWorkerLeases(db, config = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_leases (
    resource TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL,
    expires_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
  const owner = `${config.workerIdentity || 'worker'}:${randomUUID()}`;
  const duration = Math.max(100, Number(config.workerLeaseMs) || 60000);
  function acquire(resource) {
    const token = randomUUID(),
      time = Date.now();
    const claimed = one(
      db,
      `INSERT INTO worker_leases(resource,owner,token,expires_at,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,
      token=excluded.token,expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE worker_leases.expires_at<=? RETURNING token`,
      resource,
      owner,
      token,
      time + duration,
      time,
      time,
    );
    if (!claimed) return null;
    let lost = false;
    const controller = new AbortController();
    function valid() {
      return (
        !lost &&
        !!one(
          db,
          'SELECT 1 FROM worker_leases WHERE resource=? AND token=? AND expires_at>?',
          resource,
          token,
          Date.now(),
        )
      );
    }
    function assertCurrent() {
      const time = Date.now();
      // UPDATE locks the lease row until an enclosing transaction commits on PostgreSQL.
      if (
        lost ||
        !run(
          db,
          'UPDATE worker_leases SET expires_at=?,updated_at=? WHERE resource=? AND token=? AND expires_at>?',
          time + duration,
          time,
          resource,
          token,
          time,
        ).changes
      ) {
        lost = true;
        controller.abort();
        throw Object.assign(new Error('Worker lease expired or was replaced.'), {
          leaseLost: true,
        });
      }
    }
    const heartbeat = setInterval(
      () => {
        try {
          const time = Date.now();
          if (
            !run(
              db,
              'UPDATE worker_leases SET expires_at=?,updated_at=? WHERE resource=? AND token=? AND expires_at>?',
              time + duration,
              time,
              resource,
              token,
              time,
            ).changes
          ) {
            lost = true;
            controller.abort();
          }
        } catch {
          lost = true;
          controller.abort();
        }
      },
      Math.max(25, Math.floor(duration / 3)),
    );
    heartbeat.unref();
    return {
      resource,
      token,
      owner,
      valid,
      assertCurrent,
      signal: controller.signal,
      release() {
        clearInterval(heartbeat);
        run(db, 'DELETE FROM worker_leases WHERE resource=? AND token=?', resource, token);
        lost = true;
      },
    };
  }
  return {
    acquire,
    owner,
    stats: () => ({
      active: all(
        db,
        'SELECT resource,owner,expires_at FROM worker_leases WHERE expires_at>?',
        Date.now(),
      ),
    }),
  };
}

export async function boundedMap(items, concurrency, work) {
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, Math.max(1, Math.min(32, Number(concurrency) || 1))) },
      async () => {
        while (cursor < items.length) await work(items[cursor++]);
      },
    ),
  );
}
