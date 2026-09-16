# Helena: case knowledge and document retrieval

Helena remains a deterministic capability, callable by conversational agents. Structured questions (creditor, balance, agreement) use exact case lookups. Document questions use `lookup_case_information` with `topic: document_search` and a bounded `query`. The authenticated case is bound by application code; models cannot supply another case ID.

## Implemented

- Plain text uploads up to 100 KB and PDF originals up to 10 MB/50 pages.
- PDF uploads become durable ingestion records: `queued → processing → ready`, or explicit `needs_ocr`/`failed`.
- Each worker runs one to four ingestion jobs, bounded by `DOCUMENT_INGEST_CONCURRENCY`, and claims each job with ownership and a renewable three-minute lease. PostgreSQL uses `FOR UPDATE SKIP LOCKED`. Expired work is reclaimable; publication verifies ownership. Shutdown waits for active work.
- PDF.js extracts page text. Pages with little extracted text are rasterized by Poppler and read by Tesseract. Missing executables or unreadable pages leave a visible dependency; they never publish an empty success. Errors can be retried in Case library after fixing the dependency.
- Local original storage uses content-addressed SHA-256 names and exclusive writes. Files are outside public assets. Originals are downloaded only through a case-bound authenticated route. Back up `DOCUMENT_STORAGE_DIR` alongside the database. All worker hosts must see the same storage directory until an object-storage adapter is introduced.
- Documents retain immutable versions; ready delivery requests remain pinned to their selected version. Search defaults to the latest version of each title/type; older versions remain accessible by document ID.
- Passage evidence contains document ID, title, version, checksum, physical PDF page, paragraph/chunk number and bounded text. Plain text uses page 1 unless form-feed page separators exist. Overlapping chunks are at most 1,600 characters. Search returns five passages per page, with pagination.
- SQLite uses FTS5/BM25 for local development. PostgreSQL uses a GIN full-text index and `ts_rank` with the multilingual-neutral `simple` configuration. This is keyword retrieval, not semantic similarity; no embeddings or vector database are introduced.
- Existing immutable documents are backfilled on first search. New imports are indexed at publication. Queries carry explicit missing-evidence wording: no search hit is not proof that a fact is absent.

## Configuration

See `.env.example` for the document ingestion concurrency and storage settings. `DOCUMENT_PDFTOPPM_PATH` and `DOCUMENT_TESSERACT_PATH` select local binaries; defaults support Homebrew under `/opt/homebrew/bin`. `DOCUMENT_OCR_LANGUAGE` selects installed Tesseract language data (e.g. `eng`, `por`, or `eng+por`). English is the current demo default. The local development machine also has official `tessdata_fast` Portuguese data installed; other hosts must install the corresponding language pack before selecting `por` or `eng+por`. Executables run with explicit arguments, timeouts and output limits, without a shell. Rasterization is bounded to 2,000 pixels on the longest edge per page.

## Evidence and boundaries

Document text is untrusted evidence, never instructions. Retrieval does not permit a discount, change a balance, or authorize a payment agreement. OCR can misread numbers: present source uncertainty and retain originals for validation. Search does not infer facts missing from the record. The provider-neutral lookup contract leaves room for embeddings and advanced investigation later without changing Marina's delivery workflow.

PDF parsing currently happens in-process asynchronously; rasterization/OCR use subprocesses. Process isolation for hostile production documents and shared object storage remain production hardening work. Persisted ingestion state and leases survive restarts, but deployment must configure worker capacity and shared storage. The current limits deliberately bound document size rather than claim arbitrary corpus throughput.

## Verification

`tests/document-search.test.mjs` verifies case isolation, latest-version selection, page/source citations, no-hit behavior, PDF text extraction, immutable originals, duplicate uploads, expired-lease recovery and explicit missing-OCR states. An image-only PDF test runs when local Poppler/Tesseract are installed. Set `TEST_DATABASE_URL` to exercise native PostgreSQL search in a disposable schema. Existing document and supervisor tests verify pinned versions and handoff behavior.
