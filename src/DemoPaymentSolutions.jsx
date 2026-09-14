import React from 'react';
import './DemoPaymentSolutions.css';

const amount = (value, currency = 'BRL') =>
  Number.isInteger(value)
    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value / 100)
    : 'Not provided';
function dueLabel(installment) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(installment.dueDate || '')) {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(installment.dueDate + 'T12:00:00Z'));
  }
  const days = installment.dueInDays;
  const months = installment.monthOffset || 0;
  const anchor =
    days === 0
      ? 'On the test date'
      : Number.isInteger(days)
        ? `${days} days after the test date`
        : 'Date agreed in the test';
  return months ? `${anchor}, plus ${months} month${months === 1 ? '' : 's'}` : anchor;
}
function Schedule({ installments = [], currency }) {
  return (
    <ol className="demo-payment-schedule">
      {installments.map((installment, index) => (
        <li key={index}>
          <span>{dueLabel(installment)}</span>
          <strong>{amount(installment.amountMinor, currency)}</strong>
        </li>
      ))}
    </ol>
  );
}
export default function DemoPaymentSolutions({ offers = [], agreement, platform, onCase }) {
  if (!offers.length && !agreement) return null;
  return (
    <section className="demo-payment-solutions" aria-label="Demo payment options">
      <div className="demo-payment-heading">
        <h3>{offers.length ? 'Explore a payment solution' : 'Accepted demo solution'}</h3>
        <span>DEMO ONLY</span>
      </div>
      {offers.length > 0 && (
        <p>
          Ask the assistant about these fictional options. To try an agreement, explicitly accept an
          option during the conversation. This records simulated consent only; no money is collected
          and no real debt is changed. Accepted solutions create a saved demo case and a payment
          follow-up draft.
        </p>
      )}
      <div className="demo-payment-offers">
        {offers.map((offer) => (
          <article key={offer.offerId || offer.id} className="demo-payment-offer">
            <h4>{offer.label}</h4>
            <strong>{amount(offer.totalMinor, offer.currency)}</strong>
            <small>
              {offer.installments?.length === 1
                ? 'One payment'
                : `${offer.installments?.length || 0} installments`}
            </small>
            <details>
              <summary>View payment schedule</summary>
              <Schedule installments={offer.installments} currency={offer.currency} />
            </details>
          </article>
        ))}
      </div>
      {offers.length > 0 && (
        <p className="muted small-text">
          Try: “What discount is available?”, “Could I split this into three or six payments?”, then
          “I accept that option” if you want to confirm it for this test.
        </p>
      )}
      {agreement && (
        <section
          className="demo-payment-agreement"
          aria-label="Simulated payment agreement"
          role="status"
        >
          <h3>Simulated agreement confirmed</h3>
          <p>
            <strong>{agreement.label}</strong> · Total{' '}
            {amount(agreement.totalMinor, agreement.currency)}
          </p>
          <Schedule installments={agreement.installments} currency={agreement.currency} />
          <small>Demo agreement {agreement.id}. No payment has been taken.</small>
          {platform?.caseId && (
            <div className="demo-payment-platform">
              <p>
                <strong>Saved to platform</strong> · {platform.reference || 'Demo case'}
                <br />
                {platform.agentWorkflow && (
                  <span className="block">
                    After ending the call, open Conversations in the saved case for the automatic
                    virtual SMS follow-up.
                  </span>
                )}
                Payment follow-up: {(platform.jobStatus || 'draft').replaceAll('_', ' ')}. No
                message has been sent.
              </p>
              {onCase && (
                <button className="secondary" onClick={() => onCase(platform.caseId)}>
                  Open saved case
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
