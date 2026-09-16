# Storage and worker operations

Implemented 16 September 2026. PostgreSQL is the shared store for multi-process agent work. SQLite remains available for combined local development and isolated tests. Provider authorization and the current demo recipient restrictions still apply.

## Deployment shape

Run **one API process** and any required background worker processes against the same PostgreSQL database. The API still owns in-memory login sessions, live voice connections and the older portfolio dispatch queue. This release does not support horizontally replicating the API or the legacy dispatch queue.

The PostgreSQL compatibility adapter preserves synchronous application database calls: SQL runs through a dedicated connection worker, but the calling process waits for the result. Additional background processes provide parallel capacity; this is not a conversion of every request handler to asynchronous SQL.

For the simplest local setup, retain `APP_WORKERS_ENABLED=true`: the API also schedules background work. For separate workers, configure the API `.env`:

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/rescova
APP_WORKERS_ENABLED=false
AGENT_WORKER_CONCURRENCY=4
EMAIL_WORKER_CONCURRENCY=2
WORKER_LEASE_MS=60000
WORKER_BATCH_SIZE=40
DOCUMENT_STORAGE_DIR=data/documents
DOCUMENT_INGEST_CONCURRENCY=1
```

Start the API with `npm run server` or `npm run dev`. In separate processes, start either combined workers:

```sh
WORKER_KIND=all npm run worker
```

or selected roles:

```sh
WORKER_KIND=agent npm run worker
WORKER_KIND=email npm run worker
WORKER_KIND=ingestion npm run worker
```

Standalone workers require PostgreSQL. Keep database, operating mode, model/provider configuration and document storage consistent across processes. Concurrency settings are **per process**, not global provider rate limits; adding workers multiplies possible provider requests. Agent concurrency is capped at 32 and email concurrency at 16 per process. Begin with small values and observe actual provider latency, limits and queue age before increasing them.

Current scheduling intervals are one second for agent work, 15 seconds for email synchronization, two seconds for document ingestion and ten seconds for worker heartbeats. Email synchronization also invokes the agent queue to prepare replies, so selecting the email role is not a hard isolation boundary for model execution.

## Ownership, recovery and delivery

Agent generation and email synchronization/delivery acquire the same durable `case:<id>` lease. Independent cases can proceed concurrently; one case is owned by one worker at a time. Tasks retain their originating channel, and an earlier waiting or failed task prevents later agent work from overtaking it.

Each lease acquisition has a unique token. Heartbeats renew its expiry; expiry or replacement aborts supported model work. Before committing model results, the worker validates its token inside the transaction. A replaced worker cannot publish stale output. Startup never resets another worker's live jobs.

An expired model generation can be retried after another worker acquires the case. An expired email send becomes `uncertain`: the provider may already have accepted it. It is not automatically resent, and later messages remain held for investigation. Check Gmail and the stored message identifiers before deciding how to reconcile it. Fencing cannot recall a provider request already submitted before lease loss.

Use SIGTERM/SIGINT for shutdown. Standalone workers stop scheduling, drain/abort current work, close ingestion and release resources; the process has a 90-second shutdown deadline. After an unclean exit, recovery waits for lease expiry. Do not manually clear live leases to accelerate recovery.

## Documents and retrieval

Structured facts remain authoritative database reads. Helena's deterministic `document_search` capability searches case-scoped passages with document/version/page provenance. SQLite uses FTS5; PostgreSQL uses its full-text search facilities. Financial permissions and saved agreements never come from a search index.

Original PDFs live under `DOCUMENT_STORAGE_DIR`, while ingestion tasks and derived passages live in the database. API and ingestion workers must share the same persistent directory when deployed on different processes or hosts. Back up both the database and original documents. Managed object storage, embeddings and a knowledge graph remain planned; this release does not depend on them. PDF/OCR tool paths and language configuration are documented in `.env.example`.

## Offline migration from SQLite

1. Stop the API and all workers. Take a backup of the SQLite database and its WAL/SHM files if present, plus document storage. A clean SQLite backup is preferable to copying a database while it is being written.
2. Create an **empty** PostgreSQL database/schema. Do not start the API against it first.
3. Set the destination `DATABASE_URL`, then run:

   ```sh
   npm run migrate:postgres -- /absolute/path/to/source.sqlite
   ```

4. Keep the migration report. The migration reads the source without modifying it, preserves row ordering, verifies counts and batched content checksums, repairs identity sequences and commits the destination atomically. A nonempty destination or mismatch fails the migration. SQLite virtual search indexes are excluded; derived search structures are initialized by the application.
5. Start one API against PostgreSQL, check the portfolio/case counts, documents and existing conversation histories, then start background workers. Keep the original SQLite backup until validation is complete. Reverting after new PostgreSQL writes needs explicit reconciliation; switching back to the old file would lose those writes.

## Local PostgreSQL on this machine

The development instance uses Homebrew PostgreSQL 15, port `55432`, with a private Unix socket under `/Users/louizel-hosri/Desktop/RescovaBR/data/postgres`. 

After restarting this machine, start the existing cluster from the repository root before `npm run dev`:

```sh
/opt/homebrew/opt/postgresql@15/bin/pg_ctl -D data/postgres -l data/postgres/server.log start
```

The cluster does not listen on TCP and is not installed as an automatic startup service. Check it with `pg_ctl -D data/postgres status` using the same executable path. A local socket connection has this form:

```text
postgresql:///rescova_test?host=/Users/louizel-hosri/Desktop/RescovaBR/data/postgres&port=55432
```

The local application currently uses `rescova_app`; its migration verified 21 cases and 221 total rows with counts and checksums. The pre-migration SQLite backup is `data/backups/pre-postgres-20260916.sqlite`. The local app is available on port 5173 and its API uses an embedded worker, and OCR is configured for `eng+por`.

`rescova_test` is for isolated integration tests. Use the configured application database for the app; do not point normal application work at a test schema. This machine-specific socket is not a production deployment configuration.

## Monitoring and validation

The authenticated `GET /api/workers` endpoint exposes worker health and queue/lease information. Inspect heartbeat age, queued work, oldest queued timestamp, running jobs and lease owners. Also monitor Rafael's escalation tracker, document ingestion failures and email `uncertain`/`failed` states. A running process with an aging queue is not sufficient evidence of healthy processing.

Integration tests use `TEST_DATABASE_URL` and create isolated temporary PostgreSQL schemas. No live provider is needed for these checks:

```sh
TEST_DATABASE_URL='<test database URL>' node --test tests/postgres.test.mjs tests/postgres-app.test.mjs tests/worker-leases.test.mjs
TEST_DATABASE_URL='<test database URL>' npm run benchmark:workers -- --cases=200 --workers=4
```

Measured local benchmark: **200 cases, four processes, peak 16 concurrent mocked model requests, 2,058 ms, 97.18 cases/second, 200 outputs and zero duplicates**. Each model call was a deterministic 100 ms mock. This validates the tested queue/coordination workload, not live model, email or telephony throughput. Re-measure with representative documents, provider latency, rate limits and sustained workloads before making production capacity claims.
