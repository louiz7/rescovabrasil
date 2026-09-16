import { Worker } from 'node:worker_threads';

// Transitional synchronous domain API. Network I/O lives on a dedicated thread;
// each application process owns one connection. Keep transactions short: no model/network work.
export class PostgresDatabase {
  dialect = 'postgres';
  constructor(url, { timeoutMs = 30000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.memory = new SharedArrayBuffer(32 * 1024 * 1024);
    this.worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), {
      workerData: { url },
      execArgv: [],
    });
    this.worker.unref();
    this.call({ type: 'ready' });
  }
  call(request) {
    if (this.closed) throw new Error('PostgreSQL connection is closed');
    const memory = this.memory;
    const control = new Int32Array(memory, 0, 2);
    Atomics.store(control, 0, 0);
    Atomics.store(control, 1, 0);
    this.worker.postMessage({ ...request, memory });
    if (Atomics.wait(control, 0, 0, this.timeoutMs) === 'timed-out') {
      this.closed = true;
      this.worker.terminate();
      throw new Error(
        'PostgreSQL operation timed out; outcome may be uncertain. Connection closed; do not blindly retry writes.',
      );
    }
    const result = JSON.parse(Buffer.from(memory, 8, Atomics.load(control, 1)).toString());
    if (result.error)
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result;
  }
  query(sql, args = []) {
    return this.call({ type: 'native', sql, args });
  }
  exec(sql) {
    this.call({ type: 'exec', sql });
  }
  prepare(sql) {
    const execute = (args) => this.call({ type: 'query', sql, args });
    return {
      all: (...args) => execute(args).rows,
      get: (...args) => execute(args).rows[0],
      run: (...args) => {
        const r = execute(args);
        return { changes: r.rowCount, lastInsertRowid: r.lastInsertRowid };
      },
    };
  }
  close() {
    if (this.closed) return;
    this.call({ type: 'close' });
    this.closed = true;
    this.worker.terminate();
  }
}
