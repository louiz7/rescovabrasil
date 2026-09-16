import { mkdir, writeFile, readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, one, run, transaction, now } from './db.mjs';
const exec = promisify(execFile);
const LIMIT = 10 * 1024 * 1024;
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function createDocumentIngestion(db, config, insertDocument) {
  const root = resolve(config.documentStorageDir || 'data/documents');
  db.exec(`CREATE TABLE IF NOT EXISTS document_ingestions (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), title TEXT NOT NULL, kind TEXT NOT NULL,
    checksum TEXT NOT NULL, status TEXT NOT NULL, document_id TEXT REFERENCES case_documents(id) ON DELETE SET NULL,
    error TEXT, owner TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(case_id,title,kind,checksum));`);
  async function enqueue(caseId, { title, kind }, bytes) {
    if (!one(db, 'SELECT id FROM cases WHERE id=?', caseId)) fail(404, 'Case not found');
    if (!['loan_agreement', 'account_statement'].includes(kind))
      fail(400, 'Unsupported document kind');
    if (typeof title !== 'string' || !title.trim() || title.length > 160)
      fail(400, 'Document title must contain 1–160 characters');
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > LIMIT ||
      bytes.subarray(0, 5).toString() !== '%PDF-'
    )
      fail(400, 'Choose a valid PDF up to 10 MB');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const prior = one(
      db,
      'SELECT * FROM document_ingestions WHERE case_id=? AND title=? AND kind=? AND checksum=?',
      caseId,
      title.trim(),
      kind,
      checksum,
    );
    if (prior) return prior;
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Content-addressed originals are immutable and never use user-supplied paths.
    try {
      await writeFile(join(root, checksum + '.pdf'), bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const id = randomUUID();
    run(
      db,
      'INSERT INTO document_ingestions (id,case_id,title,kind,checksum,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(case_id,title,kind,checksum) DO NOTHING',
      id,
      caseId,
      title.trim(),
      kind,
      checksum,
      'queued',
      now(),
      now(),
    );
    return one(
      db,
      'SELECT * FROM document_ingestions WHERE case_id=? AND title=? AND kind=? AND checksum=?',
      caseId,
      title.trim(),
      kind,
      checksum,
    );
  }
  async function extract(bytes) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1000,
      Math.min(120000, config.documentExtractionTimeoutMs || 120000),
    );
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error('Document extraction exceeded its time limit');
      return ms;
    };
    let rejectDeadline;
    const expired = new Promise((resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error('Document extraction exceeded its time limit'));
      task.destroy().catch(() => {});
    }, timeoutMs);
    expired.catch(() => {});
    const bounded = (promise) => Promise.race([promise, expired]);
    try {
      const pdf = await bounded(task.promise);
      if (pdf.numPages > 50) throw new Error('PDF is limited to 50 pages');
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await bounded(pdf.getPage(n));
        const text = await bounded(page.getTextContent());
        pages.push(text.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
      }
      if (pages.every((text) => text.trim().length >= 20)) return pages.join('\f');
      const directory = await mkdtemp(join(tmpdir(), 'rescova-ocr-'));
      try {
        await writeFile(join(directory, 'source.pdf'), bytes, { mode: 0o600 });
        const binary =
          config.documentPdftoppmPath || config.pdfRasterizer || '/opt/homebrew/bin/pdftoppm';
        const ocr =
          config.documentTesseractPath || config.ocrExecutable || '/opt/homebrew/bin/tesseract';
        try {
          await exec(
            binary,
            ['-scale-to', '2000', '-png', join(directory, 'source.pdf'), join(directory, 'page')],
            {
              timeout: Math.min(90000, remaining()),
              signal: controller.signal,
              maxBuffer: 1024 * 1024,
            },
          );
          const images = (await readdir(directory))
            .filter((file) => /^page-\d+\.png$/.test(file))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          for (let index = 0; index < images.length; index++)
            if (pages[index].trim().length < 20) {
              const result = await exec(
                ocr,
                [
                  join(directory, images[index]),
                  'stdout',
                  '-l',
                  config.documentOcrLanguage || config.ocrLanguages || 'eng',
                ],
                {
                  timeout: Math.min(30000, remaining()),
                  signal: controller.signal,
                  maxBuffer: 2 * 1024 * 1024,
                },
              );
              pages[index] = result.stdout;
            }
        } catch (error) {
          if (error.code === 'ENOENT')
            throw Object.assign(
              new Error('Scanned pages require configured pdftoppm and tesseract executables'),
              { needsOcr: true },
            );
          throw error;
        }
        if (pages.some((text) => text.trim().length < 3))
          throw Object.assign(
            new Error('Some pages have no readable text after OCR; evidence is incomplete'),
            { needsOcr: true },
          );
        return pages.join('\f');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      clearTimeout(timer);
      await task.destroy();
    }
  }
  let closing = false;
  const pending = new Set();
  const concurrency = Math.max(
    1,
    Math.min(4, Math.floor(Number(config.documentIngestConcurrency) || 1)),
  );
  async function processNext() {
    if (closing) return false;
    const owner = randomUUID();
    const job = transaction(db, () => {
      const row = one(
        db,
        `SELECT * FROM document_ingestions WHERE status='queued' OR (status='processing' AND lease_until<?) ORDER BY created_at LIMIT 1${db.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}`,
        now(),
      );
      if (!row) return null;
      run(
        db,
        "UPDATE document_ingestions SET status='processing',owner=?,lease_until=?,updated_at=? WHERE id=?",
        owner,
        new Date(Date.now() + 180000).toISOString(),
        now(),
        row.id,
      );
      return row;
    });
    if (!job) return false;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        const result = run(
          db,
          "UPDATE document_ingestions SET lease_until=? WHERE id=? AND owner=? AND status='processing' AND lease_until>?",
          new Date(Date.now() + 180000).toISOString(),
          job.id,
          owner,
          now(),
        );
        if (!result.changes) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, 30000);
    heartbeat.unref?.();
    try {
      const content = await extract(await readFile(join(root, job.checksum + '.pdf')));
      if (Buffer.byteLength(content) > 2 * 1024 * 1024)
        throw new Error('Extracted PDF exceeds 2 MB text limit');
      if (leaseLost) return true;
      transaction(db, () => {
        const owned = one(
          db,
          "UPDATE document_ingestions SET lease_until=? WHERE id=? AND owner=? AND status='processing' AND lease_until>? RETURNING id",
          new Date(Date.now() + 180000).toISOString(),
          job.id,
          owner,
          now(),
        );
        if (!owned) return;
        const document = insertDocument(job.case_id, {
          title: job.title,
          kind: job.kind,
          content,
          source: 'pdf_upload',
          sourceChecksum: job.checksum,
          maxBytes: 2 * 1024 * 1024,
        });
        run(
          db,
          "UPDATE document_ingestions SET status='ready',document_id=?,error=NULL,owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=?",
          document.id,
          now(),
          job.id,
          owner,
        );
      });
    } catch (error) {
      if (leaseLost) return true;
      run(
        db,
        'UPDATE document_ingestions SET status=?,error=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=?',
        error.needsOcr ? 'needs_ocr' : 'failed',
        String(error.message).slice(0, 500),
        now(),
        job.id,
        owner,
      );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
  async function original(caseId, documentId) {
    const row = one(
      db,
      "SELECT checksum FROM document_ingestions WHERE case_id=? AND document_id=? AND status='ready'",
      caseId,
      documentId,
    );
    return row ? readFile(join(root, row.checksum + '.pdf')) : null;
  }
  return {
    enqueue,
    drain: async () => {
      const started = [];
      const available = closing ? 0 : Math.max(0, concurrency - pending.size);
      for (let slot = 0; slot < available; slot++) {
        const work = processNext();
        pending.add(work);
        work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        started.push(work);
      }
      return (await Promise.all(started)).some(Boolean);
    },
    close: async () => {
      closing = true;
      await Promise.allSettled([...pending]);
    },
    original,
    extract,
    list: (caseId) =>
      all(
        db,
        'SELECT id,title,kind,status,error,document_id,created_at,updated_at FROM document_ingestions WHERE case_id=? ORDER BY created_at DESC',
        caseId,
      ),
  };
}
