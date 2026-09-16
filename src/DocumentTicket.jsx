import React, { useEffect, useState } from 'react';
import './DocumentTicket.css';

const label = (value = '') => value.replaceAll('_', ' ');
const date = (value) => (value ? new Date(value).toLocaleString() : '—');

export default function DocumentTicket({ ticketId }) {
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer;
    setTicket(null);
    async function refresh() {
      try {
        const response = await fetch(`/api/document-tickets/${encodeURIComponent(ticketId)}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load document ticket.');
        if (!stopped) {
          setTicket(result);
          setError('');
        }
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
  }, [ticketId]);
  if (!ticket)
    return <p role={error ? 'alert' : undefined}>{error || 'Loading document ticket…'}</p>;
  return (
    <div className="document-ticket">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="ticket-current">
        <span className="ticket-state">{label(ticket.status)}</span>
        <strong>{ticket.owner}</strong>
        <p>{ticket.nextAction}</p>
      </div>
      <ol className="ticket-steps">
        {(ticket.steps || []).map((step) => (
          <li key={step.key}>
            <div>
              <strong>{step.title}</strong>
              <span>{label(step.status)}</span>
            </div>
            <small>{step.owner}</small>
            {step.evidence && (
              <p>
                {typeof step.evidence === 'string'
                  ? step.evidence
                  : step.evidence.providerMessageId
                    ? `Provider reference: ${step.evidence.providerMessageId}`
                    : step.evidence.version
                      ? `Pinned document · Version ${step.evidence.version}`
                      : step.evidence.messageId
                        ? 'Linked message saved'
                        : 'Waiting for completion evidence'}
              </p>
            )}
          </li>
        ))}
      </ol>
      <dl className="ticket-facts">
        <div>
          <dt>Ticket</dt>
          <dd>{ticket.id}</dd>
        </div>
        <div>
          <dt>Channel</dt>
          <dd>{ticket.channel === 'email' ? 'Email' : 'SMS · simulated'}</dd>
        </div>
        <div>
          <dt>Document version</dt>
          <dd>
            {ticket.documentVersion ? `Version ${ticket.documentVersion}` : 'Waiting for document'}
          </dd>
        </div>
        <div>
          <dt>Processing attempts</dt>
          <dd>
            {ticket.attempts} / {ticket.maxAttempts}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{date(ticket.createdAt)}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>{date(ticket.deadlineAt)}</dd>
        </div>
        {ticket.providerMessageId && (
          <div>
            <dt>Gmail submission reference</dt>
            <dd>{ticket.providerMessageId}</dd>
          </div>
        )}
        {ticket.completedAt && (
          <div>
            <dt>Completed</dt>
            <dd>{date(ticket.completedAt)}</dd>
          </div>
        )}
      </dl>
      {ticket.error && <p className="error">{ticket.error}</p>}
      <p className="muted small-text">
        Completion requires the linked message to be submitted to Gmail, or delivered in the virtual
        SMS demo. It does not confirm email delivery or reading.
      </p>
    </div>
  );
}
