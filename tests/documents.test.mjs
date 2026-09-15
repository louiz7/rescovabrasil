import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../server/db.mjs';
import { createDocumentLibrary, seedDemoDocuments } from '../server/documents.mjs';

async function fixture(t, mode = 'demo') {
  const db = openDb();
  db.prepare('INSERT INTO portfolios VALUES (?,?,?,?,?)').run(
    'p',
    'Demo',
    'Demo',
    'UTC',
    '2026-09-15',
  );
  for (const caseId of ['ana', 'other'])
    db.prepare(
      'INSERT INTO cases (id,portfolio_id,reference,name,amount_minor,currency,timezone,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      caseId,
      'p',
      caseId,
      caseId === 'ana' ? 'Ana Silva' : 'Other Person',
      125000,
      'BRL',
      'UTC',
      '2026-09-15',
    );
  const library = createDocumentLibrary(db, { mode });
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use('/cases/:caseId/documents', library.router);
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const call = (path = '', body, caseId = 'ana') =>
    fetch(
      `http://127.0.0.1:${server.address().port}/cases/${caseId}/documents${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  return { db, library, call };
}

test('demo seeds are explicit, idempotent and retrieval is case-scoped', async (t) => {
  const { db, library, call } = await fixture(t);
  assert.equal(library.list('ana').documents.length, 0);
  const [agreement] = seedDemoDocuments(db, 'ana');
  seedDemoDocuments(db, 'ana');
  assert.equal(library.list('ana').documents.length, 2);
  assert.equal(library.list('other').documents.length, 0);
  assert.throws(() => seedDemoDocuments(db, 'other'), /fictional Ana/);
  assert.equal((await call(`/${agreement.id}/content`, undefined, 'other')).status, 404);
  const downloaded = await call(`/${agreement.id}/content`);
  assert.equal(downloaded.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(await downloaded.text(), /FICTIONAL DEMO/);
  assert.equal((await call('', undefined, 'missing')).status, 404);
});

test('requests are idempotent and cannot switch kind; missing documents are explicit', async (t) => {
  const { library } = await fixture(t);
  const input = { caseId: 'ana', kind: 'loan_agreement', requestId: 'call-1' };
  const request = library.request(input);
  assert.equal(library.request(input).id, request.id);
  assert.throws(
    () => library.request({ ...input, kind: 'account_statement' }),
    /another document kind/,
  );
  assert.equal(library.resolve(request.id).request.status, 'missing');
  assert.throws(() => library.request({ ...input, caseId: 'absent' }), /Case not found/);
  assert.throws(() => library.resolve('absent'), /not found/);
});

test('versions are immutable and ready requests remain pinned; distinct titles need review', async (t) => {
  const { library, call } = await fixture(t);
  const upload = (content) => call('', { title: 'Loan', kind: 'loan_agreement', content });
  const first = (await (await upload('version one')).json()).document;
  const request = library.request({ caseId: 'ana', kind: 'loan_agreement', requestId: 'one' });
  assert.equal(library.resolve(request.id).document.id, first.id);
  const second = (await (await upload('version two')).json()).document;
  assert.equal(second.version, 2);
  assert.equal(library.resolve(request.id).document.id, first.id);
  assert.equal(await (await call(`/${first.id}/content`)).text(), 'version one');
  const next = library.request({ caseId: 'ana', kind: 'loan_agreement', requestId: 'two' });
  assert.equal(library.resolve(next.id).document.id, second.id);
  await call('', { title: 'Another loan', kind: 'loan_agreement', content: 'ambiguous' });
  const ambiguous = library.request({ caseId: 'ana', kind: 'loan_agreement', requestId: 'three' });
  assert.equal(library.resolve(ambiguous.id).request.status, 'ambiguous');
  assert.equal(library.resolve(ambiguous.id).document, null);
});

test('upload validates content and demo mutations are blocked in live mode', async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (await call('', { title: 'x', kind: 'loan_agreement', content: 'x'.repeat(102401) })).status,
    400,
  );
  assert.equal((await call('', { title: 'x', kind: 'unknown', content: 'x' })).status, 400);
  const live = await fixture(t, 'live');
  assert.equal(
    (await live.call('', { title: 'x', kind: 'loan_agreement', content: 'x' })).status,
    409,
  );
  assert.throws(
    () => live.library.request({ caseId: 'ana', kind: 'loan_agreement', requestId: 'x' }),
    /demo mode/,
  );
});
