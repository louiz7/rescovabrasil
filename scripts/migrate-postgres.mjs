import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PostgresDatabase } from '../server/postgres.mjs';

const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
// Explicit offline migration: source read-only, target must have no application tables.
export function migrateSqliteToPostgres(sourcePath, targetUrl) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new PostgresDatabase(targetUrl);
  let begun = false;
  try {
    const existing = target.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()`,
    );
    if (existing.rows.length)
      throw new Error(
        'Migration requires an empty PostgreSQL schema; existing data was not changed',
      );
    const virtual = source
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
      )
      .all()
      .map((r) => r.name);
    const tables = source
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .filter((t) => !virtual.some((name) => t.name === name || t.name.startsWith(name + '_')));
    const ordered = [],
      pending = [...tables];
    while (pending.length) {
      const next = pending.findIndex((t) =>
        [...t.sql.matchAll(/REFERENCES\s+["`]?([\w]+)/gi)].every(
          (m) => m[1] === t.name || ordered.some((x) => x.name === m[1]),
        ),
      );
      if (next < 0)
        throw new Error(
          'Cyclic or missing table dependency: migration needs an explicit schema migration',
        );
      ordered.push(pending.splice(next, 1)[0]);
    }
    source.exec('BEGIN');
    target.exec('BEGIN');
    begun = true;
    const report = [];
    for (const table of ordered) target.exec(table.sql);
    for (const table of ordered) {
      const names = source
        .prepare(`PRAGMA table_info(${quote(table.name)})`)
        .all()
        .map((r) => r.name);
      const sourceRows = source
        .prepare(
          `SELECT rowid AS __migration_rowid,${names.map(quote).join(',')} FROM ${quote(table.name)} ORDER BY rowid`,
        )
        .iterate();
      const sql = `INSERT INTO ${quote(table.name)} (rowid,${names.map(quote).join(',')}) VALUES (${Array.from({ length: names.length + 1 }, (_, i) => '$' + (i + 1)).join(',')})`;
      const hash = createHash('sha256');
      let count = 0,
        batch = [];
      const verify = () => {
        if (!batch.length) return;
        const copied = target.query(
          `SELECT rowid AS __migration_rowid,${names.map(quote).join(',')} FROM ${quote(table.name)} WHERE rowid=ANY($1::bigint[]) ORDER BY rowid`,
          [batch.map((row) => row.__migration_rowid)],
        ).rows;
        if (batch.length !== copied.length || digest(batch) !== digest(copied))
          throw new Error('Migration reconciliation failed for ' + table.name);
        for (const row of batch) hash.update(JSON.stringify(row) + '\n');
        batch = [];
      };
      for (const row of sourceRows) {
        target.query(sql, [row.__migration_rowid, ...names.map((name) => row[name])]);
        batch.push(row);
        count++;
        if (batch.length >= 100) verify();
      }
      verify();
      if (
        Number(target.query(`SELECT COUNT(*) AS count FROM ${quote(table.name)}`).rows[0].count) !==
        count
      )
        throw new Error('Migration row count mismatch for ' + table.name);
      target.query(
        `SELECT setval(pg_get_serial_sequence($1,'rowid'),COALESCE((SELECT MAX(rowid) FROM ${quote(table.name)}),1),EXISTS(SELECT 1 FROM ${quote(table.name)}))`,
        [table.name],
      );
      report.push({ table: table.name, rows: count, checksum: hash.digest('hex') });
    }
    for (const index of source
      .prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all()) {
      if (ordered.some((t) => t.name === index.tbl_name)) target.exec(index.sql);
    }
    target.exec('COMMIT');
    begun = false;
    source.exec('ROLLBACK');
    return {
      tables: report,
      excludedDerivedIndexes: virtual,
      totalRows: report.reduce((n, t) => n + t.rows, 0),
    };
  } catch (error) {
    if (begun) target.exec('ROLLBACK');
    throw error;
  } finally {
    source.close();
    target.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2];
  if (!source || !process.env.DATABASE_URL?.startsWith('postgres')) {
    console.error(
      'Usage: DATABASE_URL=<postgres URL> node scripts/migrate-postgres.mjs <source.sqlite>',
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(migrateSqliteToPostgres(source, process.env.DATABASE_URL), null, 2),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
