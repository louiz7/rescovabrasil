import { Router } from 'express';
import { createHash } from 'node:crypto';
import { id, now, one, all, run, event } from './db.mjs';

const kinds = new Set(['loan_agreement', 'account_statement']);
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS case_documents (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), title TEXT NOT NULL,
    kind TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL, content TEXT NOT NULL,
    checksum TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(case_id,kind,title,version));
    CREATE TABLE IF NOT EXISTS document_requests (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), kind TEXT NOT NULL,
    request_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', document_id TEXT REFERENCES case_documents(id),
    error TEXT, created_at TEXT NOT NULL, UNIQUE(case_id,request_key));`);
}
function requireCase(db, caseId) {
  const row = one(db, 'SELECT * FROM cases WHERE id=?', caseId);
  if (!row) fail(404, 'Case not found');
  return row;
}
function insertDocument(db, caseId, { title, kind, content, source = 'operator_demo_upload' }) {
  requireCase(db, caseId);
  if (!kinds.has(kind)) fail(400, 'Unsupported document kind');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 160)
    fail(400, 'Document title must contain 1–160 characters');
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    Buffer.byteLength(content, 'utf8') > 100 * 1024
  )
    fail(400, 'Document content must be nonempty plain text, at most 100 KB');
  title = title.trim();
  const checksum = createHash('sha256').update(content).digest('hex');
  const prior = one(
    db,
    'SELECT * FROM case_documents WHERE case_id=? AND kind=? AND title=? ORDER BY version DESC LIMIT 1',
    caseId,
    kind,
    title,
  );
  if (prior?.checksum === checksum) return prior;
  const documentId = id();
  run(
    db,
    'INSERT INTO case_documents VALUES (?,?,?,?,?,?,?,?,?)',
    documentId,
    caseId,
    title,
    kind,
    (prior?.version || 0) + 1,
    source,
    content,
    checksum,
    now(),
  );
  event(db, caseId, 'document_added', {
    documentId,
    kind,
    title,
    version: (prior?.version || 0) + 1,
  });
  return one(db, 'SELECT * FROM case_documents WHERE id=?', documentId);
}
const metadata = ({ content, ...document }) => document;

export function seedDemoDocuments(db, caseId) {
  schema(db);
  const row = requireCase(db, caseId);
  if (row.name !== 'Ana Silva' || row.currency !== 'BRL' || row.amount_minor !== 125000)
    fail(400, 'Demo documents are only available for the fictional Ana Silva case');
  return [
    {
      title: 'Demo loan agreement — Ana Silva',
      kind: 'loan_agreement',
      content:
        'FICTIONAL DEMO DOCUMENT — NOT A LEGAL AGREEMENT\nBorrower: Ana Silva\nOriginal demo balance: BRL 1,250.00\nThis synthetic document is for Rescova workflow testing only. No real loan, payment obligation or enforceable terms are represented. Any repayment solution is recorded separately in the case agreement.',
    },
    {
      title: 'Demo account statement — Ana Silva',
      kind: 'account_statement',
      content:
        'FICTIONAL DEMO DOCUMENT — NOT A REAL ACCOUNT STATEMENT\nBorrower: Ana Silva\nDemo opening balance: BRL 1,250.00\nVerified payments: none recorded in this synthetic statement.\nThis is a static demo artifact, not a live balance or proof of an outstanding real debt. Refer to the case record for subsequently accepted demo repayment agreements.',
    },
  ].map((document) => {
    const prior = one(
      db,
      'SELECT * FROM case_documents WHERE case_id=? AND kind=? AND source=? ORDER BY version DESC LIMIT 1',
      caseId,
      document.kind,
      'synthetic_demo',
    );
    return prior || insertDocument(db, caseId, { ...document, source: 'synthetic_demo' });
  });
}

export function createDocumentLibrary(db, config) {
  schema(db);
  const demo = () => {
    if (config.mode !== 'demo')
      fail(409, 'Document workflow is currently available in demo mode only');
  };
  function list(caseId) {
    requireCase(db, caseId);
    return {
      documents: all(
        db,
        'SELECT * FROM case_documents WHERE case_id=? ORDER BY created_at DESC,version DESC',
        caseId,
      ).map(metadata),
      requests: all(
        db,
        'SELECT * FROM document_requests WHERE case_id=? ORDER BY created_at DESC',
        caseId,
      ),
    };
  }
  function request({ caseId, kind, requestId }) {
    demo();
    requireCase(db, caseId);
    if (!kinds.has(kind)) fail(400, 'Unsupported document kind');
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200)
      fail(400, 'A request ID is required (maximum 200 characters)');
    const prior = one(
      db,
      'SELECT * FROM document_requests WHERE case_id=? AND request_key=?',
      caseId,
      requestId,
    );
    if (prior) {
      if (prior.kind !== kind) fail(409, 'Request ID already used for another document kind');
      return prior;
    }
    const requestRecordId = id();
    run(
      db,
      'INSERT INTO document_requests (id,case_id,kind,request_key,created_at) VALUES (?,?,?,?,?)',
      requestRecordId,
      caseId,
      kind,
      requestId,
      now(),
    );
    event(db, caseId, 'document_requested', { requestId: requestRecordId, kind }, 'voice_agent');
    return one(db, 'SELECT * FROM document_requests WHERE id=?', requestRecordId);
  }
  function resolve(requestId) {
    demo();
    let req = one(db, 'SELECT * FROM document_requests WHERE id=?', requestId);
    if (!req) fail(404, 'Document request not found');
    if (req.status === 'cancelled') return { request: req, document: null };
    // Ready requests retain their immutable original version across retries.
    if (req.status === 'ready')
      return {
        request: req,
        document:
          one(
            db,
            'SELECT * FROM case_documents WHERE id=? AND case_id=?',
            req.document_id,
            req.case_id,
          ) || null,
      };
    const documents = all(
      db,
      'SELECT * FROM case_documents WHERE case_id=? AND kind=? ORDER BY version DESC',
      req.case_id,
      req.kind,
    );
    const latest = [
      ...new Map(
        documents
          .map((d) => d.title)
          .map((title) => [title, documents.find((d) => d.title === title)]),
      ).values(),
    ];
    const document = latest.length === 1 ? latest[0] : null;
    const status = document ? 'ready' : latest.length ? 'ambiguous' : 'missing';
    const error =
      status === 'missing'
        ? 'No matching document is available'
        : status === 'ambiguous'
          ? 'Multiple documents match; human selection is required'
          : null;
    run(
      db,
      'UPDATE document_requests SET status=?,document_id=?,error=? WHERE id=?',
      status,
      document?.id || null,
      error,
      req.id,
    );
    event(
      db,
      req.case_id,
      'document_resolved',
      { requestId: req.id, status, documentId: document?.id || null },
      'Helena',
    );
    req = one(db, 'SELECT * FROM document_requests WHERE id=?', req.id);
    return { request: req, document };
  }
  const router = Router({ mergeParams: true });
  router.get('/', (req, res) => res.json(list(req.params.caseId)));
  router.post('/', (req, res) => {
    demo();
    res
      .status(201)
      .json({
        document: metadata(
          insertDocument(db, req.params.caseId, { ...req.body, source: 'operator_demo_upload' }),
        ),
      });
  });
  router.get('/:id/content', (req, res) => {
    requireCase(db, req.params.caseId);
    const document = one(
      db,
      'SELECT * FROM case_documents WHERE id=? AND case_id=?',
      req.params.id,
      req.params.caseId,
    );
    if (!document) fail(404, 'Document not found in this case');
    res
      .set('Cache-Control', 'no-store')
      .set('X-Content-Type-Options', 'nosniff')
      .attachment(`document-${document.id}.txt`)
      .type('text/plain')
      .send(document.content);
  });
  function stats() {
    const counts = Object.fromEntries(
      all(db, 'SELECT status,COUNT(*) AS count FROM document_requests GROUP BY status').map((r) => [
        r.status,
        r.count,
      ]),
    );
    return {
      running: 0,
      queued: counts.pending || 0,
      failed: (counts.missing || 0) + (counts.ambiguous || 0),
      completed: counts.ready || 0,
    };
  }
  return { router, list, request, resolve, stats };
}
