import React, { useEffect, useState } from 'react';
import './AgentsOverview.css';
import { Bot, MessageSquare, RefreshCw, ChevronDown, Check, Clock3 } from 'lucide-react';
export default function AgentsOverview({ onConversations }) {
  const [data, setData] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const r = await fetch('/api/agents');
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not load agents.');
        if (!stopped) {
          setData(d);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
    }
    load();
    const timer = setInterval(load, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      <div className="section-toolbar">
        <span>Agent roles, configuration and work status</span>
        <button className="primary" onClick={onConversations}>
          <MessageSquare size={16} />
          Demo SMS conversations
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <p>Loading agents…</p>
      ) : (
        <>
          <div className="info-box">
            <Bot size={20} />
            <span>
              <strong>{data.coordinator.name}</strong>
              <br />
              {data.coordinator.description}
            </span>
          </div>
          <div className="portfolio-grid agents-grid">
            {data.agents.map((a) => (
              <article className="card portfolio-card agent-card" key={a.id}>
                <div className="card-top">
                  <Bot size={22} />
                  <span className={'badge ' + (a.configured ? 'ready' : 'paused')}>
                    {a.configured ? 'Configured' : 'Configuration missing'}
                  </span>
                </div>
                <h2>{a.name}</h2>
                <p>
                  <strong>{a.role}</strong> · AI agent
                </p>
                <p>{a.description}</p>
                <div className="portfolio-meta">
                  <span>{a.provider}</span>
                  <strong>{a.model || 'No model selected'}</strong>
                </div>
                <p>
                  <strong>{a.execution}</strong> · {a.scope}
                </p>
                <div className="agent-card-footer">
                  {a.stats && (
                    <dl className="agent-card-stats" aria-label={`${a.name} work status`}>
                      {['running', 'queued', 'failed', 'completed'].map((status) => (
                        <div
                          key={status}
                          className={status === 'failed' && a.stats[status] ? 'has-failures' : ''}
                        >
                          <dt>{status}</dt>
                          <dd>{new Intl.NumberFormat('en-GB').format(a.stats[status] || 0)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <details className="agent-card-details">
                    <summary>
                      <span>Capabilities &amp; recent work</span>
                      <ChevronDown size={17} aria-hidden="true" />
                    </summary>
                    <div className="agent-card-detail-body">
                      <section aria-label={`${a.name} capabilities`}>
                        <h3>
                          Capabilities <span>{a.capabilities.length}</span>
                        </h3>
                        <ul className="agent-capability-list">
                          {a.capabilities.map((c) => (
                            <li key={c}>
                              <Check size={14} aria-hidden="true" />
                              <span>{c}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                      <section aria-label={`${a.name} recent work`}>
                        <h3>Recent work</h3>
                        {a.stats?.lastRuns?.length ? (
                          <ul className="agent-recent-list">
                            {a.stats.lastRuns.map((r, i) => {
                              const timestamp = r.created_at || r.createdAt;
                              const validDate =
                                timestamp && !Number.isNaN(new Date(timestamp).getTime());
                              return (
                                <li key={r.id || i}>
                                  <span
                                    className={`agent-run-dot ${r.status || 'completed'}`}
                                    aria-hidden="true"
                                  />
                                  <div>
                                    <strong>
                                      {(r.status || 'completed').replaceAll('_', ' ')}
                                    </strong>
                                    <span>{r.model || a.model}</span>
                                  </div>
                                  {validDate && (
                                    <time
                                      dateTime={timestamp}
                                      title={new Date(timestamp).toLocaleString('en-GB')}
                                    >
                                      {new Intl.DateTimeFormat('en-GB', {
                                        day: 'numeric',
                                        month: 'short',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      }).format(new Date(timestamp))}
                                    </time>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <div className="agent-work-empty">
                            <Clock3 size={18} aria-hidden="true" />
                            <div>
                              <strong>
                                {a.stats ? 'No activity yet' : 'Voice session activity'}
                              </strong>
                              <p>
                                {a.stats
                                  ? 'Completed runs will appear here.'
                                  : 'Explore conversations in the voice test and debug views.'}
                              </p>
                            </div>
                          </div>
                        )}
                      </section>
                    </div>
                  </details>
                </div>
              </article>
            ))}
          </div>
          <p className="muted small-text">
            <RefreshCw size={13} /> Updates every 3 seconds. Configured means credentials are
            present; provider access is verified when an agent runs. The SMS workflow uses simulated
            delivery.
          </p>
        </>
      )}
    </>
  );
}
