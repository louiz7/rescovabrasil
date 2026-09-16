import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, one, run } from '../server/db.mjs';
import { createDocumentLibrary } from '../server/documents.mjs';
import { lookupCaseInformation } from '../server/case-context.mjs';
import { createDocumentIngestion } from '../server/document-ingestion.mjs';
import { indexDocument } from '../server/document-search.mjs';
function fixture(t) {
  const db = openDb();
  t.after(() => db.close());
  run(db, 'INSERT INTO portfolios VALUES (?,?,?,?,?)', 'p', 'Demo', 'Bank', 'UTC', '2026-09-16');
  for (const id of ['a', 'b'])
    run(
      db,
      'INSERT INTO cases (id,portfolio_id,reference,timezone,created_at) VALUES (?,?,?,?,?)',
      id,
      'p',
      id,
      'UTC',
      '2026-09-16',
    );
  createDocumentLibrary(db, { mode: 'demo' });
  return db;
}
function document(db, id, caseId, content, version = 1, title = 'Loan') {
  run(
    db,
    'INSERT INTO case_documents VALUES (?,?,?,?,?,?,?,?,?)',
    id,
    caseId,
    title,
    'loan_agreement',
    version,
    'test',
    content,
    id,
    '2026-09-16',
  );
  const row = one(db, 'SELECT * FROM case_documents WHERE id=?', id);
  indexDocument(db, row);
  return row;
}
export function pdf(text = 'Installments are payable monthly. Annual interest is twelve percent.') {
  const stream = `BT /F1 16 Tf 40 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n',
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n ')
    .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}
test('ranked evidence is scoped, latest-version-only, bounded and cites physical pages', (t) => {
  const db = fixture(t);
  document(db, 'old', 'a', 'Obsolete secret penalty', 1);
  document(
    db,
    'new',
    'a',
    'Interest interest annual interest is twelve percent.\fInstallments are monthly.',
    2,
  );
  document(db, 'foreign', 'b', 'Private cross case interest interest interest');
  const result = lookupCaseInformation(db, 'a', { topic: 'document_search', query: 'interest' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].documentId, 'new');
  assert.equal(result.items[0].page, 1);
  assert.equal(result.items[0].version, 2);
  assert.ok(result.items[0].untrustedContent);
  assert.equal(
    lookupCaseInformation(db, 'a', { topic: 'document_search', query: 'monthly' }).items[0].page,
    2,
  );
  assert.equal(
    lookupCaseInformation(db, 'a', { topic: 'document_search', query: 'obsolete' }).items.length,
    0,
  );
  assert.throws(
    () => lookupCaseInformation(db, 'missing', { topic: 'document_search', query: 'interest' }),
    { status: 404 },
  );
  assert.throws(() => lookupCaseInformation(db, 'a', { topic: 'document_search', query: '' }), {
    status: 400,
  });
  assert.equal(
    lookupCaseInformation(db, 'a', { topic: 'document_search', query: '" OR * !' }).items.length,
    0,
  );
});
test('durable PDF ingestion extracts text, retains original, deduplicates and recovers expired leases', async (t) => {
  const db = fixture(t),
    root = await mkdtemp(join(tmpdir(), 'rescova-doc-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ingestion = createDocumentIngestion(db, { documentStorageDir: root }, (caseId, input) =>
    document(db, 'pdf-text', caseId, input.content),
  );
  const bytes = pdf();
  const job = await ingestion.enqueue('a', { title: 'PDF', kind: 'loan_agreement' }, bytes);
  assert.equal(
    (await ingestion.enqueue('a', { title: 'PDF', kind: 'loan_agreement' }, bytes)).id,
    job.id,
  );
  run(
    db,
    "UPDATE document_ingestions SET status='processing',owner='dead',lease_until='2000-01-01' WHERE id=?",
    job.id,
  );
  await ingestion.drain();
  assert.equal(ingestion.list('a')[0].status, 'ready');
  assert.deepEqual(await ingestion.original('a', 'pdf-text'), bytes);
  assert.equal(await ingestion.original('b', 'pdf-text'), null);
  assert.match(
    lookupCaseInformation(db, 'a', { topic: 'document_search', query: 'interest' }).items[0]
      .content,
    /twelve percent/,
  );
  assert.equal(await ingestion.drain(), false);
});
test('unreadable scanned pages remain explicit dependencies when OCR tools are absent', async (t) => {
  const db = fixture(t),
    root = await mkdtemp(join(tmpdir(), 'rescova-ocr-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ingestion = createDocumentIngestion(
    db,
    { documentStorageDir: root, pdfRasterizer: '/missing/pdftoppm' },
    () => {
      throw new Error('Must not publish empty evidence');
    },
  );
  await ingestion.enqueue('a', { title: 'Scan', kind: 'loan_agreement' }, pdf(''));
  await ingestion.drain();
  assert.equal(ingestion.list('a')[0].status, 'needs_ocr');
  assert.equal(ingestion.list('a')[0].document_id, null);
  await assert.rejects(
    () => ingestion.enqueue('b', { title: 'Bad', kind: 'loan_agreement' }, Buffer.from('not PDF')),
    { status: 400 },
  );
});

test(
  'PostgreSQL ranked document retrieval returns case-scoped source evidence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { PostgresDatabase } = await import('../server/postgres.mjs');
    const admin = new PostgresDatabase(process.env.TEST_DATABASE_URL),
      schema = 'test_search_' + Date.now();
    admin.query('CREATE SCHEMA ' + schema);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', '-csearch_path=' + schema);
    const db = openDb(url.href);
    try {
      run(
        db,
        'INSERT INTO portfolios VALUES (?,?,?,?,?)',
        'p',
        'Demo',
        'Bank',
        'UTC',
        '2026-09-16',
      );
      for (const id of ['a', 'b'])
        run(
          db,
          'INSERT INTO cases (id,portfolio_id,reference,timezone,created_at) VALUES (?,?,?,?,?)',
          id,
          'p',
          id,
          'UTC',
          '2026-09-16',
        );
      createDocumentLibrary(db, { mode: 'demo' });
      document(db, 'pg-a', 'a', 'Interest is twelve percent');
      document(db, 'pg-b', 'b', 'Private interest record');
      const result = lookupCaseInformation(db, 'a', {
        topic: 'document_search',
        query: 'interest',
      });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].documentId, 'pg-a');
      assert.ok(result.items[0].relevance > 0);
    } finally {
      db.close();
      admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      admin.close();
    }
  },
);

test('installed OCR extracts an image-only PDF into searchable evidence', async (t) => {
  const { existsSync } = await import('node:fs');
  if (!existsSync('/opt/homebrew/bin/pdftoppm') || !existsSync('/opt/homebrew/bin/tesseract'))
    return t.skip('Local OCR tools not installed');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { deflateSync } = await import('node:zlib');
  const canvas = createCanvas(1000, 200),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1000, 200);
  ctx.fillStyle = 'black';
  ctx.font = '40px Arial';
  ctx.fillText('Annual interest is twelve percent.', 30, 100);
  const rgba = ctx.getImageData(0, 0, 1000, 200).data,
    rgb = Buffer.alloc(1000 * 200 * 3);
  for (let n = 0; n < 1000 * 200; n++) for (let c = 0; c < 3; c++) rgb[n * 3 + c] = rgba[n * 4 + c];
  const image = deflateSync(rgb),
    drawing = 'q 500 0 0 100 30 600 cm /Image Do Q';
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image 4 0 R >> >> /Contents 5 0 R >>',
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1000 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
  ];
  let bytes = Buffer.from('%PDF-1.4\n'),
    offsets = [];
  objects.forEach((object, index) => {
    offsets.push(bytes.length);
    bytes = Buffer.concat([
      bytes,
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
  });
  const start = bytes.length;
  bytes = Buffer.concat([
    bytes,
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`,
    ),
  ]);
  const db = fixture(t),
    root = await mkdtemp(join(tmpdir(), 'rescova-ocr-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ingestion = createDocumentIngestion(db, { documentStorageDir: root }, (caseId, input) =>
    document(db, 'ocr-scan', caseId, input.content),
  );
  await ingestion.enqueue('a', { title: 'Scanned loan', kind: 'loan_agreement' }, bytes);
  await ingestion.drain();
  assert.equal(ingestion.list('a')[0].status, 'ready', ingestion.list('a')[0].error);
  assert.match(
    lookupCaseInformation(db, 'a', { topic: 'document_search', query: 'interest' }).items[0]
      .content,
    /twelve percent/i,
  );
});

test('an expired ingestion owner cannot publish extracted evidence', async (t) => {
  const db = fixture(t),
    root = await mkdtemp(join(tmpdir(), 'rescova-fence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let publications = 0;
  const ingestion = createDocumentIngestion(db, { documentStorageDir: root }, (caseId, input) => {
    publications++;
    return document(db, 'fenced', caseId, input.content);
  });
  const job = await ingestion.enqueue('a', { title: 'Fenced', kind: 'loan_agreement' }, pdf());
  const pending = ingestion.drain();
  run(db, "UPDATE document_ingestions SET lease_until='2000-01-01' WHERE id=?", job.id);
  await pending;
  assert.equal(publications, 0);
  assert.equal(ingestion.list('a')[0].status, 'processing');
  await ingestion.drain();
  assert.equal(publications, 1);
  assert.equal(ingestion.list('a')[0].status, 'ready');
  await ingestion.close();
  assert.equal(await ingestion.drain(), false);
});

test('configured ingestion concurrency claims bounded distinct jobs across overlapping drains', async (t) => {
  const db = fixture(t),
    root = await mkdtemp(join(tmpdir(), 'rescova-concurrent-ingestion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const published = [];
  const ingestion = createDocumentIngestion(
    db,
    { documentStorageDir: root, documentIngestConcurrency: 2 },
    (caseId, input) => {
      published.push(input.title);
      return document(db, input.title, caseId, input.content, 1, input.title);
    },
  );
  for (const title of ['one', 'two', 'three'])
    await ingestion.enqueue('a', { title, kind: 'loan_agreement' }, pdf());
  const first = ingestion.drain();
  assert.equal(ingestion.list('a').filter((job) => job.status === 'processing').length, 2);
  assert.equal(
    await ingestion.drain(),
    false,
    'Overlapping drains cannot exceed configured capacity',
  );
  await first;
  assert.equal(published.length, 2);
  await ingestion.drain();
  assert.equal(published.length, 3);
  assert.equal(new Set(published).size, 3);
  assert.ok(ingestion.list('a').every((job) => job.status === 'ready'));
  await ingestion.close();
});
