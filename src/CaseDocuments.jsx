import React, { useEffect, useRef, useState } from 'react';
import { FileText, Download, Upload, RefreshCw } from 'lucide-react';
import './CaseDocuments.css';

const kinds = { loan_agreement: 'Loan agreement', account_statement: 'Account statement' };
const date = (value) => (value ? new Date(value).toLocaleString() : '');
const label = (value = '') => value.replaceAll('_', ' ');
const maxBytes = 100 * 1024;

export default function CaseDocuments({ caseId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('loan_agreement');
  const [file, setFile] = useState(null);
  const fileInput = useRef(null);
  const base = `/api/cases/${encodeURIComponent(caseId)}/documents`;

  useEffect(() => {
    let stopped = false;
    let timer;
    setData(null);
    setError('');
    async function refresh() {
      try {
        const response = await fetch(base);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load case documents.');
        if (!stopped) setData(result);
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(refresh, 3000);
    }
    refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [base]);

  async function upload(event) {
    event.preventDefault();
    if (busy || !file) return;
    setError('');
    setNotice('');
    const pdf = file.name.toLowerCase().endsWith('.pdf');
    if (
      (!pdf && !file.name.toLowerCase().endsWith('.txt')) ||
      file.size > (pdf ? 10 * 1024 * 1024 : maxBytes)
    ) {
      setError('Choose text up to 100 KB or a PDF up to 10 MB.');
      return;
    }
    setBusy(true);
    try {
      const content = pdf ? null : await file.text();
      if (!pdf && (!content.trim() || content.includes('\0')))
        throw new Error('Choose a non-empty plain text document.');
      const response = await fetch(
        pdf ? `${base}/upload?${new URLSearchParams({ title: title.trim(), kind })}` : base,
        {
          method: 'POST',
          headers: { 'Content-Type': pdf ? 'application/pdf' : 'application/json' },
          body: pdf ? file : JSON.stringify({ title: title.trim(), kind, content }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not upload the document.');
      setTitle('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setNotice(
        pdf
          ? 'PDF queued for extraction and indexing. Processing status appears below.'
          : 'Demo document uploaded. Helena can retrieve it for this case.',
      );
      const refreshed = await fetch(base);
      if (refreshed.ok) setData(await refreshed.json());
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="case-documents" aria-label="Case documents">
      <div className="case-documents-intro">
        <span className="case-documents-icon">
          <FileText size={20} />
        </span>
        <div>
          <h3>
            Case library <span>Demo only</span>
          </h3>
          <p>
            Helena retrieves case documents for the conversation team. Relevant passages are
            retrieved on demand. Configured email workflows can deliver requested documents.
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-box" role="status">
          {notice}
        </p>
      )}
      <div className="case-documents-section-heading">
        <h4>Documents</h4>
        <span>{data?.documents?.length ?? '—'}</span>
      </div>
      {!data ? (
        <p className="muted">Loading documents…</p>
      ) : !data.documents?.length ? (
        <div className="case-documents-empty">
          No documents yet. Add a demo agreement or statement below.
        </div>
      ) : (
        <ul className="case-documents-list">
          {data.documents.map((document) => (
            <li key={document.id}>
              <FileText size={18} aria-hidden="true" />
              <div>
                <strong>{document.title}</strong>
                <p>
                  {kinds[document.kind] || label(document.kind)} · Version {document.version || 1}
                </p>
                <small>
                  {label(document.source || 'Case upload')} · {date(document.created_at)}
                </small>
              </div>
              <a
                className="case-document-download"
                href={`${base}/${encodeURIComponent(document.id)}/content`}
                download
                aria-label={`Download ${document.title}`}
              >
                <Download size={16} />
                <span>Download</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {data?.ingestions?.length > 0 && (
        <ul className="case-document-requests" aria-label="Document processing">
          {data.ingestions.map((job) => (
            <li key={job.id}>
              <div>
                <strong>{job.title}</strong>
                <small>{label(job.status)}</small>
                {job.error && <p className="error">{job.error}</p>}
              </div>
              {['failed', 'needs_ocr'].includes(job.status) && (
                <button
                  className="secondary"
                  onClick={async () => {
                    const response = await fetch(`${base}/ingestions/${job.id}/retry`, {
                      method: 'POST',
                    });
                    if (!response.ok)
                      setError((await response.json()).error || 'Could not retry extraction');
                  }}
                >
                  Retry extraction
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="case-document-upload" onSubmit={upload}>
        <h4>Add a demo document</h4>
        <div className="case-document-fields">
          <label className="field">
            <span>Document title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={160}
              placeholder="Original loan agreement"
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Document type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
              {Object.entries(kinds).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Text up to 100 KB or PDF up to 10 MB · 50 pages</span>
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.pdf,text/plain,application/pdf"
            required
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <button type="submit" className="secondary" disabled={busy || !file || !title.trim()}>
          <Upload size={15} />
          {busy ? 'Uploading…' : 'Upload document'}
        </button>
      </form>
      <div className="case-documents-section-heading">
        <h4>Document requests</h4>
        <span>
          <RefreshCw size={12} /> Live status
        </span>
      </div>
      {!data?.requests?.length ? (
        <div className="case-documents-empty">
          Requests made during a demo conversation will appear here.
        </div>
      ) : (
        <ul className="case-document-requests">
          {data.requests.map((request) => (
            <li key={request.id}>
              <div>
                <strong>{kinds[request.kind] || label(request.kind)}</strong>
                <small>{date(request.created_at)}</small>
                {request.error && <p className="error">{request.error}</p>}
              </div>
              <span className="case-document-request-status">{label(request.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
