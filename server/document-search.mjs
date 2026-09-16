import { all, one, run, transaction } from './db.mjs';

const initialized = new WeakSet();
export function ensureDocumentSearch(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS document_passages (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES case_documents(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES cases(id), page INTEGER NOT NULL, paragraph INTEGER NOT NULL,
    content TEXT NOT NULL, UNIQUE(document_id,page,paragraph));
    CREATE INDEX IF NOT EXISTS passages_case_document ON document_passages(case_id,document_id);`);
  if (db.dialect === 'postgres')
    db.exec(
      `CREATE INDEX IF NOT EXISTS passages_search ON document_passages USING GIN (to_tsvector('simple',content));`,
    );
  else
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS document_passages_fts USING fts5(id UNINDEXED,content,tokenize='unicode61 remove_diacritics 2');`,
    );
  initialized.add(db);
}
export function indexDocument(db, document) {
  ensureDocumentSearch(db);
  return transaction(db, () => indexDocumentPassages(db, document));
}
function indexDocumentPassages(db, document) {
  if (one(db, 'SELECT id FROM document_passages WHERE document_id=? LIMIT 1', document.id)) return;
  const pages = document.content.split('\f');
  pages.forEach((page, pageIndex) => {
    let paragraph = 0;
    for (const block of page.split(/\n\s*\n/)) {
      // Bounded evidence: each result is at most 1600 characters; page boundaries retained.
      for (let start = 0; start < block.length; start += 1400) {
        const content = block.slice(start, start + 1600).trim();
        if (!content) continue;
        const passageId = `${document.id}:${pageIndex + 1}:${++paragraph}`;
        const inserted = run(
          db,
          'INSERT INTO document_passages (id,document_id,case_id,page,paragraph,content) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
          passageId,
          document.id,
          document.case_id,
          pageIndex + 1,
          paragraph,
          content,
        );
        if (db.dialect !== 'postgres' && inserted.changes)
          run(
            db,
            'INSERT INTO document_passages_fts (id,content) VALUES (?,?)',
            passageId,
            content,
          );
      }
    }
  });
}
export function searchCaseDocuments(db, caseId, query, offset = 0) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500)
    throw Object.assign(new Error('Search query must contain 1–500 characters.'), { status: 400 });
  ensureDocumentSearch(db);
  // Backfill existing immutable documents. New uploads are indexed once at ingestion.
  for (const document of all(
    db,
    'SELECT d.* FROM case_documents d WHERE d.case_id=? AND NOT EXISTS (SELECT 1 FROM document_passages p WHERE p.document_id=d.id)',
    caseId,
  ))
    indexDocument(db, document);
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) || [])].slice(0, 20);
  if (!terms.length)
    return { items: [], hasMore: false, nextOffset: null, missing: ['No searchable terms.'] };
  const scoped = `p.case_id=? AND NOT EXISTS (SELECT 1 FROM case_documents newer WHERE newer.case_id=d.case_id AND newer.kind=d.kind AND newer.title=d.title AND newer.version>d.version)`;
  const select =
    'p.id AS passageId,p.document_id AS documentId,p.page,p.paragraph,p.content,d.title,d.kind,d.version,d.checksum,d.source';
  let rows;
  if (db.dialect === 'postgres') {
    const expression = terms.join(' | ');
    rows = all(
      db,
      `SELECT ${select},ts_rank(to_tsvector('simple',p.content),to_tsquery('simple',?)) AS relevance FROM document_passages p JOIN case_documents d ON d.id=p.document_id WHERE ${scoped} AND to_tsvector('simple',p.content) @@ to_tsquery('simple',?) ORDER BY relevance DESC,p.id LIMIT 6 OFFSET ?`,
      expression,
      caseId,
      expression,
      offset,
    );
  } else {
    const expression = terms.map((term) => '"' + term + '"').join(' OR ');
    rows = all(
      db,
      `SELECT ${select},-bm25(document_passages_fts) AS relevance FROM document_passages_fts JOIN document_passages p ON p.id=document_passages_fts.id JOIN case_documents d ON d.id=p.document_id WHERE document_passages_fts MATCH ? AND ${scoped} ORDER BY bm25(document_passages_fts),p.id LIMIT 6 OFFSET ?`,
      expression,
      caseId,
      offset,
    );
  }
  return {
    items: rows.slice(0, 5).map((row) => ({ ...row, untrustedContent: true })),
    hasMore: rows.length > 5,
    nextOffset: rows.length > 5 ? offset + 5 : null,
    missing: rows.length
      ? []
      : ['No matching indexed passages. This does not prove the information is absent.'],
    coverage:
      'Keyword retrieval over latest document versions; financial authority remains in structured case records.',
  };
}
