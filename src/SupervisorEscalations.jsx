import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import './SupervisorEscalations.css';

const label = (value = '') => value.replaceAll('_', ' ').replaceAll('.', ' ');
const isResolved = (item) => item.status === 'resolved';

export default function SupervisorEscalations({ onConversation, onCase }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer;
    async function load() {
      try {
        const response = await fetch('/api/agent-workflows/escalations');
        const next = await response.json();
        if (!response.ok) throw new Error(next.error || 'Could not load supervisor escalations.');
        if (!stopped) {
          setData(next);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(load, 3000);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  const query = search.trim().toLowerCase();
  const items = (data?.escalations || []).filter(
    (item) =>
      (filter === 'all' ||
        (filter === 'open'
          ? !['resolved', 'cancelled'].includes(item.status)
          : filter === 'cancelled'
            ? item.status === 'cancelled'
            : isResolved(item))) &&
      (!query ||
        [
          item.reason,
          item.caseName,
          item.caseReference,
          item.caseId,
          item.trigger,
          item.nextAction,
        ].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(query),
        )),
  );
  return (
    <section className="supervisor-escalations card" aria-label="Supervisor escalations">
      <div className="supervisor-escalations-heading">
        <div>
          <h2>Supervisor escalations</h2>
          <p>
            Rafael’s handoffs, decisions and unresolved work. Review recurring gaps across cases.
          </p>
        </div>
        {data?.summary && (
          <dl className="supervisor-escalations-counts">
            {['total', 'open', 'resolved'].map((key) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{data.summary[key] || 0}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="supervisor-escalations-filters">
        <label className="supervisor-escalations-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search escalations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search case, reason or next step…"
          />
        </label>
        <label className="supervisor-escalations-filter">
          <span>Status</span>
          <select
            aria-label="Escalation status"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All escalations</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>
      {data?.escalations?.length >= 200 && (
        <p className="muted small-text">
          Latest 200 escalations. Filters search this loaded history.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p className="muted">Loading escalations…</p>
      ) : !items.length ? (
        <p className="supervisor-escalations-empty">
          {data.escalations?.length
            ? 'No escalations match these filters.'
            : 'No supervisor escalations yet. New handoffs will appear here automatically.'}
        </p>
      ) : (
        <div className="supervisor-escalations-table-wrap">
          <table className="supervisor-escalations-table">
            <thead>
              <tr>
                <th>Case / trigger</th>
                <th>Reason / next step</th>
                <th>Status</th>
                <th>Updated</th>
                <th>
                  <span className="supervisor-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {onCase ? (
                      <button className="supervisor-case-link" onClick={() => onCase(item.caseId)}>
                        {item.caseName || item.caseReference || item.caseId}
                      </button>
                    ) : (
                      <strong>{item.caseName || item.caseReference || item.caseId}</strong>
                    )}
                    <small>{item.caseReference || item.caseId}</small>
                    <span className="supervisor-trigger">{label(item.trigger)}</span>
                  </td>
                  <td>
                    <p>{item.reason || 'Reason not recorded.'}</p>
                    {item.nextAction && (
                      <p className="supervisor-next-action">
                        <strong>Next:</strong> {item.nextAction}
                      </p>
                    )}
                  </td>
                  <td>
                    <span
                      className={`supervisor-escalation-status ${isResolved(item) ? 'resolved' : 'open'}`}
                    >
                      {label(item.status)}
                    </span>
                  </td>
                  <td>
                    <time
                      dateTime={item.updatedAt || item.createdAt}
                      title={
                        item.createdAt
                          ? `Created ${new Date(item.createdAt).toLocaleString('en-GB')}`
                          : undefined
                      }
                    >
                      {item.updatedAt || item.createdAt
                        ? new Date(item.updatedAt || item.createdAt).toLocaleString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </time>
                  </td>
                  <td>
                    {onConversation && item.conversationId && (
                      <button
                        className="secondary"
                        onClick={() => onConversation(item.conversationId)}
                      >
                        <ArrowUpRight size={14} aria-hidden="true" /> Open conversation
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
