import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  amount,
  phoneBR,
  dateOnly,
  contactWindow,
  nextWindow,
  isOptOut,
  validateOutcome,
} from '../server/domain.mjs';
import {
  decodeFile,
  parseCSV,
  suggestMapping,
  validateRows,
  publicReport,
  commitImport,
} from '../server/importer.mjs';
import { one } from '../server/db.mjs';
import { fixture, stage } from './helpers.mjs';

test('Brazilian amounts, telephone and dates preserve exact values and reject impossible input', () => {
  for (const v of ['R$ 1.234,56', '1234.56', 1234.56]) assert.equal(amount(v), 123456);
  assert.equal(amount('1.234'), 123400);
  assert.equal(amount(''), null);
  for (const v of ['-1', '12,345', Infinity, 0.001]) assert.ok(Number.isNaN(amount(v)));
  assert.equal(phoneBR('(11) 98765-4321'), '+5511987654321');
  assert.equal(phoneBR('005511987654321'), '+5511987654321');
  for (const v of ['+491234567890', '20987654321', '111111']) assert.equal(phoneBR(v), null);
  assert.equal(dateOnly('29/02/2024'), '2024-02-29');
  assert.equal(dateOnly('31/02/2025'), null);
});
test('local contact window excludes nights, weekends and configured holidays', () => {
  const policy = { startHour: 9, endHour: 18, excludedDates: ['2026-09-15'] };
  assert.equal(contactWindow(new Date('2026-09-14T11:59:00Z'), 'America/Sao_Paulo', policy), false);
  assert.equal(contactWindow(new Date('2026-09-14T12:00:00Z'), 'America/Sao_Paulo', policy), true);
  assert.equal(
    nextWindow(new Date('2026-09-14T21:00:00Z'), 'America/Sao_Paulo', policy),
    '2026-09-16T12:00:00.000Z',
  );
  assert.equal(
    nextWindow(new Date('2026-09-19T13:00:00Z'), 'America/Sao_Paulo', policy),
    '2026-09-21T12:00:00.000Z',
  );
  for (const text of ['SAIR', 'Não me ligue mais', 'pare de enviar mensagens'])
    assert.ok(isOptOut(text));
});
test('CSV supports BOM, pt-BR delimiter, quoted newlines and escaped quotes', async () => {
  const csv = '\uFEFFreferência;nome;saldo\r\nR1;"Ana; \"\"Silva\"\"\nSouza";"1.234,56"';
  const decoded = await decodeFile('casos.csv', Buffer.from(csv).toString('base64'));
  assert.equal(decoded.rows[0][1], 'Ana; "Silva"\nSouza');
  assert.equal(suggestMapping(decoded.headers).reference, 'referência');
  assert.throws(() => parseCSV('a,b\n"unclosed,b'), /quot/i);
  await assert.rejects(
    decodeFile('bad.csv', Buffer.from('nome;nome\na;b').toString('base64')),
    /headers/i,
  );
});
test('XLSX dates/numbers decode and formulas cannot be imported as money', async () => {
  const wb = new ExcelJS.Workbook(),
    ws = wb.addWorksheet('Casos');
  ws.addRow(['referencia', 'saldo', 'vencimento']);
  ws.addRow(['R1', 1234.56, new Date('2025-01-31T00:00:00Z')]);
  ws.addRow(['R2', { formula: '1+1', result: 2 }, null]);
  const file = await decodeFile(
    'dados.xlsx',
    Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'),
  );
  assert.deepEqual(file.rows[0], ['R1', 1234.56, '2025-01-31']);
  assert.ok(Number.isNaN(amount(file.rows[1][1])));
});
test('import validates missing/duplicate data, commits selected rows atomically and recommits idempotently', (t) => {
  const f = fixture(t),
    s = stage(f.db, f.portfolio.id, [
      ['BR-1', 'Ana', '11987654321', '', '100', ''],
      ['BR-2', '', '', 'valid@example.test', '', ''],
      ['BR-3', 'Bad', '123', 'broken', '10', ''],
    ]);
  const mapping = suggestMapping(JSON.parse(s.headers)),
    rows = validateRows(f.db, s, mapping);
  assert.equal(rows[0].duplicate, true);
  assert.equal(rows[1].valid, true);
  assert.ok(rows[1].warnings.length >= 2);
  assert.equal(rows[2].valid, false);
  assert.throws(() => commitImport(f.db, s.id, mapping, [3, 4]), /invalid/i);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM cases').n, 1);
  assert.throws(() => commitImport(f.db, s.id, mapping, [99]), /invalid/i);
  const report = commitImport(f.db, s.id, mapping, [3]);
  assert.deepEqual(commitImport(f.db, s.id, mapping, [3]), report);
  assert.equal(one(f.db, 'SELECT COUNT(*) n FROM cases').n, 2);
  assert.equal(JSON.stringify(publicReport(rows)).includes('verification_hash'), false);
  assert.equal(JSON.stringify(report).includes('verification_hash'), false);
});
test('invalid due date row does not reserve a reference against a subsequent valid row', (t) => {
  const f = fixture(t),
    s = stage(f.db, f.portfolio.id, [
      ['NEW-1', 'Ana', '11987654321', '', '10', '31/02/2025'],
      ['NEW-1', 'Ana', '11987654321', '', '10', '28/02/2025'],
    ]);
  const rows = validateRows(f.db, s, suggestMapping(JSON.parse(s.headers)));
  assert.equal(rows[0].valid, false);
  assert.equal(rows[1].valid, true);
  assert.equal(rows[1].duplicate, false);
});
test('new imports need no verification code and do not store legacy verification hashes', (t) => {
  const f = fixture(t);
  assert.equal(f.cases[0].verification_hash, null);
  assert.equal(
    Object.hasOwn(suggestMapping(['nome', 'telefone', 'codigo_verificacao']), 'verification'),
    false,
  );
});
test('malformed callback date is a client validation error even on another outcome', () => {
  assert.throws(
    () => validateOutcome({ outcome: 'human_review', callbackAt: 'not-a-date' }),
    (e) => e.status === 400,
  );
});
