import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pause, Play, Upload, Users } from 'lucide-react';
import './portfolio-detail.css';

const channels = { sms: 'SMS', email: 'Email', voice: 'AI phone call', whatsapp: 'WhatsApp' };
const labels = {
  not_reached: 'Not reached',
  invalid_contact: 'Invalid contact',
  callback: 'Callback requested',
  paid_reported: 'Payment reported',
  willing_to_pay: 'Willing to pay',
  unable_to_pay: 'Financial difficulty',
  disputed: 'Debt disputed',
  human_review: 'Human review',
  opt_out: 'Do not contact',
};
const count = (value) => new Intl.NumberFormat('en-GB').format(value || 0);
const money = (value) =>
  value == null
    ? 'Not available'
    : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'BRL' }).format(value / 100);
async function request(path, body) {
  const response = await fetch('/api/portfolios/' + path, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update this portfolio.');
  return data;
}

export default function PortfolioDetail({
  id,
  settings,
  onChanged,
  onCases,
  onImport,
  onSimulate,
}) {
  const [portfolio, setPortfolio] = useState(null);
  const [autonomy, setAutonomy] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  useEffect(() => {
    let stopped = false;
    initialized.current = false;
    setPortfolio(null);
    setError('');
    async function load() {
      try {
        const [value, autonomyValue] = await Promise.all([request(id), request(`${id}/autonomy`)]);
        if (stopped) return;
        setPortfolio(value);
        setAutonomy(autonomyValue);
        if (!initialized.current) {
          setSelected(
            value.channels?.length
              ? value.channels.filter(
                  (key) => value.status !== 'draft' || settings?.capabilities?.[key]?.available,
                )
              : ['sms', 'email', 'voice'].filter((key) => settings?.capabilities?.[key]?.available),
          );
          initialized.current = true;
        }
      } catch (err) {
        if (!stopped) setError(err.message);
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id]);

  async function update(action) {
    setBusy(true);
    setError('');
    try {
      const value = await request(
        `${id}/${action}`,
        action === 'activate' ? { channels: selected } : {},
      );
      setPortfolio(value);
      setSelected(value.channels || []);
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function runAutonomy() {
    setBusy(true);
    setError('');
    try {
      const result = await request(`${id}/autonomy/run`, {});
      setAutonomy(result);
      setPortfolio(await request(id));
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  function move(index, offset) {
    setSelected((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }

  const metrics = portfolio?.metrics || {};
  const active = portfolio?.status === 'active';
  const demo = portfolio?.mode === 'demo';
  const autonomousDemo = portfolio?.name === 'Autonomous collections demo';
  const policy = settings?.policy || {};
  const hasAvailableChannel = selected.some((key) => settings?.capabilities?.[key]?.available);
  const date = (value) =>
    value
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: portfolio?.timezone || 'America/Sao_Paulo',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(value))
      : '—';
  return (
    <div className="modal-body portfolio-detail">
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!portfolio ? (
        <p className="muted">{error ? 'Portfolio could not be loaded.' : 'Loading portfolio…'}</p>
      ) : (
        <>
          <div className="section-toolbar">
            <div>
              <h3>{portfolio.name}</h3>
              <p className="muted small-text">
                {portfolio.creditor} · {portfolio.timezone || 'America/Sao_Paulo'}
              </p>
            </div>
            <span className={`badge ${active ? 'running' : portfolio.status}`}>
              <i />
              {active ? 'Active' : portfolio.status === 'paused' ? 'Paused' : 'Draft'}
            </span>
          </div>
          <div className="portfolio-operation-note">
            <strong>
              {portfolio.automationBlocked
                ? 'Voice demo results'
                : active
                  ? 'Ongoing portfolio operation'
                  : 'Activate once. Oversee progress over time.'}
            </strong>
            <p>
              {portfolio.automationBlocked
                ? 'Accepted voice-test agreements appear here for review. Outreach is disabled for this demo portfolio.'
                : 'An active portfolio has no end date. New eligible cases join automatically; contacts follow the selected channel order and stop when a case needs review or reaches its attempt limit.'}
            </p>
            {!portfolio.automationBlocked && (
              <p>
                {demo
                  ? 'Demo mode: progress advances through explicit simulations. No real messages or calls are sent.'
                  : !hasAvailableChannel
                    ? 'Live outreach is unavailable until a selected channel is configured.'
                    : active
                      ? 'Live mode: eligible outreach is processed within the configured contact windows.'
                      : 'Live mode: activating this portfolio enables eligible outreach within the configured contact windows.'}
              </p>
            )}
          </div>

          <div className="portfolio-progress-title">
            <h3>Portfolio progress</h3>
            <span className="muted small-text">Updates every 5 seconds</span>
          </div>
          <div className="portfolio-metrics">
            {[
              ['Cases', metrics.cases],
              ['Cases attempted', metrics.attemptedCases],
              ['People reached', metrics.reachedCases],
              ['Contact attempts', metrics.attempts],
              ['Responses', metrics.responses],
              ['Payment agreements', metrics.agreementCount],
              ['Open follow-ups', metrics.openFollowups],
              ['Human review', metrics.reviewCases],
            ].map(([label, value]) => (
              <div key={label}>
                <strong>{count(value)}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="portfolio-metrics portfolio-money-metrics">
            <div>
              <strong>{money(portfolio.balance)}</strong>
              <span>Known balance · BRL cases</span>
            </div>
            <div>
              <strong>{money(metrics.agreedAmountMinor)}</strong>
              <span>Agreed amount · promised, not paid</span>
            </div>
            <div>
              <strong>{money(metrics.simulatedReceivedMinor ?? 0)}</strong>
              <span>Simulated receipts · no real money collected</span>
            </div>
            <div>
              <strong>{money(metrics.recoveredAmountMinor)}</strong>
              <span>Verified recovery · payment data not connected</span>
            </div>
          </div>
          <div className="portfolio-coverage">
            <div>
              <span>Contact coverage</span>
              <strong>{metrics.coveragePercent || 0}%</strong>
            </div>
            <progress
              aria-label="Contact coverage"
              max="100"
              value={metrics.coveragePercent || 0}
            />
            <p className="muted small-text">
              {count(metrics.attemptedCases)} of {count(metrics.cases)} cases have a contact
              attempt. Agreements and reported payments are not verified recoveries.
            </p>
          </div>
          <div className="portfolio-work-status">
            <span>
              <strong>{count(metrics.queuedCases)}</strong> queued
            </span>
            <span>
              <strong>{count(metrics.waitingCases)}</strong> waiting for a response or next contact
            </span>
            <span>
              <strong>{count(metrics.blockedCases)}</strong> contact blocked
            </span>
          </div>

          {!portfolio.automationBlocked && (
            <section className="portfolio-channel-section">
              <h3>Outreach channels</h3>
              <p className="muted small-text">
                Use available contact details in this order.{' '}
                {active
                  ? 'Pause the portfolio to change the order for new cases.'
                  : 'Select channels and arrange the fallback order.'}{' '}
                Changes apply to newly added cases; existing sequences keep their channels.
              </p>
              <div className="portfolio-channel-options">
                {Object.entries(channels).map(([key, label]) => {
                  const available = !!settings?.capabilities?.[key]?.available;
                  return (
                    <label key={key} className={!available ? 'muted' : ''}>
                      <input
                        type="checkbox"
                        checked={selected.includes(key)}
                        disabled={busy || active || (!available && !selected.includes(key))}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, key]
                              : current.filter((item) => item !== key),
                          )
                        }
                      />
                      <span>
                        {label}
                        {!available && (
                          <small>{settings?.capabilities?.[key]?.reason || 'Unavailable'}</small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {!!selected.length && (
                <ol className="portfolio-channel-order">
                  {selected.map((key, index) => (
                    <li key={key}>
                      <span>
                        <b>{index + 1}</b>
                        {channels[key] || key}
                      </span>
                      {!active && (
                        <div>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Move ${channels[key]} earlier`}
                            disabled={busy || index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Move ${channels[key]} later`}
                            disabled={busy || index === selected.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown size={15} />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              <p className="muted small-text">
                Current policy: {policy.gapHours || 24} hours between contacts, up to{' '}
                {policy.maxAttempts || 3} attempts. Opt-outs and human review stop further outreach.
                Reaching the limit does not restart the sequence the next day.
              </p>
              <div className="portfolio-actions">
                <button
                  className={active ? 'secondary' : 'primary'}
                  disabled={
                    busy ||
                    (!active &&
                      (!selected.length ||
                        selected.some((key) => !settings?.capabilities?.[key]?.available)))
                  }
                  onClick={() => update(active ? 'pause' : 'activate')}
                >
                  {active ? <Pause size={16} /> : <Play size={16} />}
                  {busy
                    ? 'Updating…'
                    : active
                      ? 'Pause portfolio'
                      : portfolio.status === 'paused'
                        ? 'Resume portfolio'
                        : demo
                          ? 'Activate demo portfolio'
                          : 'Go live'}
                </button>
                {demo && active && onSimulate && !autonomousDemo && (
                  <button className="secondary" onClick={onSimulate}>
                    Simulate portfolio contact
                  </button>
                )}
                {demo && active && autonomousDemo && (
                  <button className="primary" disabled={busy} onClick={runAutonomy}>
                    <Play size={16} />
                    {busy ? 'Running agents…' : 'Run autonomous work cycle'}
                  </button>
                )}
              </div>
            </section>
          )}

          {!portfolio.automationBlocked && autonomousDemo && (
            <section className="autonomy-section">
              <div className="portfolio-progress-title">
                <div>
                  <h3>Autonomous work cycle</h3>
                  <p className="muted small-text">
                    Mateo plans one safe next action per case. Specialist agents execute mock work
                    and feed results back into the shared case state.
                  </p>
                </div>
                {autonomy?.latestRun && (
                  <span className={`badge ${autonomy.latestRun.status}`}>
                    {autonomy.latestRun.status.replaceAll('_', ' ')}
                  </span>
                )}
              </div>
              {!autonomy?.latestRun ? (
                <div className="autonomy-empty">
                  <strong>Ready for the first run</strong>
                  <span>
                    Activate this portfolio, then run the work cycle. No external call, SMS or email
                    is sent.
                  </span>
                </div>
              ) : (
                <>
                  <div className="autonomy-summary">
                    {[
                      ['Cases scanned', autonomy.latestRun.scanned],
                      ['Tasks planned', autonomy.latestRun.planned],
                      ['Tasks executed', autonomy.latestRun.executed],
                      ['Waiting / scheduled', autonomy.latestRun.waiting],
                    ].map(([title, value]) => (
                      <div key={title}>
                        <strong>{count(value)}</strong>
                        <span>{title}</span>
                      </div>
                    ))}
                  </div>
                  {autonomy.lastCheck?.id !== autonomy.latestRun.id && (
                    <div className="autonomy-noop">
                      Latest scan found no new work: {count(autonomy.lastCheck.scanned)} cases
                      checked, {count(autonomy.lastCheck.skipped)} already covered.
                    </div>
                  )}
                  <div className="autonomy-task-list">
                    {autonomy.tasks.map((task) => (
                      <div key={task.id}>
                        <span className={`autonomy-task-state ${task.status}`} />
                        <div>
                          <strong>{task.name || task.reference}</strong>
                          <span>
                            {task.owner} · {(task.kind || '').replaceAll('_', ' ')}
                            {task.channel ? ` · ${channels[task.channel] || task.channel}` : ''}
                          </span>
                          <p>{task.result?.nextAction || task.result?.detail || task.reason}</p>
                        </div>
                        <small>{task.status.replaceAll('_', ' ')}</small>
                      </div>
                    ))}
                  </div>
                  <p className="muted small-text">
                    {autonomy.decisions.length} semantic channel decisions recorded. All outcomes in
                    this view are synthetic and provider contacts remain zero.
                  </p>
                </>
              )}
            </section>
          )}

          <section>
            <h3>Recent activity</h3>
            {portfolio.recentAttempts?.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Person / time</th>
                      <th>Channel</th>
                      <th>Status</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.recentAttempts.map((attempt) => (
                      <tr key={attempt.id}>
                        <td>
                          {attempt.name || attempt.reference}
                          <small className="block">{date(attempt.created_at)}</small>
                        </td>
                        <td>{channels[attempt.channel] || attempt.channel}</td>
                        <td>{(attempt.status || '').replaceAll('_', ' ')}</td>
                        <td>
                          {labels[attempt.outcome] || attempt.outcome || 'No response recorded'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No contact attempts yet.</p>
            )}
          </section>
          <p className="muted small-text">
            The planner and specialist task loop are active for mock runs. Provider-backed
            autonomous execution remains disabled until its adapters and production controls are
            connected.
          </p>
          <div className="portfolio-actions">
            {onCases && (
              <button className="secondary" onClick={() => onCases(id)}>
                <Users size={16} />
                View cases
              </button>
            )}
            {onImport && !portfolio.automationBlocked && (
              <button className="secondary" onClick={() => onImport(id)}>
                <Upload size={16} />
                Import cases
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
