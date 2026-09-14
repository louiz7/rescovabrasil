import { agentIdentities } from '../shared/agent-identities.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Pause, Play, Send } from 'lucide-react';
import './AgentConversations.css';

const base = '/api/agent-workflows';
const label = (value = '') => value.replaceAll('_', ' ');
const time = (value) => (value ? new Date(value).toLocaleString() : '');
async function request(path = '', body) {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update the agent conversation.');
  return data;
}

export default function AgentConversations({ caseId, onCase }) {
  const [conversations, setConversations] = useState(null);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const pending = useRef(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    setSelected('');
    setDetail(null);
    setDraft('');
    pending.current = null;
  }, [caseId]);
  useEffect(() => {
    let stopped = false;
    let timer;
    async function load() {
      try {
        const data = await request(caseId ? '?caseId=' + encodeURIComponent(caseId) : '');
        if (stopped) return;
        setConversations(data.conversations || []);
        if (!selected && data.conversations?.length) setSelected(data.conversations[0].id);
        if (selected) {
          const next = await request('/' + encodeURIComponent(selected));
          if (!stopped) setDetail(next);
        }
        if (!stopped) setLoadError('');
      } catch (e) {
        if (!stopped) setLoadError(e.message);
      }
      if (!stopped) timer = setTimeout(load, 2000);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [caseId, selected]);

  async function act(action) {
    if (busy || !selected) return;
    const id = selected;
    setBusy(true);
    setError('');
    try {
      const body =
        action === 'messages'
          ? (() => {
              const text = draft.trim();
              if (!pending.current || pending.current.text !== text || pending.current.id !== id) {
                pending.current = { id, text, requestId: crypto.randomUUID() };
              }
              return { text, requestId: pending.current.requestId };
            })()
          : {};
      const next = await request('/' + encodeURIComponent(id) + '/' + action, body);
      if (selectedRef.current === id) {
        setDetail(next);
        if (action === 'messages') {
          setDraft('');
          pending.current = null;
        }
      }
    } catch (e) {
      if (selectedRef.current === id) setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const conversation = detail?.conversation;
  const status = conversation?.status;
  const locked =
    !conversation ||
    ['paused', 'stopped', 'cancelled', 'closed', 'human_review', 'blocked', 'opted_out'].includes(
      status,
    );
  const working = (detail?.tasks || []).some((task) =>
    ['queued', 'running', 'pending', 'retrying'].includes(task.status),
  );
  return (
    <section className="agent-conversations" aria-label="Agent conversations">
      <div className="info-box">
        <span>
          <strong>Virtual SMS · no real messages sent.</strong> After a demo call ends with an
          accepted payment solution, the SMS agent takes over automatically. Reply as the person to
          try the conversation.
        </span>
      </div>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      {!conversations ? (
        <p>Loading conversations…</p>
      ) : !conversations.length ? (
        <div className="empty">
          <MessageSquare size={28} />
          <h3>No agent conversations yet</h3>
          <p>
            Agree to a payment solution in a voice demo, then end the call. Its SMS follow-up will
            appear here automatically.
          </p>
        </div>
      ) : (
        <>
          <label className="field">
            <span>Conversation</span>
            <select
              aria-label="Agent conversation"
              disabled={busy}
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setDetail(null);
                setDraft('');
                setError('');
                pending.current = null;
              }}
            >
              {conversations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caseName || item.debtorName || item.caseReference || item.caseId} ·{' '}
                  {label(item.status)}
                </option>
              ))}
            </select>
          </label>
          {!detail ? (
            <p>Loading messages…</p>
          ) : (
            <>
              <div className="agent-conversation-heading">
                <div>
                  <h3>{agentIdentities.payment_conversation_agent.name} · AI payment support</h3>
                  <span className="agent-conversation-status">{label(status)}</span>
                </div>
                <div className="agent-conversation-actions">
                  {onCase && !caseId && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onCase(conversation.caseId)}
                    >
                      Open case
                    </button>
                  )}
                  {status === 'paused' ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => act('resume')}
                    >
                      <Play size={14} /> Resume agent
                    </button>
                  ) : (
                    !locked && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => act('pause')}
                      >
                        <Pause size={14} /> Pause agent
                      </button>
                    )
                  )}
                  {(detail.tasks || []).some((task) => task.status === 'failed') && !locked && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => act('retry')}
                    >
                      Retry agent task
                    </button>
                  )}
                </div>
              </div>
              <ol className="agent-message-list" aria-label="SMS messages">
                {(detail.messages || []).map((message) => {
                  const incoming = message.direction === 'inbound' || message.role === 'user';
                  return (
                    <li
                      key={message.id}
                      className={incoming ? 'agent-message inbound' : 'agent-message outbound'}
                    >
                      <div className="agent-message-meta">
                        <strong>
                          {incoming
                            ? 'Demo person'
                            : agentIdentities.payment_conversation_agent.name}
                        </strong>
                        <span>{time(message.createdAt || message.created_at)}</span>
                      </div>
                      <p>{message.text || message.content || message.body}</p>
                      <span className="agent-message-delivery">
                        {incoming ? 'Received in demo' : 'Sent in virtual SMS'}
                      </span>
                    </li>
                  );
                })}
                {!detail.messages?.length && (
                  <li className="muted">The follow-up is waiting for the agent's first message.</li>
                )}
              </ol>
              {(detail.tasks || []).some((task) => task.status === 'waiting_source_end') && (
                <p className="agent-conversation-progress" role="status">
                  Waiting for the voice call to end before sending the follow-up.
                </p>
              )}
              {(detail.tasks || []).some((task) => task.status === 'failed') && (
                <p className="error" role="alert">
                  The agent could not prepare its message. Check model configuration, then retry the
                  agent task.
                </p>
              )}
              {working && (
                <p className="agent-conversation-progress" role="status">
                  The agent is working on the next message…
                </p>
              )}
              {locked && (
                <p className="info-box">
                  {status === 'paused'
                    ? 'The conversation is paused. Resume the agent to continue this demo.'
                    : 'Automated messages are stopped for this conversation. Check the case for the next step.'}
                </p>
              )}
              <form
                className="agent-reply"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (draft.trim()) act('messages');
                }}
              >
                <label className="field">
                  <span>Reply as the demo person</span>
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={draft}
                    disabled={busy || locked}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="For example: Can you send me the payment link?"
                  />
                </label>
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || locked || !draft.trim()}
                >
                  <Send size={15} />
                  {busy ? 'Sending…' : 'Send demo reply'}
                </button>
              </form>
              <details className="agent-workflow-details">
                <summary>Agent activity and model details</summary>
                <h4>Tasks</h4>
                <ul>
                  {(detail.tasks || []).map((task) => (
                    <li key={task.id}>
                      {label(
                        task.purpose || task.type || task.kind || task.role || 'SMS follow-up',
                      )}{' '}
                      · {label(task.status)}
                      {task.error && <p className="error">{task.error}</p>}
                    </li>
                  ))}
                </ul>
                {!!detail.runs?.length && (
                  <>
                    <h4>Model runs</h4>
                    <ul>
                      {detail.runs.map((run) => (
                        <li key={run.id}>
                          {agentIdentities[run.role]?.name ||
                            run.role ||
                            agentIdentities.payment_conversation_agent.name}{' '}
                          · {run.provider || 'Provider'} / {run.model || 'configured model'} ·{' '}
                          {label(run.status)}
                          {run.error && <p className="error">{run.error}</p>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {!!detail.events?.length && (
                  <>
                    <h4>Handoffs and events</h4>
                    <ul>
                      {detail.events.map((event, index) => (
                        <li key={event.id || index}>
                          {time(event.createdAt || event.created_at)} ·{' '}
                          {label(event.kind || event.type || event.name)}
                          {(event.summary || event.detail?.reason) && (
                            <> · {event.summary || event.detail.reason}</>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
