import React, { useState } from 'react';
import DemoPaymentSolutions from './DemoPaymentSolutions';

const labels = {
  draft: 'Draft ready for review',
  blocked_missing_contact: 'Recipient needed',
  blocked_missing_payment_details: 'Payment details needed',
  cancelled: 'Cancelled',
};
function PaymentJob({ job, onSaved }) {
  const [channel, setChannel] = useState(job.channel || 'sms');
  const [destination, setDestination] = useState(job.destination || '');
  const [paymentDetails, setPaymentDetails] = useState(job.payment_details || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const cancelled = job.status === 'cancelled';
  async function save(body) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/payment-followups/' + job.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save the payment follow-up.');
      setNotice(
        body.status === 'cancelled'
          ? 'Draft cancelled. No message was sent.'
          : 'Draft saved. No message was sent.',
      );
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="demo-payment-solutions">
      <div className="demo-payment-heading">
        <h3>Payment follow-up draft</h3>
        <span>NOT SENT</span>
      </div>
      <p>
        <strong>{labels[job.status] || job.status}</strong>
      </p>
      <p className="muted small-text">
        Add a recipient and the payment instructions approved for this demo. Demo links and Pix
        instructions are non-payable placeholders. Saving updates the draft only; SMS and email are
        not sent to real recipients. Automatic virtual SMS conversations are shown in the
        Conversations tab.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save({ channel, destination, paymentDetails });
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>Delivery channel</span>
            <select
              disabled={busy || cancelled}
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          </label>
          <label className="field">
            <span>Recipient</span>
            <input
              disabled={busy || cancelled}
              type={channel === 'email' ? 'email' : 'tel'}
              value={destination}
              placeholder={channel === 'email' ? 'recipient@example.com' : '+5511999999999'}
              onChange={(event) => setDestination(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Payment details</span>
          <textarea
            disabled={busy || cancelled}
            rows={4}
            maxLength={2000}
            value={paymentDetails}
            onChange={(event) => setPaymentDetails(event.target.value)}
            placeholder="Enter the creditor-approved payment link, account instructions, or other payment details for this demo."
          />
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <p className="success-box" role="status">
            {notice}
          </p>
        )}
        {!cancelled && (
          <div className="voice-test-controls">
            <button className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save payment draft'}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => save({ status: 'cancelled' })}
            >
              Cancel draft
            </button>
          </div>
        )}
      </form>
      <h4>Saved message preview</h4>
      <div className="info-box">
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
          {job.message || 'Save the draft to generate its message preview.'}
        </p>
      </div>
    </article>
  );
}
export default function PaymentFollowups({ agreements = [], jobs = [], onSaved }) {
  if (!agreements.length && !jobs.length)
    return (
      <div className="empty">
        <h3>No payment solutions yet</h3>
        <p>
          An accepted demo voice solution creates a saved agreement and a payment follow-up draft
          here.
        </p>
      </div>
    );
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <p className="info-box">
        These are simulated agreements. No payment has been collected, and no follow-up message has
        been sent.
      </p>
      {agreements.map((agreement) => (
        <DemoPaymentSolutions key={agreement.id} agreement={agreement} />
      ))}
      {jobs.map((job) => (
        <PaymentJob key={job.id} job={job} onSaved={onSaved} />
      ))}
    </div>
  );
}
