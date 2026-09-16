import React, { useEffect, useState } from 'react';
import { Mail, Send, RefreshCw, Pause, Paperclip, MessageSquare } from 'lucide-react';
import './EmailTest.css';

async function request(path = '', body) {
  const response = await fetch(
    '/api/email-test' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update the email test.');
  return data;
}
const label = (value = '') => value.replaceAll('_', ' ');

export default function EmailTest({ onConversation }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let stopped = false,
      timer;
    async function load() {
      try {
        const next = await request();
        if (!stopped) {
          setData(next);
          setSelected((current) => current || next.conversations?.[0]?.id || '');
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(load, 4000);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  async function act(action) {
    if (busy) return;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await request(
        '/' + action,
        action === 'sync' ? {} : { conversationId: selected },
      );
      if (action === 'preview') setPreview({ ...result, conversationId: selected });
      else {
        setData(await request());
        setNotice(
          action === 'start'
            ? 'Email follow-up activated. Check the delivery timeline below.'
            : action === 'pause'
              ? 'Email follow-up paused.'
              : 'Mailbox checked. New replies appear in the conversation.',
        );
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  if (!data)
    return (
      <div className="modal-body">
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : (
          <p>Loading email test…</p>
        )}
      </div>
    );
  const binding = data.bindings?.find((item) => item.conversationId === selected);
  const deliveries = (data.deliveries || []).filter((item) => item.conversationId === selected);
  const ready = data.configured && data.enabled;
  return (
    <div className="modal-body email-test">
      <section className="email-test-addresses" aria-label="Email test addresses">
        <Mail size={22} aria-hidden="true" />
        <div>
          <span>From</span>
          <strong>Marina · {data.sender || 'louiz@rescova.de'}</strong>
        </div>
        <div>
          <span>Only test recipient</span>
          <strong>{data.recipient || 'louiz@rescova.de'}</strong>
        </div>
        <span className={'badge ' + (ready ? 'ready' : 'paused')}>
          {ready ? 'Ready to test' : 'Setup required'}
        </span>
      </section>
      <p className="email-test-intro">
        Real email, fictional case. Ask for a document by email during a call, then end the call.
        Marina automatically prepares and queues the requested email. Continue by email or demo SMS
        with the same case context; this screen monitors delivery and offers manual test controls.
      </p>
      {!ready && (
        <section className="email-test-setup" aria-label="Email setup">
          <strong>Connect Google Workspace first</strong>
          <p>
            Complete the Gmail configuration described in <code>docs/EMAIL_TEST.md</code>, then
            restart the server. No SendGrid account or public callback URL is needed.
          </p>
          {data.missing?.length > 0 && <p>Missing: {data.missing.join(', ')}</p>}
          {!data.enabled && <p>Email sending is currently disabled.</p>}
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data.syncError && (
        <p role="alert" className="error">
          Mailbox sync: {data.syncError}
        </p>
      )}
      {notice && (
        <p role="status" className="email-test-notice">
          {notice}
        </p>
      )}
      <label className="email-test-select">
        Demo conversation
        <select
          value={selected}
          disabled={!!busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setPreview(null);
            setNotice('');
          }}
        >
          <option value="">Select a conversation</option>
          {(data.conversations || []).map((item) => (
            <option value={item.id} key={item.id}>
              {item.caseName || 'Demo case'} · {label(item.status)} · {item.id.slice(-8)}
            </option>
          ))}
        </select>
      </label>
      {!data.conversations?.length && (
        <p>
          There are no demo conversations yet. Complete a voice test and request a document or agree
          to a payment option first.
        </p>
      )}
      {binding && (
        <section className="email-test-setup" aria-label="Email automation status">
          <strong>Email follow-up · {label(binding.status)}</strong>
          <p>
            {binding.status === 'awaiting_configuration'
              ? 'The requested email is waiting for Gmail setup. It will continue automatically when email sending is configured and enabled.'
              : binding.status === 'active'
                ? 'Email delivery is active. Requested follow-ups are queued automatically; no manual send is needed.'
                : 'Email delivery is paused. Use the manual controls below to resume this test.'}
          </p>
        </section>
      )}
      {selected && (
        <div className="email-test-actions">
          <button className="secondary" disabled={!!busy} onClick={() => act('preview')}>
            Preview email
          </button>
          <button
            className="primary"
            disabled={
              !!busy ||
              !ready ||
              preview?.conversationId !== selected ||
              binding?.status === 'active'
            }
            onClick={() => act('start')}
          >
            <Send size={16} />
            {busy === 'start' ? 'Activating…' : 'Send test email'}
          </button>
          {binding?.status === 'active' && (
            <button className="secondary" disabled={!!busy} onClick={() => act('pause')}>
              <Pause size={16} />
              Pause email
            </button>
          )}
          <button className="secondary" onClick={() => onConversation(selected)}>
            <MessageSquare size={16} />
            Open conversation
          </button>
        </div>
      )}
      {preview && (
        <section className="email-test-preview" aria-label="Email preview">
          <span className="eyebrow">Preview · {preview.recipient || data.recipient}</span>
          <h3>{preview.subject}</h3>
          <p>{preview.text}</p>
          {preview.attachments?.map((item, index) => (
            <div className="email-test-attachment" key={index}>
              <Paperclip size={15} />
              {item.filename}
            </div>
          ))}
        </section>
      )}
      <section className="email-test-replies">
        <strong>Continue from your inbox</strong>
        <p>
          Open the demo email in Gmail and click Reply. Write only your new message as the demo
          person. Marina will respond in the same case; outgoing copies and automatic replies are
          ignored.
        </p>
        <button className="secondary" disabled={!!busy || !ready} onClick={() => act('sync')}>
          <RefreshCw size={16} />
          {busy === 'sync' ? 'Checking…' : 'Check replies now'}
        </button>
      </section>
      <section aria-label="Email delivery timeline" className="email-test-timeline">
        <h3>Delivery timeline</h3>
        <p>
          Submitted means Gmail accepted the message. It does not confirm delivery or that it was
          read.
        </p>
        {deliveries.length ? (
          deliveries.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.subject || 'Demo follow-up'}</strong>
                <span
                  className={
                    'badge ' +
                    (item.status === 'failed' || item.status === 'uncertain' ? 'paused' : 'ready')
                  }
                >
                  {label(item.status)}
                </span>
              </div>
              <time>{new Date(item.createdAt).toLocaleString()}</time>
              {item.error && <p className="error">{item.error}</p>}
              {item.status === 'uncertain' && (
                <p>
                  Check your Sent folder before retrying. This message will not be resent
                  automatically.
                </p>
              )}
            </article>
          ))
        ) : (
          <p>No email deliveries for this conversation yet.</p>
        )}
      </section>
    </div>
  );
}
