import ExcelJS from 'exceljs';
import { id, now, all, one, run, event, transaction } from './db.mjs';
import {
  assert,
  clean,
  fold,
  phoneBR,
  email,
  amount,
  dateOnly,
  timezone,
  AppError,
} from './domain.mjs';

export const FIELDS = {
  reference: [
    'referencia',
    'referência',
    'reference',
    'case_id',
    'contrato',
    'id',
    'numero_contrato',
  ],
  name: ['nome', 'name', 'nome_completo', 'devedor', 'borrower'],
  phone: ['telefone', 'phone', 'celular', 'whatsapp'],
  email: ['email', 'e-mail'],
  amount: ['saldo', 'valor', 'amount', 'outstanding_balance', 'valor_aberto'],
  currency: ['moeda', 'currency'],
  due_date: ['vencimento', 'due_date', 'data_vencimento'],
  timezone: ['fuso', 'timezone'],
  language: ['idioma', 'language'],
};
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0];
  const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += ch;
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
      closed = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = '';
      closed = false;
    } else {
      assert(!closed || /\s/.test(ch), 'Invalid CSV content after closing quote.');
      assert(ch !== '"', 'Invalid CSV quotes.');
      field += ch;
    }
    assert(
      field.length < 10000 && row.length <= 100 && rows.length <= 10000,
      'Limit: 10,000 rows, 100 columns and 10,000 characters per cell.',
    );
  }
  assert(!quoted, 'CSV contains unclosed quotes.');
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
export async function decodeFile(filename, base64) {
  assert(typeof base64 === 'string' && base64.length <= 14_000_000, 'File exceeds 10 MB.');
  const buffer = Buffer.from(base64, 'base64');
  assert(buffer.length > 0 && buffer.length <= 10_000_000, 'File is empty or exceeds 10 MB.');
  let rows;
  if (/\.csv$/i.test(filename))
    rows = parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  else if (/\.xlsx$/i.test(filename)) {
    // Preflight central-directory uncompressed sizes before the XLSX parser inflates entries.
    let expanded = 0,
      entries = 0;
    for (let i = 0; i < buffer.length - 46; i++)
      if (buffer.readUInt32LE(i) === 0x02014b50) {
        expanded += buffer.readUInt32LE(i + 24);
        entries++;
        i +=
          45 +
          buffer.readUInt16LE(i + 28) +
          buffer.readUInt16LE(i + 30) +
          buffer.readUInt16LE(i + 32);
      }
    assert(
      entries > 0 && entries < 2000 && expanded < 50_000_000,
      'XLSX exceeds the uncompressed size limit (50 MB).',
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    assert(wb.worksheets.length > 0, 'Empty worksheet.');
    const sheet = wb.worksheets[0];
    assert(
      sheet.rowCount <= 10001 && sheet.columnCount <= 100,
      'Limit: 10,000 rows and 100 columns.',
    );
    rows = [];
    sheet.eachRow((row) => {
      const cells = [];
      for (let c = 1; c <= sheet.columnCount; c++) {
        let v = row.getCell(c).value;
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if (v && typeof v === 'object')
          v = v.formula
            ? '[FORMULA NOT ACCEPTED]'
            : v.text || v.richText?.map((t) => t.text).join('') || '';
        cells.push(v ?? '');
      }
      rows.push(cells);
    });
  } else throw new AppError('Use UTF-8 CSV or XLSX.');
  assert(
    rows.length > 1 && rows.length <= 10001,
    'File must contain a header and 1–10,000 data rows.',
  );
  const headers = rows.shift().map((v) => clean(v, 100));
  assert(
    headers.every(Boolean) && new Set(headers).size === headers.length && headers.length <= 100,
    'Empty or duplicate column headers.',
  );
  return { headers, rows };
}
export function suggestMapping(headers) {
  return Object.fromEntries(
    Object.entries(FIELDS).map(([field, aliases]) => [
      field,
      headers.find((h) => aliases.map(fold).includes(fold(h).replaceAll(' ', '_'))) || '',
    ]),
  );
}
export function validateRows(db, staged, mapping) {
  assert(
    mapping && typeof mapping === 'object' && !Array.isArray(mapping),
    'Invalid column mapping.',
  );
  const headers = JSON.parse(staged.headers),
    source = JSON.parse(staged.rows);
  for (const [key, v] of Object.entries(mapping))
    assert(FIELDS[key] && (!v || headers.includes(v)), 'Invalid column.');
  const used = Object.values(mapping).filter(Boolean);
  assert(new Set(used).size === used.length, 'Each column can only be mapped once.');
  const portfolio = one(db, 'SELECT * FROM portfolios WHERE id=?', staged.portfolio_id);
  const refs = new Set(
    all(db, 'SELECT reference FROM cases WHERE portfolio_id=?', portfolio.id).map(
      (c) => c.reference,
    ),
  );
  const contacts = new Set(
    all(db, 'SELECT phone,email FROM cases')
      .flatMap((c) => [c.phone, c.email])
      .filter(Boolean),
  );
  return source.map((row, index) => {
    const get = (key) => (mapping[key] ? (row[headers.indexOf(mapping[key])] ?? '') : '');
    const errors = [],
      warnings = [];
    if (row.length !== headers.length) errors.push('Column count does not match the header');
    const reference = clean(get('reference'), 100) || `${staged.id.slice(0, 8)}-${index + 2}`;
    if (!get('reference'))
      warnings.push('Reference generated; reimports from another file need review');
    const name = clean(get('name')) || null,
      phone = phoneBR(get('phone')),
      mail = email(get('email'));
    if (!name) warnings.push('Missing name: identity will need review');
    if (get('phone') && !phone) warnings.push('Invalid Brazilian phone number');
    if (get('email') && !mail) warnings.push('Invalid email address');
    if (!phone && !mail) errors.push('No valid contact details');
    const amountMinor = amount(get('amount'));
    if (Number.isNaN(amountMinor)) errors.push('Invalid amount');
    if (amountMinor === null) warnings.push('Unknown balance');
    const currency = clean(get('currency') || 'BRL').toUpperCase();
    if (currency !== 'BRL')
      errors.push('This pilot only accepts BRL; no currency conversion is available');
    const due = dateOnly(get('due_date'));
    if (get('due_date') && !due) errors.push('Invalid due date: use DD/MM/YYYY or YYYY-MM-DD');
    const tz = timezone(clean(get('timezone')) || portfolio.timezone);
    if (!tz) errors.push('Invalid time zone');
    const language = clean(get('language')) || 'pt-BR';
    if (!['pt-BR', 'pt'].includes(language))
      errors.push('The voice pilot supports Brazilian Portuguese');
    const duplicate = refs.has(reference);
    if (duplicate) errors.push('Duplicate reference in this portfolio');
    if ((phone && contacts.has(phone)) || (mail && contacts.has(mail)))
      warnings.push('Shared contact: check whether this is the same person');
    if (!errors.length) {
      refs.add(reference);
      if (phone) contacts.add(phone);
      if (mail) contacts.add(mail);
    }
    return {
      row: index + 2,
      reference,
      name,
      phone,
      email: mail,
      amount_minor: Number.isNaN(amountMinor) ? null : amountMinor,
      currency,
      due_date: due,
      timezone: tz,
      language: 'pt-BR',
      errors,
      warnings,
      duplicate,
      valid: errors.length === 0,
    };
  });
}
export function publicReport(rows) {
  return rows.map(({ verification_hash, ...r }) => r);
}
export function commitImport(db, importId, mapping, selectedRows) {
  return transaction(db, () => {
    const stage = one(db, 'SELECT * FROM imports WHERE id=?', importId);
    assert(stage, 'Import not found.', 404);
    if (stage.status === 'committed') return JSON.parse(stage.report);
    const rows = validateRows(db, stage, mapping);
    assert(
      Array.isArray(selectedRows) &&
        selectedRows.length &&
        selectedRows.every((n) => Number.isInteger(n)),
      'Select valid rows.',
    );
    const selected = new Set(selectedRows),
      chosen = rows.filter((r) => selected.has(r.row));
    assert(
      chosen.length === selected.size && chosen.every((r) => r.valid),
      'Some rows are invalid or have changed. Review the import.',
    );
    for (const r of chosen) {
      const caseId = id();
      const blocked = [r.phone, r.email]
        .filter(Boolean)
        .some((a) => one(db, 'SELECT 1 FROM suppressions WHERE address=?', a));
      run(
        db,
        `INSERT INTO cases (id,portfolio_id,reference,name,phone,email,amount_minor,currency,due_date,timezone,language,verification_hash,source_import,created_at,suppressed,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        caseId,
        stage.portfolio_id,
        r.reference,
        r.name,
        r.phone,
        r.email,
        r.amount_minor,
        r.currency,
        r.due_date,
        r.timezone,
        r.language,
        null,
        stage.id,
        now(),
        blocked ? 1 : 0,
        blocked ? 'suppressed' : 'ready',
      );
      event(
        db,
        caseId,
        'imported',
        `Import ${stage.filename}, row ${r.row}${blocked ? ' • contact already blocked' : ''}`,
      );
    }
    const report = {
      imported: chosen.length,
      rejected: rows.filter((r) => !r.valid).length,
      skipped: rows.length - chosen.length,
      rows: publicReport(rows),
    };
    // Discard the raw worksheet at commit; retain only mapped fields and the validation report.
    run(
      db,
      "UPDATE imports SET status='committed', mapping=?, report=?, rows='[]' WHERE id=?",
      JSON.stringify(mapping),
      JSON.stringify(report),
      stage.id,
    );
    return report;
  });
}
