import React, { useEffect, useRef, useState } from 'react';
import { CreditCard, FlaskConical, RefreshCw } from 'lucide-react';
import './CasePayments.css';

const label = (value = '') => value.replaceAll('_', ' ');
const money = (minor, currency = 'BRL') =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).format((minor || 0) / 100);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

export default function CasePayments({ caseId, onChanged }) {
  const pendingEvent = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [status, setStatus] = useState('succeeded');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const base = `/api/cases/${encodeURIComponent(caseId)}/payments`;
  async function read() {
    const response = await fetch(base);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load payments.');
    return result;
  }
  useEffect(() => {
    let stopped = false;
    let timer;
    setData(null);
    pendingEvent.current = null;
    setRequestId('');
    setPaymentId('');
    setError('');
    async function refresh() {
      try {
        const result = await read();
        if (!stopped) setData(result);
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(refresh, 4000);
    }
    refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [base]);

  const installments = (data?.agreements || []).flatMap((agreement) =>
    (agreement.installments || []).map((installment) => ({
      ...installment,
      currency: agreement.currency,
    })),
  );
  const selected = installments.find((installment) => installment.request?.id === requestId);
  const payments = (data?.payments || []).filter((payment) => payment.request_id === requestId);
  const existing = payments.find((payment) => payment.id === paymentId);
  const reversal = status === 'refunded' || status === 'reversed';
  const currency = selected?.currency || data?.summary?.currency || 'BRL';
  const simulation = data?.summary?.mode === 'simulation';

  async function submit(path, body, success) {
    if (busy) return;
    if (path === 'simulate') {
      const signature = JSON.stringify({
        ...body,
        eventId: undefined,
        paymentId: paymentId || undefined,
      });
      if (pendingEvent.current?.signature === signature) body = pendingEvent.current.body;
      else pendingEvent.current = { signature, body };
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Payment simulation failed.');
      setData(await read());
      if (path === 'simulate') pendingEvent.current = null;
      setNotice(success);
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="case-payments" aria-label="Payment ledger">
      <div className="case-payments-heading">
        <CreditCard size={22} aria-hidden="true" />
        <div>
          <h3>Payments</h3>
          <p>Installments, recorded receipts and the agents’ next steps.</p>
        </div>
        <span className="case-payment-badge">{simulation ? 'Simulation' : 'Payment ledger'}</span>
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
      {!data ? (
        <p className="muted">Loading payments…</p>
      ) : (
        <>
          <div className="case-payment-summary">
            <div>
              <small>{simulation ? 'Simulated receipts' : 'Recorded receipts'}</small>
              <strong>{money(data.summary?.receivedMinor, currency)}</strong>
            </div>
            <div>
              <small>Agreement remaining</small>
              <strong>{money(data.summary?.remainingMinor, currency)}</strong>
            </div>
            <div>
              <small>Unallocated</small>
              <strong>{money(data.summary?.unallocatedMinor, currency)}</strong>
            </div>
          </div>
          {!data.agreements?.length && (
            <p className="case-payment-empty">
              Accept a payment agreement in a demo conversation to create its installment schedule.
            </p>
          )}
          {(data.agreements || []).map((agreement) => (
            <article className="case-payment-agreement" key={agreement.id}>
              <header>
                <div>
                  <h4>Payment agreement</h4>
                  <small>
                    {money(agreement.total_minor, agreement.currency)} ·{' '}
                    {agreement.installments?.length || 0} installment(s)
                  </small>
                </div>
                <span className="case-payment-badge">{label(agreement.status)}</span>
              </header>
              <ol className="case-payment-installments">
                {(agreement.installments || []).map((installment) => (
                  <li key={installment.id}>
                    <div>
                      <strong>Installment {installment.sequence}</strong>
                      <small>Due {installment.due_date}</small>
                    </div>
                    <div>
                      <strong>{money(installment.amount_minor, agreement.currency)}</strong>
                      <small>
                        {money(installment.paidMinor, agreement.currency)} received ·{' '}
                        {money(installment.remainingMinor, agreement.currency)} remaining
                      </small>
                    </div>
                    <span className="case-payment-badge">{label(installment.status)}</span>
                  </li>
                ))}
              </ol>
            </article>
          ))}
          {simulation && installments.some((installment) => installment.request) && (
            <details className="case-payment-simulator">
              <summary>
                <FlaskConical size={17} /> Test a payment event
              </summary>
              <div className="case-payment-simulator-content">
                <p className="muted">
                  Simulates provider events. No money moves. Agents can react to these events within
                  the demo workflow.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const amountMinor = Math.round(Number(amount) * 100);
                    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
                      setError('Enter a positive amount with up to two decimal places.');
                      return;
                    }
                    submit(
                      'simulate',
                      {
                        requestId,
                        eventId: crypto.randomUUID(),
                        paymentId: paymentId || crypto.randomUUID(),
                        status,
                        amountMinor: status === 'reversed' ? existing?.amount_minor : amountMinor,
                        currency,
                        version: Number(existing?.version || 0) + 1,
                      },
                      'Simulated payment event recorded. The ledger and agent tasks have been refreshed.',
                    );
                  }}
                >
                  <div className="case-payment-form-grid">
                    <label className="field">
                      <span>Installment</span>
                      <select
                        required
                        disabled={busy}
                        value={requestId}
                        onChange={(event) => {
                          const selected = installments.find(
                            (i) => i.request?.id === event.target.value,
                          );
                          setRequestId(event.target.value);
                          setPaymentId('');
                          setStatus('succeeded');
                          setAmount(
                            (
                              (selected?.remainingMinor || selected?.amount_minor || 0) / 100
                            ).toFixed(2),
                          );
                        }}
                      >
                        <option value="">Choose an installment</option>
                        {installments
                          .filter((i) => i.request)
                          .map((i) => (
                            <option key={i.id} value={i.request.id}>
                              Installment {i.sequence} · {i.due_date} ·{' '}
                              {money(i.remainingMinor, i.currency)} remaining
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Payment</span>
                      <select
                        value={paymentId}
                        disabled={busy || !requestId}
                        required={reversal}
                        onChange={(event) => {
                          setPaymentId(event.target.value);
                          const payment = payments.find((p) => p.id === event.target.value);
                          if (payment) setAmount((payment.amount_minor / 100).toFixed(2));
                        }}
                      >
                        <option value="">New payment</option>
                        {payments.map((payment) => (
                          <option value={payment.id} key={payment.id}>
                            {money(payment.amount_minor, payment.currency)} ·{' '}
                            {label(payment.status)} · {payment.id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Event</span>
                      <select
                        value={status}
                        disabled={busy}
                        onChange={(event) => setStatus(event.target.value)}
                      >
                        {['succeeded', 'processing', 'failed', 'refunded', 'reversed'].map(
                          (value) => (
                            <option key={value} value={value}>
                              {label(value)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="field">
                      <span>
                        {status === 'refunded'
                          ? 'Total refunded so far'
                          : status === 'reversed'
                            ? 'Full reversal amount'
                            : 'Amount'}{' '}
                        ({currency})
                      </span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        value={amount}
                        disabled={busy || !requestId || status === 'reversed'}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                    </label>
                  </div>
                  {reversal && (
                    <p className="muted">
                      Select an existing payment to refund or reverse. The event is validated
                      against its recorded state.
                    </p>
                  )}
                  <button
                    className="secondary"
                    disabled={busy || !requestId || (reversal && !paymentId)}
                  >
                    {busy ? 'Recording…' : 'Record simulated event'}
                  </button>
                </form>
                <form
                  className="case-payment-clock"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(
                      'tick',
                      { date },
                      'Scheduled payment tasks checked for the selected simulation date.',
                    );
                  }}
                >
                  <label className="field">
                    <span>Check scheduled tasks for date</span>
                    <input
                      type="date"
                      required
                      disabled={busy}
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    <RefreshCw size={15} /> Run simulation check
                  </button>
                </form>
              </div>
            </details>
          )}
          {!!data.payments?.length && (
            <div className="case-payment-activity">
              <h4>Recorded payments</h4>
              {data.payments.map((payment) => (
                <div key={payment.id}>
                  <span>
                    {money(payment.amount_minor, payment.currency)}
                    <small>
                      Net receipt {money(payment.netMinor, payment.currency)} ·{' '}
                      {payment.id.slice(0, 8)}
                    </small>
                  </span>
                  <span className="case-payment-badge">{label(payment.status)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="case-payment-activity">
            <h4>Agent payment tasks</h4>
            {!data.tasks?.length ? (
              <p className="muted">No payment tasks yet.</p>
            ) : (
              data.tasks.map((task) => (
                <div key={task.id}>
                  <span>
                    <strong>
                      {label(task.kind || task.type || task.purpose || 'Payment task')}
                    </strong>
                    <small>
                      {task.owner || task.agent || 'Marina'}
                      {task.due_at ? ` · ${task.due_at}` : ''}
                    </small>
                    {(task.next_action || task.error) && (
                      <small>{task.next_action || task.error}</small>
                    )}
                  </span>
                  <span className="case-payment-badge">{label(task.status)}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}
