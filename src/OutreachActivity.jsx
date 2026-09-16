import React from 'react';
import './OutreachActivity.css';

const names = { call: 'Calling', sms: 'SMS', email: 'Email' };
export default function OutreachActivity({ activity }) {
  if (!activity)
    return (
      <section className="card activity-card">
        <h2>Outreach activity</h2>
        <p>Activity data is unavailable.</p>
      </section>
    );
  const rows = activity.channels;
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const value = (day) => day.count;
  const max = Math.max(1, ...activity.daily.map(value));
  return (
    <section className="card activity-card">
      <div className="section-title">
        <div>
          <h2>Outreach activity</h2>
          <p>Last 14 days · São Paulo time</p>
        </div>
      </div>
      <div className="chart-summary">
        <strong>{total}</strong>
        <span>
          recorded attempts
          <br />
          <small>
            {rows.reduce((n, r) => n + r.external, 0)} external ·{' '}
            {rows.reduce((n, r) => n + r.simulated, 0)} simulated
          </small>
        </span>
      </div>
      <div
        className="bar-chart"
        role="img"
        aria-label={activity.daily
          .map(
            (day) =>
              `${day.day}: ${value(day)} attempts; ${rows.map((row) => `${names[row.channel]} ${day[row.channel]}`).join(', ')}`,
          )
          .join('; ')}
      >
        <div className="chart-grid">
          <span>{max}</span>
          <span>{Math.ceil(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="chart-bars">
          {activity.daily.map((day) => (
            <div className="chart-column" key={day.day}>
              <div
                className="outreach-stack"
                style={{ height: `${(value(day) / max) * 100}%` }}
                title={`${day.day}: ${value(day)} attempts`}
              >
                {rows.map((row) => (
                  <div
                    key={row.channel}
                    className={`outreach-segment outreach-${row.channel}`}
                    style={{ flex: day[row.channel] }}
                  />
                ))}
              </div>
              <small>{day.day.slice(8)}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="outreach-legend" aria-label="Outreach channels">
        {rows.map((row) => (
          <span key={row.channel}>
            <i className={`outreach-${row.channel}`} aria-hidden="true" />
            {names[row.channel]}
          </span>
        ))}
      </div>
    </section>
  );
}
